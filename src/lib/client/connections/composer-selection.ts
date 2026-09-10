// Connections redesign — the composer's plug, per account.
//
// The plug was one switch: all connections or none. Leaving a single account
// out of one conversation meant disconnecting it entirely, which also
// affected every other conversation. It now opens the same list of accounts
// the settings tab shows, and this module owns the arithmetic: which
// capabilities a given selection sends, and how a selection is remembered.
//
// The capability list this produces is what goes on the wire as
// `enabledConnectionCapabilities`, and the server intersects it with what the
// user is actually served (resolveActiveCapabilities) — so nothing here can
// widen access, only narrow it.
import type { ActiveCapabilitiesConnection } from "$lib/client/api/connections";

/** A connection is "ready" when it can actually serve something right now. */
export function isReady(conn: ActiveCapabilitiesConnection): boolean {
	return conn.status === "connected" && conn.capabilities.length > 0;
}

/** The ones the account list flags at the bottom as needing attention. */
export function needsAttention(
	connections: ActiveCapabilitiesConnection[],
): ActiveCapabilitiesConnection[] {
	return connections.filter(
		(conn) => conn.status === "needs_reauth" || conn.status === "error",
	);
}

/**
 * The capabilities to send for a given per-account selection.
 *
 * `disabledIds` is stored rather than the enabled set on purpose: a
 * conversation's remembered choice should be "I left GitHub out", not "I
 * picked these four" — so a connection added later is included by default
 * instead of silently missing from every old conversation.
 */
export function capabilitiesForSelection(
	connections: ActiveCapabilitiesConnection[],
	disabledIds: ReadonlySet<string>,
): string[] {
	const enabled = new Set<string>();
	for (const conn of connections) {
		if (disabledIds.has(conn.id)) continue;
		if (!isReady(conn)) continue;
		for (const capability of conn.capabilities) enabled.add(capability);
	}
	return [...enabled];
}

/** How many ready accounts the selection currently has switched on. */
export function readyCount(
	connections: ActiveCapabilitiesConnection[],
	disabledIds: ReadonlySet<string>,
): { on: number; total: number } {
	const ready = connections.filter(isReady);
	return {
		on: ready.filter((conn) => !disabledIds.has(conn.id)).length,
		total: connections.length,
	};
}

/**
 * The master switch's state. Off means every ready account is off; anything
 * else reads as on, because the plug's job is to say whether this message can
 * reach your accounts at all.
 */
export function masterIsOn(
	connections: ActiveCapabilitiesConnection[],
	disabledIds: ReadonlySet<string>,
): boolean {
	return readyCount(connections, disabledIds).on > 0;
}

/** Flipping the master switch on restores every account; off silences all. */
export function toggleMaster(
	connections: ActiveCapabilitiesConnection[],
	disabledIds: ReadonlySet<string>,
): Set<string> {
	if (masterIsOn(connections, disabledIds)) {
		return new Set(connections.map((conn) => conn.id));
	}
	return new Set();
}

export function toggleAccount(
	disabledIds: ReadonlySet<string>,
	id: string,
): Set<string> {
	const next = new Set(disabledIds);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

// ── Per-conversation memory ──────────────────────────────────────
//
// Keyed by conversation so a choice survives model switches, the draft ->
// real conversation transition, the post-send navigation remount and reloads
// — the same posture as the old all-or-nothing key it replaces.
const DISABLED_KEY_PREFIX = "alfyai:composer:connectionsOff:";

export function readDisabledIds(conversationId: string): Set<string> {
	try {
		const raw = localStorage.getItem(DISABLED_KEY_PREFIX + conversationId);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
	} catch {
		// Storage unavailable or corrupt: fall back to "nothing left out",
		// which is the same default a brand-new conversation gets.
		return new Set();
	}
}

export function persistDisabledIds(
	conversationId: string,
	disabledIds: ReadonlySet<string>,
): void {
	try {
		if (disabledIds.size === 0) {
			localStorage.removeItem(DISABLED_KEY_PREFIX + conversationId);
			return;
		}
		localStorage.setItem(
			DISABLED_KEY_PREFIX + conversationId,
			JSON.stringify([...disabledIds]),
		);
	} catch {
		/* in-memory only for this session */
	}
}
