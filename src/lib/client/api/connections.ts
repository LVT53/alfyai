import { requestJson, requestVoid } from "./http";

// Client-side mirror of the server ConnectionPublic DTO
// (src/lib/server/services/connections/store.ts). Never add a secret field
// here — the server DTO deliberately excludes them.
export type ConnectionPublic = {
	id: string;
	provider: string;
	label: string;
	accountIdentifier: string | null;
	status: "connected" | "needs_reauth" | "error" | "disconnected";
	statusDetail: string | null;
	defaultOn: boolean;
	allowWrites: boolean;
	writeAllowlist: string[];
	capabilities: string[];
	config: Record<string, unknown>;
	oauthScopes: string[];
	tokenExpiresAt: number | null;
	hasSecret: boolean;
	hasWriteSecret: boolean;
	createdAt: number;
	updatedAt: number;
};

export async function fetchConnections(): Promise<ConnectionPublic[]> {
	const { connections } = await requestJson<{
		connections: ConnectionPublic[];
	}>("/api/connections", undefined, "Failed to load connections");
	return connections;
}

export async function updateConnection(
	id: string,
	patch: {
		allowWrites?: boolean;
		defaultOn?: boolean;
		capabilities?: string[];
		// Issue 7.1 — root paths a path-based write provider (e.g. nextcloud)
		// is allowed to write under. Server-side validated/normalized; see
		// src/routes/api/connections/[id]/+server.ts.
		writeAllowlist?: string[];
	},
): Promise<ConnectionPublic> {
	return requestJson<ConnectionPublic>(
		`/api/connections/${id}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		},
		"Failed to update connection",
	);
}

export async function disconnectConnection(id: string): Promise<void> {
	await requestVoid(
		`/api/connections/${id}`,
		{ method: "DELETE" },
		"Failed to disconnect",
	);
}

// Issue 7.2 — feeds the chat composer's per-conversation capability toggles.
// `served` are the capabilities the user currently has a connected
// connection serving; `defaultOn` (a subset of `served`) is what the
// composer initializes its toggles to; `accounts` lists, per served
// capability, the connections serving it (for the multi-account indicator).
export type ActiveCapabilitiesAccount = {
	id: string;
	label: string;
	provider: string;
};

export type ActiveCapabilitiesResponse = {
	served: string[];
	defaultOn: string[];
	accounts: {
		capability: string;
		connections: ActiveCapabilitiesAccount[];
	}[];
};

export async function fetchActiveCapabilities(): Promise<ActiveCapabilitiesResponse> {
	return requestJson<ActiveCapabilitiesResponse>(
		"/api/connections/active-capabilities",
		undefined,
		"Failed to load active capabilities",
	);
}

// Issue 7.3 — connect wizard start/poll/devices wrappers. Each mirrors the
// EXACT request/response contract of its `+server.ts` route (read there —
// see src/routes/api/connections/<provider>/start/+server.ts) rather than
// guessing shapes.

function postJson<T>(path: string, body: unknown, errorMessage: string) {
	return requestJson<T>(
		path,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		errorMessage,
	);
}

// Shared response shape for every OAuth-connectMethod provider's start route
// (currently google + onedrive) — each just returns the provider's consent-
// screen URL to redirect the browser to.
export type OAuthConnectStartResponse = { authUrl: string };
// Back-compat alias — kept so any existing import of the old Google-specific
// name keeps working.
export type GoogleConnectStartResponse = OAuthConnectStartResponse;

// POST /api/connections/google/start — src/routes/api/connections/google/start/+server.ts
export async function startGoogleConnect(
	capabilities: string[],
): Promise<OAuthConnectStartResponse> {
	return postJson<OAuthConnectStartResponse>(
		"/api/connections/google/start",
		{ capabilities },
		"Failed to start Google connect",
	);
}

// POST /api/connections/onedrive/start — src/routes/api/connections/onedrive/start/+server.ts
export async function startOneDriveConnect(
	capabilities: string[],
): Promise<OAuthConnectStartResponse> {
	return postJson<OAuthConnectStartResponse>(
		"/api/connections/onedrive/start",
		{ capabilities },
		"Failed to start OneDrive connect",
	);
}

export type NextcloudConnectStartResponse = {
	loginUrl: string;
	pollToken: string;
	pollEndpoint: string;
	serverUrl: string;
};

// POST /api/connections/nextcloud/start — src/routes/api/connections/nextcloud/start/+server.ts
export async function startNextcloudConnect(
	serverUrl: string,
): Promise<NextcloudConnectStartResponse> {
	return postJson<NextcloudConnectStartResponse>(
		"/api/connections/nextcloud/start",
		{ serverUrl },
		"Failed to start Nextcloud login",
	);
}

export type NextcloudConnectPollResponse =
	| { status: "pending" }
	| { status: "connected"; connection: ConnectionPublic };

// POST /api/connections/nextcloud/poll — src/routes/api/connections/nextcloud/poll/+server.ts
export async function pollNextcloudConnect(params: {
	serverUrl: string;
	pollToken: string;
}): Promise<NextcloudConnectPollResponse> {
	return postJson<NextcloudConnectPollResponse>(
		"/api/connections/nextcloud/poll",
		params,
		"Failed to poll Nextcloud login",
	);
}

// POST /api/connections/immich/start — src/routes/api/connections/immich/start/+server.ts
export async function startImmichConnect(params: {
	serverUrl: string;
	email: string;
	password: string;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/immich/start",
		params,
		"Failed to connect to the Immich server",
	);
}

// POST /api/connections/plex/start — src/routes/api/connections/plex/start/+server.ts
export async function startPlexConnect(params: {
	serverUrl: string;
	token: string;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/plex/start",
		params,
		"Failed to connect to the Plex server",
	);
}

// POST /api/connections/github/start — src/routes/api/connections/github/start/+server.ts
export async function startGitHubConnect(params: {
	token: string;
	baseUrl?: string;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/github/start",
		params,
		"Failed to connect to GitHub",
	);
}

// POST /api/connections/apple/start — src/routes/api/connections/apple/start/+server.ts
export async function startAppleConnect(params: {
	appleId: string;
	appPassword: string;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/apple/start",
		params,
		"Failed to connect to Apple iCloud",
	);
}

// POST /api/connections/caldav/start — src/routes/api/connections/caldav/start/+server.ts
export async function startCalDavConnect(params: {
	serverUrl: string;
	username: string;
	appPassword: string;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/caldav/start",
		params,
		"Failed to connect to the CalDAV server",
	);
}

// POST /api/connections/email/start — src/routes/api/connections/email/start/+server.ts
export async function startEmailConnect(params: {
	email: string;
	imapHost: string;
	imapPort?: number;
	imapSecure?: boolean;
	password: string;
	smtpHost?: string;
	smtpPort?: number;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/email/start",
		params,
		"Failed to connect to the mailbox",
	);
}

export type OwnTracksDevice = { otUser: string; otDevice: string };

// GET /api/connections/owntracks/devices — src/routes/api/connections/owntracks/devices/+server.ts
export async function fetchOwnTracksDevices(): Promise<OwnTracksDevice[]> {
	const { devices } = await requestJson<{ devices: OwnTracksDevice[] }>(
		"/api/connections/owntracks/devices",
		undefined,
		"Failed to list OwnTracks devices",
	);
	return devices;
}

export type NextcloudFolderSuggestion = { path: string; name: string };

// GET /api/connections/[id]/nextcloud-folders — src/routes/api/connections/[id]/nextcloud-folders/+server.ts
// Backs the write-allowlist folder editor's suggestion dropdown (Redesign
// R9, nextcloud only). Callers are expected to catch a rejection (offline /
// needs_reauth / not a nextcloud connection) and fall back to plain manual
// entry — this wrapper never swallows the error itself.
export async function fetchNextcloudFolders(
	connectionId: string,
	path?: string,
): Promise<NextcloudFolderSuggestion[]> {
	const query = path ? `?path=${encodeURIComponent(path)}` : "";
	const { folders } = await requestJson<{
		folders: NextcloudFolderSuggestion[];
	}>(
		`/api/connections/${connectionId}/nextcloud-folders${query}`,
		undefined,
		"Failed to list Nextcloud folders",
	);
	return folders;
}

// POST /api/connections/owntracks/start — src/routes/api/connections/owntracks/start/+server.ts
export async function startOwnTracksConnect(params: {
	otUser: string;
	otDevice: string;
	label?: string;
}): Promise<{ connection: ConnectionPublic }> {
	return postJson<{ connection: ConnectionPublic }>(
		"/api/connections/owntracks/start",
		params,
		"Failed to connect to OwnTracks",
	);
}

// PATCH /api/connections/[id]/owntracks-home —
// src/routes/api/connections/[id]/owntracks-home/+server.ts
// Task 10 — sets or clears (pass both as null) the home lat/lon the
// "distance" location-tool action reads via ownTracksHomeReference. Config,
// not a secret — never touches the vault or the write-confirm firewall.
export async function updateOwnTracksHome(
	id: string,
	patch: { homeLat: number | null; homeLon: number | null },
): Promise<ConnectionPublic> {
	return requestJson<ConnectionPublic>(
		`/api/connections/${id}/owntracks-home`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		},
		"Failed to update the home location",
	);
}

// Issue 7.4 — locality privacy controls. Option C (warn-once before sending
// connector data to a cloud model) and Option A (per-user local-distill
// toggle). See src/lib/server/services/connections/locality.ts for the
// underlying logic these thin endpoints expose.

export type CloudWarningResponse = { shouldWarn: boolean };

// POST /api/connections/cloud-warning — src/routes/api/connections/cloud-warning/+server.ts
export async function checkCloudWarning(
	modelId: string,
	capabilities: string[],
): Promise<CloudWarningResponse> {
	return postJson<CloudWarningResponse>(
		"/api/connections/cloud-warning",
		{ modelId, capabilities },
		"Failed to check the cloud connector warning",
	);
}

// POST /api/connections/cloud-ack — src/routes/api/connections/cloud-ack/+server.ts
export async function ackCloudConnector(): Promise<void> {
	await requestVoid(
		"/api/connections/cloud-ack",
		{ method: "POST" },
		"Failed to acknowledge the cloud connector warning",
	);
}

export type LocalityResponse = { localDistill: boolean };

// GET /api/connections/locality — src/routes/api/connections/locality/+server.ts
export async function fetchLocality(): Promise<LocalityResponse> {
	return requestJson<LocalityResponse>(
		"/api/connections/locality",
		undefined,
		"Failed to load the locality preference",
	);
}

// PATCH /api/connections/locality — src/routes/api/connections/locality/+server.ts
export async function setLocalDistill(
	enabled: boolean,
): Promise<LocalityResponse> {
	return requestJson<LocalityResponse>(
		"/api/connections/locality",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ localDistill: enabled }),
		},
		"Failed to update the locality preference",
	);
}
