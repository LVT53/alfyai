// Connections redesign — the composer's plug, per account.
//
// The plug was one switch: all connections or none. Leaving a single account
// out of one conversation meant disconnecting it entirely, which also
// affected every other conversation. It now opens the same list of accounts
// the settings tab shows, and this module owns the arithmetic: which
// capabilities a given selection sends, and how a selection is remembered.
//
// The per-conversation choice sits ON TOP of each account's own "Use it
// without asking" setting rather than replacing it — see isAccountOn.
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

/**
 * Whether one account is switched on for this conversation.
 *
 * The account's OWN setting decides the starting point: "Use it without
 * asking" (conn.defaultOn) is what the settings dialog promises — "Off, it
 * only uses {provider} when you turn connections on for that message". So the
 * stored per-conversation set holds the accounts the user FLIPPED away from
 * that starting point, not a flat list of accounts that are off. Reading it
 * as "off" would have quietly retired the setting: every account, including
 * the ones deliberately marked "ask me first", would have reached the model
 * on every message.
 *
 * Storing flips (rather than the resulting on-set) also keeps the property
 * the old all-or-nothing key had: an account connected after the choice was
 * made takes its own default instead of being silently missing from every
 * conversation that predates it.
 */
export function isAccountOn(
	conn: ActiveCapabilitiesConnection,
	flippedIds: ReadonlySet<string>,
): boolean {
	return flippedIds.has(conn.id) ? !conn.defaultOn : conn.defaultOn;
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
 * The capabilities to send for a given per-account selection — the accounts
 * that are on (see isAccountOn) and can actually serve something.
 */
export function capabilitiesForSelection(
	connections: ActiveCapabilitiesConnection[],
	flippedIds: ReadonlySet<string>,
): string[] {
	const enabled = new Set<string>();
	for (const conn of connections) {
		if (!isAccountOn(conn, flippedIds)) continue;
		if (!isReady(conn)) continue;
		for (const capability of conn.capabilities) enabled.add(capability);
	}
	return [...enabled];
}

/** How many ready accounts the selection currently has switched on. */
export function readyCount(
	connections: ActiveCapabilitiesConnection[],
	flippedIds: ReadonlySet<string>,
): { on: number; total: number } {
	const ready = connections.filter(isReady);
	return {
		on: ready.filter((conn) => isAccountOn(conn, flippedIds)).length,
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
	flippedIds: ReadonlySet<string>,
): boolean {
	return readyCount(connections, flippedIds).on > 0;
}

/**
 * Flipping the master switch on turns every account on; off silences all.
 * Expressed as flips, so "on" means flipping exactly the accounts whose own
 * setting is off, and "off" means flipping exactly the ones whose own setting
 * is on.
 */
export function toggleMaster(
	connections: ActiveCapabilitiesConnection[],
	flippedIds: ReadonlySet<string>,
): Set<string> {
	const wantOn = !masterIsOn(connections, flippedIds);
	return new Set(
		connections
			.filter((conn) => conn.defaultOn !== wantOn)
			.map((conn) => conn.id),
	);
}

export function toggleAccount(
	flippedIds: ReadonlySet<string>,
	id: string,
): Set<string> {
	const next = new Set(flippedIds);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

// ── Per-conversation memory ──────────────────────────────────────
//
// Keyed by conversation so a choice survives model switches, the draft ->
// real conversation transition, the post-send navigation remount and reloads
// — the same posture as the old all-or-nothing key it replaces. What is
// stored is the FLIP set (see isAccountOn): an empty entry means "every
// account as its own setting says", which is why it is stored as absence.
const FLIPPED_KEY_PREFIX = "alfyai:composer:connectionsOff:";

export function readDisabledIds(conversationId: string): Set<string> {
	try {
		const raw = localStorage.getItem(FLIPPED_KEY_PREFIX + conversationId);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
	} catch {
		// Storage unavailable or corrupt: fall back to "nothing flipped",
		// which is the same default a brand-new conversation gets.
		return new Set();
	}
}

export function persistDisabledIds(
	conversationId: string,
	flippedIds: ReadonlySet<string>,
): void {
	try {
		if (flippedIds.size === 0) {
			localStorage.removeItem(FLIPPED_KEY_PREFIX + conversationId);
			return;
		}
		localStorage.setItem(
			FLIPPED_KEY_PREFIX + conversationId,
			JSON.stringify([...flippedIds]),
		);
	} catch {
		/* in-memory only for this session */
	}
}
