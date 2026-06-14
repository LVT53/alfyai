import path from "node:path";
import { PassThrough } from "node:stream";
import type { Container, Exec, ExecInspectInfo } from "dockerode";
import Docker from "dockerode";

export const SANDBOX_TIMEOUT_MS = 90000;
export const SANDBOX_TIMEOUT_JS_MS = 135000;
export const SANDBOX_MEMORY_MB = 2048;
export const SANDBOX_MAX_FILE_MB = 100;
export const SANDBOX_MAX_OUTPUT_FILES = 20;
export const SANDBOX_MAX_TOTAL_OUTPUT_MB = 50;

const SANDBOX_EXEC_POLL_MS = 25;

export type SandboxLanguage = "python" | "javascript";

export function getSandboxTimeout(language: SandboxLanguage): number {
	return language === "javascript" ? SANDBOX_TIMEOUT_JS_MS : SANDBOX_TIMEOUT_MS;
}

interface SandboxRuntimeConfig {
	image: string;
	idleCommand: string[];
	execCommand: (code: string) => string[];
	workingDir?: string;
	binds?: string[];
}

const JAVASCRIPT_NODE_MODULES_DIR = path.join(process.cwd(), "node_modules");
const PYTHON_VENV_SITE_PACKAGES = path.join(
	process.cwd(),
	"sandbox-python-env",
	"lib",
	"python3.11",
	"site-packages",
);

const SANDBOX_RUNTIME_CONFIG: Record<SandboxLanguage, SandboxRuntimeConfig> = {
	python: {
		image: "python:3.11-slim",
		idleCommand: ["python3", "-c", "import sys; sys.stdin.read()"],
		execCommand: (code: string) => ["python3", "-c", code],
		binds: [`${PYTHON_VENV_SITE_PACKAGES}:/workspace/python-packages:ro`],
	},
	javascript: {
		image: "node:22-bookworm-slim",
		idleCommand: ["node", "-e", "process.stdin.resume()"],
		execCommand: (code: string) => ["node", "-e", code],
		workingDir: "/workspace",
		binds: [`${JAVASCRIPT_NODE_MODULES_DIR}:/workspace/node_modules:ro`],
	},
};

interface SandboxRuntimeState {
	ready: boolean;
	pullPromise: Promise<void> | null;
	warmupStarted: boolean;
}

const sandboxRuntimeState: Record<SandboxLanguage, SandboxRuntimeState> = {
	python: {
		ready: false,
		pullPromise: null,
		warmupStarted: false,
	},
	javascript: {
		ready: false,
		pullPromise: null,
		warmupStarted: false,
	},
};

export interface Sandbox {
	container: Container;
	execute: (code: string) => Promise<SandboxResult>;
	destroy: () => Promise<void>;
}

export interface SandboxResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

const docker = new Docker();

function isDockerodeStatusError(
	error: unknown,
): error is { statusCode?: number; json?: { message?: string } } {
	return typeof error === "object" && error !== null;
}

function getSandboxRuntime(language: SandboxLanguage): SandboxRuntimeConfig {
	return SANDBOX_RUNTIME_CONFIG[language];
}

function getSandboxState(language: SandboxLanguage): SandboxRuntimeState {
	return sandboxRuntimeState[language];
}

async function hasSandboxImage(language: SandboxLanguage): Promise<boolean> {
	const runtime = getSandboxRuntime(language);

	try {
		await docker.getImage(runtime.image).inspect();
		return true;
	} catch (error) {
		if (isDockerodeStatusError(error) && error.statusCode === 404) {
			return false;
		}
		throw error;
	}
}

async function pullSandboxImage(language: SandboxLanguage): Promise<void> {
	const runtime = getSandboxRuntime(language);

	console.info(
		"[FILE_PRODUCTION] Sandbox image missing locally; pulling base image",
		{
			runtime: language,
			image: runtime.image,
		},
	);
	const stream = await docker.pull(runtime.image);

	await new Promise<void>((resolve, reject) => {
		const modem = docker.modem as {
			followProgress: (
				stream: NodeJS.ReadableStream,
				onFinished: (error: Error | null, output: unknown) => void,
			) => void;
		};

		modem.followProgress(stream, (error) => {
			if (error) {
				reject(error);
				return;
			}
			console.info("[FILE_PRODUCTION] Sandbox image pull completed", {
				runtime: language,
				image: runtime.image,
			});
			resolve();
		});
	});
}

async function ensureSandboxImage(language: SandboxLanguage): Promise<void> {
	const state = getSandboxState(language);
	if (state.ready) return;
	if (state.pullPromise) {
		await state.pullPromise;
		return;
	}

	state.pullPromise = (async () => {
		if (await hasSandboxImage(language)) {
			state.ready = true;
			return;
		}

		await pullSandboxImage(language);
		state.ready = true;
	})().finally(() => {
		state.pullPromise = null;
	});

	await state.pullPromise;
}

export function resetSandboxImageStateForTests(): void {
	for (const state of Object.values(sandboxRuntimeState)) {
		state.ready = false;
		state.pullPromise = null;
		state.warmupStarted = false;
	}
}

