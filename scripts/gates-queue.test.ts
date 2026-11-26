// @vitest-environment node
// @always-run: exercises the separately launched queue keeper and worker cleanup.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import * as queue from "./gates-queue.mjs";

const dirs: string[] = [];
const makeDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "alfyai-queue-test-"));
	dirs.push(dir);
	return dir;
};
const holder = {
	pid: process.pid,
	mode: "release",
	worktree: "/test",
	head: "abc",
	since: Date.now() - 600_000,
};

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin")(
	"waits for the live holder and acquires after release",
	async () => {
		const dir = makeDir();
		const first = await queue.acquireGateLock({ dir, holder });
		expect(first.held).toBe(true);
		try {
			const metadata = JSON.parse(
				readFileSync(join(dir, "holder.json"), "utf8"),
			);
			expect(metadata.since).toBeGreaterThan(holder.since);
			const log: string[] = [];
			const second = await queue.acquireGateLock({
				dir,
				holder,
				log: (line: string) => log.push(line),
				sleep: () => first.release(),
			});
			expect(second.held).toBe(true);
			await second.release();
			expect(log.join("\n")).toContain("waiting for the release gate");
		} finally {
			await first.release();
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"a stale metadata file cannot hold the queue",
	async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "holder.json"), "{");
		const lock = await queue.acquireGateLock({ dir, holder });
		expect(lock.held).toBe(true);
		await lock.release();
	},
);

test("falls back when the state directory cannot be created", async () => {
	const file = join(makeDir(), "file");
	writeFileSync(file, "");
	const lock = await queue.acquireGateLock({
		dir: join(file, "state"),
		holder,
		log: () => {},
	});
	expect(lock.held).toBe(false);
	expect(lock.reason).toContain("ENOTDIR");
});

test("quick checks can run without the queue", () => {
	expect(
		queue.takesTheQueue({
			skip: new Set(["check", "vitest", "build", "playwright"]),
		}),
	).toBe(false);
	expect(
		queue.takesTheQueue({ skip: new Set(["check", "vitest", "build"]) }),
	).toBe(true);
});

test.skipIf(process.platform !== "darwin")(
	"a crashed runner keeps the queue until its registered worker stops",
	async () => {
		const dir = makeDir();
		const queueModule = pathToFileURL(
			join(import.meta.dirname, "gates-queue.mjs"),
		).href;
		const owner = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
		import { spawn } from "node:child_process";
		import { acquireGateLock } from ${JSON.stringify(queueModule)};
		const lock = await acquireGateLock({
			dir: process.argv[1], holder: { pid: process.pid, since: Date.now(), mode: "release" },
			log: console.error,
		});
		if (!lock.held) process.exit(3);
		const worker = spawn("/bin/sleep", ["90"], { detached: true, stdio: "ignore" });
		lock.register(worker.pid, (error) => {
			if (error) process.exit(4);
			console.log(worker.pid);
		});
	`,
				dir,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const terminal = once(owner, "exit");
		let worker: number | undefined;
		try {
			worker = await Promise.race([
				once(owner.stdout, "data").then(([data]) =>
					Number(String(data).trim()),
				),
				terminal.then(() => {
					throw new Error("lock owner exited before registering its worker");
				}),
			]);
			expect(worker).toBeGreaterThan(1);
			owner.kill("SIGKILL");
			await terminal;
			const next = await queue.acquireGateLock({
				dir,
				holder,
				pollMs: 25,
				maxWaitMs: 1800,
				log: () => {},
			});
			try {
				expect(next.held).toBe(true);
				expect(() => process.kill(-Number(worker), 0)).toThrow(/ESRCH/);
			} finally {
				await next.release?.();
			}
		} finally {
			owner.kill("SIGKILL");
			if (worker && worker > 1) {
				try {
					process.kill(-worker, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH")
						console.error(error);
				}
			}
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"holds the lock for its detached browser while ignoring other runs",
	async () => {
		const dir = makeDir();
		const token = "queue-browser-fixture";
		const startBrowser = (marker: string) =>
			spawn(
				process.execPath,
				[
					"-e",
					"setInterval(() => {}, 1000)",
					"--",
					`--alfyai-gate-run=${marker}`,
				],
				{ detached: true, stdio: "ignore" },
			);
		const browser = startBrowser(token);
		const other = startBrowser(`${token}-other`);
		const browserExit = once(browser, "exit");
		const otherExit = once(other, "exit");
		const acquire = () =>
			queue.acquireGateLock({
				dir,
				holder,
				pollMs: 25,
				maxWaitMs: 350,
				log: () => {},
			});
		const first = await queue.acquireGateLock({
			dir,
			holder,
			browserToken: token,
		});
		let release: Promise<string | null> | undefined;
		try {
			expect(first.held).toBe(true);
			release = first.release();
			const waiting = await acquire();
			try {
				expect(waiting.held).toBe(false);
			} finally {
				await waiting.release?.();
			}
			browser.kill();
			await browserExit;
			expect(await release).toBeNull();

			const next = await acquire();
			try {
				expect(next.held).toBe(true);
				expect(other.exitCode).toBeNull();
			} finally {
				await next.release?.();
			}
		} finally {
			browser.kill();
			other.kill();
			await Promise.all([browserExit, otherExit, release ?? first.release?.()]);
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"contention falls back after the wait limit",
	async () => {
		const dir = makeDir();
		const first = await queue.acquireGateLock({ dir, holder });
		try {
			let now = 0;
			const next = await queue.acquireGateLock({
				dir,
				holder,
				now: () => now,
				sleep: async (ms: number) => {
					now += ms;
				},
				maxWaitMs: 45 * 60_000,
				pollMs: 60_000,
				log: () => {},
			});
			expect(next).toMatchObject({
				held: false,
				waitedMs: 45 * 60_000,
				reason: `waited 45m for process ${process.pid}`,
			});
		} finally {
			await first.release();
		}
	},
);
