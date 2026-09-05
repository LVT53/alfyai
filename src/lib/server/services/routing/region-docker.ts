// Docker seam for the routing region manager.
//
// The manager only needs a handful of container operations, expressed here as
// a small interface so tests can drive it with a fake and production uses
// dockerode. dockerode honours `DOCKER_HOST` (e.g. `tcp://127.0.0.1:2375`
// pointing at a filtered docker-socket-proxy), so the app user never needs
// membership in the docker group.

import Docker from "dockerode";

export type RegionContainerSpec = {
	name: string;
	image: string;
	env: string[];
	// "host/path:/container/path[:ro]" bind mounts.
	binds: string[];
	hostIp: string;
	hostPort: number;
	containerPort: number;
	memoryBytes?: number;
	labels?: Record<string, string>;
};

export interface RegionDocker {
	ping(): Promise<void>;
	inspectContainer(
		name: string,
	): Promise<{ exists: boolean; running: boolean }>;
	pullImage(image: string): Promise<void>;
	createContainer(spec: RegionContainerSpec): Promise<void>;
	startContainer(name: string): Promise<void>;
	stopContainer(name: string): Promise<void>;
	removeContainer(name: string): Promise<void>;
	exec(
		name: string,
		cmd: string[],
	): Promise<{ exitCode: number; output: string }>;
}

// Docker multiplexes stdout/stderr with an 8-byte frame header; drop the
// non-printable header bytes so logs stay readable without a full demux.
function stripStreamHeaders(text: string): string {
	let out = "";
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code < 9 || (code > 13 && code < 32)) continue;
		out += char;
	}
	return out;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { statusCode?: number }).statusCode === 404
	);
}

export function createDockerodeRegionDocker(
	docker = new Docker(),
): RegionDocker {
	return {
		async ping() {
			await docker.ping();
		},
		async inspectContainer(name) {
			try {
				const info = await docker.getContainer(name).inspect();
				return { exists: true, running: Boolean(info.State?.Running) };
			} catch (error) {
				if (isNotFound(error)) return { exists: false, running: false };
				throw error;
			}
		},
		async pullImage(image) {
			try {
				await docker.getImage(image).inspect();
				return;
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
			const stream = await docker.pull(image);
			await new Promise<void>((resolve, reject) => {
				docker.modem.followProgress(stream, (error: Error | null) =>
					error ? reject(error) : resolve(),
				);
			});
		},
		async createContainer(spec) {
			await docker.createContainer({
				name: spec.name,
				Image: spec.image,
				Env: spec.env,
				Labels: spec.labels,
				ExposedPorts: { [`${spec.containerPort}/tcp`]: {} },
				HostConfig: {
					Binds: spec.binds,
					RestartPolicy: { Name: "unless-stopped" },
					PortBindings: {
						[`${spec.containerPort}/tcp`]: [
							{ HostIp: spec.hostIp, HostPort: String(spec.hostPort) },
						],
					},
					...(spec.memoryBytes ? { Memory: spec.memoryBytes } : {}),
				},
			});
		},
		async startContainer(name) {
			try {
				await docker.getContainer(name).start();
			} catch (error) {
				// 304 = already started.
				if ((error as { statusCode?: number }).statusCode !== 304) throw error;
			}
		},
		async stopContainer(name) {
			try {
				await docker.getContainer(name).stop({ t: 30 });
			} catch (error) {
				const status = (error as { statusCode?: number }).statusCode;
				if (status !== 304 && status !== 404) throw error;
			}
		},
		async removeContainer(name) {
			try {
				await docker.getContainer(name).remove({ force: true });
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		},
		async exec(name, cmd) {
			const container = docker.getContainer(name);
			const exec = await container.exec({
				Cmd: cmd,
				AttachStdout: true,
				AttachStderr: true,
			});
			const stream = await exec.start({ hijack: true, stdin: false });
			const chunks: Buffer[] = [];
			await new Promise<void>((resolve, reject) => {
				stream.on("data", (chunk: Buffer) => chunks.push(chunk));
				stream.on("end", () => resolve());
				stream.on("error", reject);
			});
			const inspect = await exec.inspect();
			return {
				exitCode: inspect.ExitCode ?? -1,
				// Multiplexed stream frames carry an 8-byte header per frame; keep
				// it readable enough for logs without a full demux.
				output: stripStreamHeaders(
					Buffer.concat(chunks).toString("utf8"),
				).slice(-4000),
			};
		},
	};
}
