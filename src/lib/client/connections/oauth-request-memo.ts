// Connections redesign — remembers what an OAuth connect actually ASKED for
// across the round trip to the provider's consent screen.
//
// A partial grant is invisible today: the user ticks Calendar and Contacts,
// Google hands back Calendar only, and the connection quietly ends up with
// one capability and says nothing about the other. The callback can't tell us
// either — it only knows the granted scope, never the requested list, because
// the browser left the SPA in between.
//
// So the wizard writes the requested list down before redirecting, and the
// tab reads it back on return and compares it with what the connection was
// granted. sessionStorage (not localStorage) because the memo is only
// meaningful for this tab's trip to the provider and back: a note left behind
// by an abandoned attempt must not resurface days later.
const KEY_PREFIX = "alfyai:connections:requested:";

function storage(): Storage | null {
	try {
		if (typeof sessionStorage === "undefined") return null;
		return sessionStorage;
	} catch {
		// Private mode / storage blocked. Losing the memo only costs the
		// partial-grant notice, never the connection itself.
		return null;
	}
}

export function rememberRequestedCapabilities(
	provider: string,
	capabilities: string[],
): void {
	const store = storage();
	if (!store) return;
	try {
		store.setItem(KEY_PREFIX + provider, JSON.stringify(capabilities));
	} catch {
		/* quota or blocked — see storage() */
	}
}

/**
 * Reads and CLEARS the memo. Consuming it is the point: the partial-grant
 * notice is about the connect that just happened, so a second visit to the
 * tab must not show it again.
 */
export function takeRequestedCapabilities(provider: string): string[] | null {
	const store = storage();
	if (!store) return null;
	const key = KEY_PREFIX + provider;
	let raw: string | null = null;
	try {
		raw = store.getItem(key);
		store.removeItem(key);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(String) : null;
	} catch {
		return null;
	}
}

/**
 * The capabilities that were asked for but not granted — the ones the notice
 * names. Empty when the grant was complete (or when there was no memo), which
 * is what the caller checks before showing anything at all.
 */
export function missingFromGrant(
	requested: string[] | null,
	granted: string[],
): string[] {
	if (!requested) return [];
	const grantedSet = new Set(granted);
	return requested.filter((capability) => !grantedSet.has(capability));
}
