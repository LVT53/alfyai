import type { ConnectionProvider } from "$lib/server/db/schema";
import type { ConnectionPublic } from "./store";

export type Capability =
	| "calendar"
	| "files"
	| "photos"
	| "email"
	| "location"
	| "media"
	| "contacts"
	| "repos"
	| "tasks";

export type ConnectionTier = "proactive" | "explicit";

export type ConnectMethod =
	| "oauth"
	| "login-flow-v2"
	| "password-key"
	| "app-password";

export const CAPABILITIES: readonly Capability[] = [
	"calendar",
	"files",
	"photos",
	"email",
	"location",
	"media",
	"contacts",
	"repos",
	"tasks",
];

// Per-provider metadata. ConnectionProvider comes from 1.1 (schema/types).
export const PROVIDER_META: Record<
	ConnectionProvider,
	{
		capabilities: Capability[];
		connectMethod: ConnectMethod;
		displayName: string;
	}
> = {
	nextcloud: {
		capabilities: ["files", "contacts"],
		connectMethod: "login-flow-v2",
		displayName: "Nextcloud",
	},
	immich: {
		capabilities: ["photos"],
		connectMethod: "password-key",
		displayName: "Immich",
	},
	imap: {
		capabilities: ["email"],
		connectMethod: "app-password",
		displayName: "Email",
	},
	google: {
		capabilities: ["calendar", "contacts"],
		connectMethod: "oauth",
		displayName: "Google",
	},
	apple: {
		capabilities: ["calendar", "contacts"],
		connectMethod: "app-password",
		displayName: "Apple iCloud",
	},
	plex: {
		capabilities: ["media"],
		connectMethod: "password-key",
		displayName: "Plex",
	},
	owntracks: {
		capabilities: ["location"],
		connectMethod: "password-key",
		displayName: "OwnTracks",
	},
	contacts: {
		capabilities: ["contacts"],
		connectMethod: "app-password",
		displayName: "Contacts (CardDAV)",
	},
	github: {
		capabilities: ["repos"],
		connectMethod: "app-password",
		displayName: "GitHub",
	},
	onedrive: {
		capabilities: ["files"],
		connectMethod: "oauth",
		displayName: "OneDrive",
	},
	todoist: {
		capabilities: ["tasks"],
		connectMethod: "app-password",
		displayName: "Todoist",
	},
	// Task 9b: widened from Task 9a's ["tasks"] — a generic caldav connection
	// (Nextcloud, Fastmail, mailbox.org, Baïkal, ...) now discovers and can
	// serve calendar (VEVENT) and contacts (CardDAV vCard) alongside tasks
	// (VTODO); which of the three a given connection actually ends up with is
	// per-connection (conn.capabilities, derived from what discovery found —
	// see caldavConnect in providers/caldav-tasks.ts), not every caldav
	// connection necessarily has all three. This entry is the ceiling of what
	// a caldav connection can be enabled for.
	caldav: {
		capabilities: ["tasks", "calendar", "contacts"],
		connectMethod: "app-password",
		displayName: "CalDAV",
	},
};

// Per-capability metadata.
export const CAPABILITY_META: Record<
	Capability,
	{
		tier: ConnectionTier;
		providers: ConnectionProvider[];
		displayName: string;
	}
> = {
	calendar: {
		tier: "proactive",
		providers: ["google", "apple", "caldav"],
		displayName: "Calendar",
	},
	email: {
		tier: "proactive",
		providers: ["imap"],
		displayName: "Email",
	},
	files: {
		tier: "explicit",
		providers: ["nextcloud", "onedrive"],
		displayName: "Files",
	},
	photos: {
		tier: "explicit",
		providers: ["immich"],
		displayName: "Photos",
	},
	media: {
		tier: "explicit",
		providers: ["plex"],
		displayName: "Media",
	},
	location: {
		tier: "explicit",
		providers: ["owntracks"],
		displayName: "Location",
	},
	contacts: {
		tier: "explicit",
		providers: ["google", "apple", "nextcloud", "contacts", "caldav"],
		displayName: "Contacts",
	},
	repos: {
		tier: "explicit",
		providers: ["github"],
		displayName: "Repositories",
	},
	tasks: {
		tier: "explicit",
		providers: ["todoist", "caldav"],
		displayName: "Tasks",
	},
};

// Base adapter contract every provider adapter (Phase 2/5) implements.
// Capability-specific read/write methods are added by each concrete adapter;
// this base only fixes the lifecycle shape the framework calls generically.
export interface ConnectionAdapter {
	readonly provider: ConnectionProvider;
	// undefined/true: this provider stores a per-user secret, so health
	// checks should short-circuit to needs_reauth when it's missing. Set to
	// false for providers with no per-user secret (e.g. OwnTracks, whose
	// recorder credentials are admin-config, not per-user) so health always
	// calls checkHealth instead.
	requiresSecret?: boolean;
	checkHealth(
		secret: string,
		conn: ConnectionPublic,
	): Promise<{
		status: "connected" | "needs_reauth" | "error";
		detail: string | null;
	}>;
	disconnect?(secret: string, conn: ConnectionPublic): Promise<void>;
}
