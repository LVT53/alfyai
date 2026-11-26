// The keeper owns the macOS lock and acknowledges every worker before it runs.
// If the gate disappears, retain the lock until its registered groups are stopped.
import { spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";

const fd = openSync(process.argv[2], "a+");
const lock = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
	stdio: ["ignore", "ignore", "ignore", fd],
});
if (lock.status !== 0) process.exit(lock.status ?? 71);

const groups = new Set();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
console.log("held");
for await (const line of input) {
	const match = line.match(/^([+-])(\d+)$/);
	if (!match) continue;
	const pid = Number(match[2]);
	if (pid < 2 || !Number.isSafeInteger(pid)) continue;
	if (match[1] === "+") {
		groups.add(pid);
		console.log(`registered ${pid}`);
	} else if (!signal(pid, 0)) {
		groups.delete(pid);
	}
}

function signal(pid, kind) {
	try {
		process.kill(-pid, kind);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

let remaining = [...groups].filter((pid) => signal(pid, "SIGINT"));
const deadline = performance.now() + 8000;
while (remaining.length && performance.now() < deadline) {
	await setTimeout(100);
	remaining = remaining.filter((pid) => signal(pid, 0));
}
for (const pid of remaining) signal(pid, "SIGKILL");

const hardDeadline = performance.now() + 1500;
while (remaining.length && performance.now() < hardDeadline) {
	await setTimeout(25);
	remaining = remaining.filter((pid) => signal(pid, 0));
}
if (remaining.length) process.exitCode = 1;
