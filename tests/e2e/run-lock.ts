// One e2e run per worktree at a time.
//
// A run makes its databases from scratch (`data/playwright-e2e-chat*.db`) and
// serves the one `build/`. Two runs in the same worktree, even on different
// ports, would delete each other's files under them and fail in ways that look
// like flaky specs. So a run takes this lock first, and a second one is told who
// holds it. A lock whose process is gone (a runner that was killed) is taken over.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type RunLock = { pid: number; ports: number[]; since: string };

export const RUN_LOCK_PATH = join("data", "e2e-run.lock");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists and is somebody else's, which is alive enough.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readRunLock(root: string = process.cwd()): RunLock | null {
	const path = join(root, RUN_LOCK_PATH);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RunLock;
	} catch {
		return null;
	}
}

/**
 * Takes the lock for `ports`, or throws saying which run holds it. Returns a
 * release function (also safe to call twice).
 */
export function acquireRunLock(
	ports: number[],
	root: string = process.cwd(),
	pid: number = process.pid,
): () => void {
	const held = readRunLock(root);
	if (held && held.pid !== pid && alive(held.pid)) {
		throw new Error(
			[
				`[e2e] Another e2e run in this worktree is in progress (process ${held.pid}, ports ${held.ports.join(", ")}, since ${held.since}).`,
				"      Runs share data/playwright-e2e-chat*.db and build/, so they cannot overlap: wait for it,",
				"      or run from another worktree. (If that process is not an e2e run, delete data/e2e-run.lock.)",
			].join("\n"),
		);
	}
	const path = join(root, RUN_LOCK_PATH);
	mkdirSync(dirname(path), { recursive: true });
	const lock: RunLock = { pid, ports, since: new Date().toISOString() };
	writeFileSync(path, JSON.stringify(lock));
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (readRunLock(root)?.pid === pid) rmSync(path, { force: true });
	};
}