export function prewarmSandboxImageInBackground(): void {
	for (const language of Object.keys(
		SANDBOX_RUNTIME_CONFIG,
	) as SandboxLanguage[]) {
		const runtime = getSandboxRuntime(language);
		const state = getSandboxState(language);
		if (state.ready || state.pullPromise || state.warmupStarted) {
			continue;
		}

		state.warmupStarted = true;
		console.info("[FILE_PRODUCTION] Scheduling sandbox image warmup", {
			runtime: language,
			image: runtime.image,
		});

		void ensureSandboxImage(language)
			.then(() => {
				console.info("[FILE_PRODUCTION] Sandbox image warmup ready", {
					runtime: language,
					image: runtime.image,
				});
			})
			.catch((error) => {
				state.warmupStarted = false;
				console.warn("[FILE_PRODUCTION] Sandbox image warmup failed", {
					runtime: language,
					image: runtime.image,
					error,
				});
			});
	}
}

async function waitForExecToFinish(exec: Exec): Promise<ExecInspectInfo> {
	while (true) {
		const inspect = await exec.inspect();
		if (inspect.Running === false && inspect.ExitCode !== null) {
			return inspect;
		}

		await new Promise((resolve) => setTimeout(resolve, SANDBOX_EXEC_POLL_MS));
	}
}

function waitForExecStream(stream: NodeJS.ReadableStream): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) {
				reject(error);
				return;
			}
			resolve();
		};

		stream.once("end", () => finish());
		stream.once("close", () => finish());
		stream.once("error", (error: Error) => finish(error));
	});
}

export async function executeSandboxCommand(
	container: Container,
	cmd: string[],
): Promise<SandboxResult> {
	const exec = await container.exec({
		Cmd: cmd,
		AttachStdout: true,
		AttachStderr: true,
	});

	const stream = await exec.start({
		hijack: false,
		stdin: false,
	});

	let stdout = "";
	let stderr = "";
	const stdoutStream = new PassThrough();
	const stderrStream = new PassThrough();
	stdoutStream.on("data", (chunk: Buffer | string) => {
		stdout += chunk.toString("utf-8");
	});
	stderrStream.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString("utf-8");
	});

	const modem = (container.modem ?? docker.modem) as {
		demuxStream: (
			stream: NodeJS.ReadableStream,
			stdout: NodeJS.WritableStream,
			stderr: NodeJS.WritableStream,
		) => void;
	};
	modem.demuxStream(stream, stdoutStream, stderrStream);

	try {
		const [inspect] = await Promise.all([
			waitForExecToFinish(exec),
			waitForExecStream(stream),
		]);
		return {
			stdout: stdout.trim(),
			stderr: stderr.trim(),
			exitCode: inspect.ExitCode ?? -1,
		};
	} finally {
		stdoutStream.end();
		stderrStream.end();
	}
}

export async function createSandbox(
	language: SandboxLanguage = "python",
): Promise<Sandbox> {
	const runtime = getSandboxRuntime(language);
	await ensureSandboxImage(language);

	const memoryBytes = SANDBOX_MEMORY_MB * 1024 * 1024;

	const container = await docker.createContainer({
		Image: runtime.image,
		Cmd: runtime.idleCommand,
		Tty: false,
		OpenStdin: true,
		StdinOnce: false,
		StopTimeout: getSandboxTimeout(language) / 1000,
		WorkingDir: runtime.workingDir,
		Env:
			language === "python"
				? ["PYTHONPATH=/workspace/python-packages"]
				: undefined,
		// SECURITY: Run as non-root user (UID 1000, GID 1000)
		User: "1000:1000",
		HostConfig: {
			Memory: memoryBytes,
			MemorySwap: memoryBytes,
			CpuQuota: 100000,
			NetworkMode: "none",
			AutoRemove: true,
			ReadonlyRootfs: true,
			SecurityOpt: ["no-new-privileges:true"],
			// SECURITY: Drop all Linux capabilities
			CapDrop: ["ALL"],
			// SECURITY: Ensure container is not privileged
			Privileged: false,
			// SECURITY: Limit number of processes (fork bomb protection)
			PidsLimit: 100,
			Binds: runtime.binds,
			// SECURITY: Writable tmpfs for output and temp (since rootfs is readonly and we run as non-root)
			Tmpfs: {
				"/output": "rw,size=100m,mode=1777",
				"/tmp":
					language === "javascript"
						? "rw,size=200m,mode=1777"
						: "rw,size=50m,mode=1777",
				"/workspace": "rw,size=50m,mode=1777",
			},
		},
		Labels: {
			"alfyai.sandbox": "true",
			"alfyai.sandbox.version": "1",
		},
	});

	await container.start();

	async function execute(code: string): Promise<SandboxResult> {
		return executeSandboxCommand(container, runtime.execCommand(code));
	}

	async function destroy(): Promise<void> {
		await destroySandbox(container);
	}

	return {
		container,
		execute,
		destroy,
	};
}

export async function destroySandbox(container: Container): Promise<void> {
	try {
		await container.kill({ signal: "SIGKILL" });
	} catch {
		// Container may already be stopped
	}

	try {
		await container.remove({ force: true });
	} catch {
		// Container may already be removed
	}
}
