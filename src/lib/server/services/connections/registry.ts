import type { ConnectionProvider } from "$lib/server/db/schema";
import type { ConnectionPublic } from "./store";

export type Capability =
	| "calendar"
	| "files"
	| "photos"
	| "email"
	| "location"
	| "media"
	| "contacts";

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
		providers: ["google", "apple"],
		displayName: "Calendar",
	},
	email: {
		tier: "proactive",
		providers: ["imap"],
		displayName: "Email",
	},
	files: {
		tier: "explicit",
		providers: ["nextcloud"],
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
		providers: ["google", "apple", "nextcloud", "contacts"],
		displayName: "Contacts",
	},
};

// Base adapter contract every provider adapter (Phase 2/5) implements.
// Capability-specific read/write methods are added by each concrete adapter;
// this base only fixes the lifecycle shape the framework calls generically.
export interface ConnectionAdapter {
	readonly provider: ConnectionProvider;
	checkHealth(
		secret: string,
		conn: ConnectionPublic,
	): Promise<{
		status: "connected" | "needs_reauth" | "error";
		detail: string | null;
	}>;
	disconnect?(secret: string, conn: ConnectionPublic): Promise<void>;
}
