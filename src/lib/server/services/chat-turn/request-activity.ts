import { randomUUID } from "node:crypto";
import { eq, gt, lte } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db, sqlite } from "$lib/server/db";
import { memoryForegroundLeases } from "$lib/server/db/schema";

const ACTIVITY_WRITE_TIMEOUT_MS = 5;
let unhealthyUntil = 0;
let nextPruneAt = 0;

// The singleton's normal timeout protects durable application writes. All
// activity operations here are synchronous, so no other request uses this
// connection before the existing timeout is restored.
function writeActivity(write: () => void) {
	const previous = sqlite.pragma("busy_timeout", { simple: true });
	try {
		sqlite.pragma(`busy_timeout = ${ACTIVITY_WRITE_TIMEOUT_MS}`);
		write();
	} finally {
		sqlite.pragma(`busy_timeout = ${previous}`);
	}
}

function unavailable(lifetime: number) {
	unhealthyUntil = Date.now() + lifetime;
	console.warn(
		"[MEMORY] Foreground activity tracking unavailable; using conservative admission",
	);
}

/** A shared, content-free lease covers both plain and streaming model lifetimes. */
export function beginForegroundRequest(): () => void {
	const config = getConfig();
	if (!config.hindsightAdmissionKey) return () => {};
	const id = randomUUID();
	// A crashed app's upstream request may still be running. Keep the lease for
	// the entire model budget, not just one missed heartbeat.
	const lifetime = Math.max(300_000, config.requestTimeoutMs + 30_000);
	const touch = () =>
		writeActivity(() => {
			const expiresAt = Date.now() + lifetime;
			db.insert(memoryForegroundLeases)
				.values({ id, expiresAt })
				.onConflictDoUpdate({
					target: memoryForegroundLeases.id,
					set: { expiresAt },
				})
				.run();
		});
	try {
		touch();
	} catch {
		unavailable(lifetime);
		return () => {};
	}
	const now = Date.now();
	if (now >= nextPruneAt) {
		nextPruneAt = now + 60_000;
		try {
			writeActivity(() => {
				db.delete(memoryForegroundLeases)
					.where(lte(memoryForegroundLeases.expiresAt, now))
					.run();
			});
		} catch {
			/* Expired rows never affect admission. */
		}
	}
	const timer = setInterval(() => {
		try {
			touch();
		} catch {
			unavailable(lifetime);
		}
	}, 15_000);
	timer.unref?.();
	let finished = false;
	return () => {
		if (finished) return;
		finished = true;
		clearInterval(timer);
		try {
			writeActivity(() => {
				db.delete(memoryForegroundLeases)
					.where(eq(memoryForegroundLeases.id, id))
					.run();
			});
		} catch {
			/* Lease expires conservatively. */
		}
	};
}

export function readForegroundActivity(): {
	idle: boolean;
	active: boolean;
	healthy: boolean;
	observedAt: number;
} {
	const observedAt = Date.now();
	const active = Boolean(
		db
			.select({ id: memoryForegroundLeases.id })
			.from(memoryForegroundLeases)
			.where(gt(memoryForegroundLeases.expiresAt, observedAt))
			.limit(1)
			.get(),
	);
	const healthy = observedAt >= unhealthyUntil;
	return {
		idle: getConfig().hindsightOvernightIdle,
		active: active || !healthy,
		healthy,
		observedAt,
	};
}
