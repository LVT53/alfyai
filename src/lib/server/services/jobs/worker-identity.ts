// Who wrote a claim, and is that process still there.
//
// Both job ledgers (document extraction and file production) stamp a worker id
// on every attempt and both used to spell it `<slice>:<pid>:<uuid>`. That is
// enough to make a claim a real CAS, but not enough to answer the question a
// restart asks: "is the process that holds this attempt still running?" A
// deploy leaves attempts whose heartbeat was seconds old at the moment the
// process died, so a heartbeat-only sweep has to wait out the whole stale
// window — two minutes on a box that is serving again after eleven seconds.
//
// Adding the hostname and a per-boot nonce turns it into a question the new
// process can answer at boot. Rows written by the previous format simply do not
// parse, and fall back to the stale-window path they have always had.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** One id per process start; two workers in one process share it. */
const BOOT_NONCE = randomUUID();

/**
 * The hostname, with every `:` removed.
 *
 * The id is colon-separated and a hostname may legally contain none, but an
 * IPv6-ish or container-mangled name that did would shift every later field
 * and make a foreign worker look like ours. Stripping is cheaper than quoting
 * and cannot collide across hosts in any deployment this app has.
 */
function localHostname(): string {
	return (hostname() || "unknown").split(":").join("") || "unknown";
}

/** `<slice>:<hostname>:<pid>:<boot-nonce>`. Stable for the life of a process. */
export function createWorkerId(slice: string): string {
	return `${slice}:${localHostname()}:${process.pid}:${BOOT_NONCE}`;
}

export interface ParsedWorkerId {
	raw: string;
	slice: string;
	hostname: string;
	pid: number;
	nonce: string;
}

/**
 * Reads a worker id back, or null when it is not in the current format.
 *
 * Null is the answer for every row written before this format existed, and it
 * is load-bearing: "I cannot tell whose process this was" must never be read
 * as "it is dead".
 */
export function parseWorkerId(
	id: string | null | undefined,
): ParsedWorkerId | null {
	if (!id) return null;
	const parts = id.split(":");
	if (parts.length !== 4) return null;
	const [slice, host, pidText, nonce] = parts;
	if (!slice || !host || !nonce) return null;
	const pid = Number(pidText);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	return { raw: id, slice, hostname: host, pid, nonce };
}

/**
 * Is there still a process with this pid?
 *
 * `kill(pid, 0)` sends no signal and only performs the permission and
 * existence check. `ESRCH` is the one answer that means "gone"; `EPERM` means
 * a process we are not allowed to signal, which is a process that EXISTS, and
 * reading it as dead would let one worker reclaim another's live attempt. Any
 * other error is treated as alive for the same reason: the conservative
 * direction costs a stale window, the other costs a running parse.
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? (error as { code?: unknown }).code
				: null;
		return code !== "ESRCH";
	}
}
