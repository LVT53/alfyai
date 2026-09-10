// Connections redesign — "what did the provider actually grant?", as opposed
// to "what is enabled right now?" (conn.capabilities) and "what could this
// provider ever do?" (PROVIDER_META[provider].capabilities).
//
// The settings Connection detail dialog used to iterate the catalogue, so a
// Google account that denied Contacts still rendered a Contacts switch that
// turned on with no permission behind it. The redesign renders a denied
// capability as a greyed line with "Ask again" instead, which needs this
// third list on the DTO.
//
// The three lists relate as: granted ⊆ catalogue, enabled ⊆ catalogue. Note
// that `enabled` is NOT forced to be a subset of `granted` here — the PATCH
// route stays permissive (an enabled-but-not-granted capability is legal and
// simply doesn't resolve at read time), so this module only ever *describes*
// the grant. It never revokes anything.
import type { ConnectionProvider } from "$lib/server/db/schema";
import {
	type Capability,
	OAUTH_CAPABILITY_SCOPES,
	PROVIDER_META,
} from "./registry";

type GrantSource = {
	provider: ConnectionProvider;
	oauthScopes: string[];
	capabilities: string[];
	config: Record<string, unknown>;
};

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

// CalDAV is the one non-OAuth provider whose grant is discovered rather than
// fixed: caldavConnect PROPFINDs the server's home sets and records which of
// task/calendar/addressbook collections it found (providers/caldav-tasks.ts's
// capabilitiesFromConfig does the same mapping at connect time). A server
// with no address books genuinely cannot serve contacts, so offering the user
// a Contacts switch for it is the same lie as Google's denied Contacts.
function caldavGranted(config: Record<string, unknown>): Capability[] {
	const granted: Capability[] = [];
	if (stringArray(config.taskListUrls).length > 0) granted.push("tasks");
	if (stringArray(config.calendarUrls).length > 0) granted.push("calendar");
	if (stringArray(config.addressbookUrls).length > 0) granted.push("contacts");
	return granted;
}

export function grantedCapabilitiesFor(conn: GrantSource): Capability[] {
	const catalogue = PROVIDER_META[conn.provider]?.capabilities ?? [];

	const scopeMap = OAUTH_CAPABILITY_SCOPES[conn.provider];
	if (scopeMap) {
		const granted = new Set(conn.oauthScopes);
		return catalogue.filter((capability) => {
			const required = scopeMap[capability];
			return required !== undefined && granted.has(required);
		});
	}

	if (conn.provider === "caldav") {
		const discovered = caldavGranted(conn.config);
		if (discovered.length > 0) return discovered;
		// An older caldav row predating discovery config tells us nothing about
		// what the server offers, so we claim no denial: the whole catalogue,
		// exactly as for a provider that authenticates as the whole account.
		//
		// Deriving it from the ENABLED list instead would have been a one-way
		// door — a user who switched Contacts off on such a row would find the
		// switch replaced by a greyed "Contacts — not allowed / Look again"
		// line, with no way to switch it back on. "We don't know" must never
		// render as "the provider refused".
		return [...catalogue];
	}

	// Every other provider authenticates as the whole account: connecting it
	// grants everything the provider can do, and the user narrows it with the
	// per-capability switches instead.
	return [...catalogue];
}
