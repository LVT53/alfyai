// Issue 7.1 — client-side provider catalog for the Connections settings
// panel. This is a MANUAL MIRROR of the server-only
// src/lib/server/services/connections/registry.ts (PROVIDER_META). Client
// code must never import from $lib/server, so this data is duplicated
// on purpose rather than shared — the same posture as the ConnectionPublic
// mirror in src/lib/client/api/connections.ts. Keep the two files in sync
// whenever a provider's capabilities/connect method/displayName changes.

export type Capability =
	| "calendar"
	| "files"
	| "photos"
	| "email"
	| "location"
	| "media"
	| "contacts";

export type ConnectMethod =
	| "oauth"
	| "login-flow-v2"
	| "password-key"
	| "app-password";

export type ConnectionProvider =
	| "nextcloud"
	| "immich"
	| "imap"
	| "google"
	| "apple"
	| "plex"
	| "owntracks"
	| "contacts";

export type ProviderCatalogEntry = {
	displayName: string;
	capabilities: Capability[];
	connectMethod: ConnectMethod;
	// Can the user turn "allow writes" on for this provider at all? False
	// for read-only providers (plex/owntracks/contacts) — the panel hides
	// the allow-writes toggle entirely for those.
	writable: boolean;
	// True only for the (currently one) provider whose writes are scoped by
	// filesystem-style root paths (nextcloud) — that gets the
	// write-allowlist chip editor. Other writable providers (calendar/
	// email/immich) confirm every write individually instead, so the panel
	// shows a one-line note rather than an allowlist editor for them.
	pathBasedWrites: boolean;
	// Name of a @lucide/svelte icon component (e.g. "Cloud"). Looked up by
	// the panel via a small local icon map — kept as a string here so this
	// module has no Svelte/component dependency.
	icon: string;
	// True if this provider has its own standalone connect flow and should
	// be offered in the "Add a connection" list. False for resolver-only
	// providers (currently just "contacts") that ride on another
	// connection's capability (Google/Apple/Nextcloud contacts) instead of
	// having a connect route of their own — see
	// ConnectWizardModal.svelte's "unavailable" fallback for the backstop
	// if one of these is ever opened directly.
	connectable: boolean;
};

export const PROVIDER_CATALOG: Record<
	ConnectionProvider,
	ProviderCatalogEntry
> = {
	nextcloud: {
		displayName: "Nextcloud",
		capabilities: ["files", "contacts"],
		connectMethod: "login-flow-v2",
		writable: true,
		pathBasedWrites: true,
		icon: "Cloud",
		connectable: true,
	},
	immich: {
		displayName: "Immich",
		capabilities: ["photos"],
		connectMethod: "password-key",
		writable: true,
		pathBasedWrites: false,
		icon: "Image",
		connectable: true,
	},
	imap: {
		displayName: "Email",
		capabilities: ["email"],
		connectMethod: "app-password",
		writable: true,
		pathBasedWrites: false,
		icon: "Mail",
		connectable: true,
	},
	google: {
		displayName: "Google",
		capabilities: ["calendar", "contacts"],
		connectMethod: "oauth",
		writable: true,
		pathBasedWrites: false,
		icon: "Calendar",
		connectable: true,
	},
	apple: {
		displayName: "Apple iCloud",
		capabilities: ["calendar", "contacts"],
		connectMethod: "app-password",
		writable: true,
		pathBasedWrites: false,
		icon: "Apple",
		connectable: true,
	},
	plex: {
		displayName: "Plex",
		capabilities: ["media"],
		connectMethod: "password-key",
		writable: false,
		pathBasedWrites: false,
		icon: "CirclePlay",
		connectable: true,
	},
	owntracks: {
		displayName: "OwnTracks",
		capabilities: ["location"],
		connectMethod: "password-key",
		writable: false,
		pathBasedWrites: false,
		icon: "MapPin",
		connectable: true,
	},
	contacts: {
		displayName: "Contacts (CardDAV)",
		capabilities: ["contacts"],
		connectMethod: "app-password",
		writable: false,
		pathBasedWrites: false,
		icon: "Contact",
		// Resolver-only: contacts ride on Google/Apple/Nextcloud connections
		// and have no standalone connect route (see registry.ts on the
		// server side). Excluded from the "Add a connection" list.
		connectable: false,
	},
};

export const PROVIDER_LIST: ConnectionProvider[] = Object.keys(
	PROVIDER_CATALOG,
) as ConnectionProvider[];

// Providers to offer in the "Add a connection" list (SettingsConnectionsTab).
// Excludes resolver-only providers like "contacts" — see the `connectable`
// flag above.
export const CONNECTABLE_PROVIDER_LIST: ConnectionProvider[] =
	PROVIDER_LIST.filter((provider) => PROVIDER_CATALOG[provider].connectable);

export function isKnownProvider(
	provider: string,
): provider is ConnectionProvider {
	return provider in PROVIDER_CATALOG;
}

// Falls back to a minimal, still-usable entry for a provider id the client
// catalog doesn't (yet) recognize, so a server-added provider never crashes
// the panel — it just renders generically until the catalog is updated.
export function getProviderCatalogEntry(
	provider: string,
): ProviderCatalogEntry {
	if (isKnownProvider(provider)) {
		return PROVIDER_CATALOG[provider];
	}
	return {
		displayName: provider,
		capabilities: [],
		connectMethod: "password-key",
		writable: false,
		pathBasedWrites: false,
		icon: "Cloud",
		connectable: false,
	};
}
