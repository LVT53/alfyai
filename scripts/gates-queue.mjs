import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const keeper = join(
	dirname(fileURLToPath(import.meta.url)),
	"gates-queue-keeper.mjs",
);

export function gateStateDir(root, env = process.env) {
	if (env.ALFYAI_GATE_STATE_DIR && isAbsolute(env.ALFYAI_GATE_STATE_DIR))
		return env.ALFYAI_GATE_STATE_DIR;
	const git = spawnSync("git", ["rev-parse", "--git-common-dir"], {
		cwd: root,
		encoding: "utf8",
	});
	return git.status === 0 && git.stdout.trim()
		? resolve(root, git.stdout.trim(), "alfyai-gates")
		: null;
}

export function takesTheQueue({ skip }) {
	return ["check", "vitest", "build", "playwright"].some(
		(step) => !skip.has(step),
	);
}

// The OS owns the lock, and releases it when this pipe closes, even after SIGKILL.
// Keep the inode across runs so competing waiters always lock the same file.
function tryLock(path, handshakeMs, browserToken) {
	return new Promise((resolveLock) => {
		const child = spawn(process.execPath, [keeper, path, browserToken], {
			detached: true,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let complete;
		let releasing = false;
		let ready = false;
		const registrations = new Map();
		const done = new Promise((resolveDone) => {
			complete = resolveDone;
		});
		const timer = globalThis.setTimeout(() => {
			child.kill("SIGKILL");
			resolveLock({ error: "lock helper did not respond" });
		}, handshakeMs);
		timer.unref();
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolveLock({ error: error.code ?? error.message });
			complete(error.message);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			const error = `lock helper exited (${signal ?? code})`;
			complete(releasing && code === 0 ? null : error);
			for (const finish of registrations.values()) finish(new Error(error));
			resolveLock(code === 75 ? {} : { error });
		});
		const replies = createInterface({
			input: child.stdout,
			crlfDelay: Infinity,
		});
		replies.on("line", (line) => {
			if (line.startsWith("registered ")) {
				registrations.get(Number(line.slice(11)))?.(null);
				return;
			}
			if (line !== "held" || ready) return;
			ready = true;
			clearTimeout(timer);
			resolveLock({
				lost: done,
				register(pid, callback) {
					const finish = (error) => {
						clearTimeout(deadline);
						registrations.delete(pid);
						callback(error);
					};
					const deadline = globalThis.setTimeout(
						() => finish(new Error("lock helper did not register the worker")),
						2000,
					);
					registrations.set(pid, finish);
					child.stdin.write(`+${pid}\n`, (error) => {
						if (error) registrations.get(pid)?.(error);
					});
				},
				unregister(pid) {
					if (!releasing && !child.stdin.destroyed)
						child.stdin.write(`-${pid}\n`);
				},
				async release(stopWorkers = async () => {}) {
					if (!releasing) {
						releasing = true;
						child.stdin.end();
					}
					const timeout = Symbol("release timeout");
					const result = await Promise.race([
						done,
						setTimeout(12_000, timeout, { ref: false }),
					]);
					if (result !== timeout) return result;
					await stopWorkers();
					if (!browserToken) {
						child.kill("SIGKILL");
						return "lock helper did not finish cleanup";
					}
					// The detached keeper still owns the lock while cleanup is pending.
					child.stdout.destroy();
					child.unref();
					return "lock helper is still waiting for cleanup";
				},
			});
		});
	});
}

function readHolder(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export async function acquireGateLock({
	dir,
	holder,
	browserToken = "",
	sleep = setTimeout,
	now = () => performance.now(),
	log = console.log,
	pollMs = 5000,
	maxWaitMs = 45 * 60_000,
}) {
	const start = now();
	const fallback = (reason) => {
		log(`queue: could not take the lock (${reason}); running anyway`);
		return { held: false, waitedMs: now() - start, reason };
	};
	if (!dir) return fallback("shared git directory is unavailable");
	try {
		mkdirSync(dir, { recursive: true });
	} catch (error) {
		return fallback(error.code ?? error.message);
	}

	const ownerPath = join(dir, "holder.json");
	let nextNotice = start;
	while (true) {
		const lock = await tryLock(
			join(dir, "gate.lock"),
			Math.min(2000, Math.max(1, maxWaitMs - (now() - start))),
			browserToken,
		);
		if (lock.release) {
			try {
				const temp = join(dir, `holder-${process.pid}.tmp`);
				writeFileSync(temp, JSON.stringify({ ...holder, since: Date.now() }));
				renameSync(temp, ownerPath);
			} catch (error) {
				log(
					`queue: could not record the holder (${error.code ?? error.message})`,
				);
			}
			return {
				held: true,
				waitedMs: now() - start,
				...lock,
			};
		}
		if (lock.error) return fallback(lock.error);
		const owner = readHolder(ownerPath);
		const elapsed = now() - start;
		if (elapsed >= maxWaitMs) {
			return fallback(
				`waited ${Math.round(maxWaitMs / 60000)}m for process ${owner?.pid ?? "unknown"}`,
			);
		}
		if (now() >= nextNotice) {
			const dir = String(owner?.worktree ?? "another worktree");
			const location = dir.startsWith(`${homedir()}/`)
				? `~${dir.slice(homedir().length)}`
				: dir;
			const running = Math.max(
				0,
				Math.floor((Date.now() - (owner?.since ?? Date.now())) / 1000),
			);
			log(
				`queue: waiting for the ${owner?.mode ?? "other"} gate in ${location} (process ${owner?.pid ?? "unknown"}), running ${Math.floor(running / 60)}m${String(running % 60).padStart(2, "0")}s`,
			);
			nextNotice = now() + 60_000;
		}
		await sleep(Math.min(pollMs, maxWaitMs - elapsed));
		if (now() - start >= maxWaitMs) {
			return fallback(
				`waited ${Math.round(maxWaitMs / 60000)}m for process ${owner?.pid ?? "unknown"}`,
			);
		}
	}
}
