import { registerConnectionAdapter } from "../adapters";
import type { ConnectionAdapter } from "../registry";
import {
	type ConnectionPublic,
	createConnection,
	findConnectionByAccount,
	setConnectionSecret,
	updateConnection,
} from "../store";

const USER_AGENT = "AlfyAI";

type FetchOpt = { fetch?: typeof fetch };

// IPv4 octets that make a host loopback/private/link-local (RFC1918 +
// RFC3927 + loopback). Only used for literal dotted-quad hostnames — DNS
// names are not resolved here (see assertPublicHttpsUrl doc comment).
function isPrivateOrLoopbackIpv4(hostname: string): boolean {
	const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!match) return false;
	const octets = match.slice(1).map(Number);
	if (octets.some((n) => n < 0 || n > 255)) return false;
	const [a, b] = octets;
	if (a === 127) return true; // loopback
	if (a === 10) return true; // RFC1918
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
	if (a === 192 && b === 168) return true; // RFC1918
	if (a === 169 && b === 254) return true; // link-local
	if (a === 0) return true; // "this network"
	return false;
}

const PRIVATE_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
]);

function isLoopbackOrLinkLocalIpv6(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	if (h.startsWith("fe80:")) return true; // link-local
	return false;
}

// SSRF guard shared by both the start and poll routes/helpers: the
// serverUrl a user supplies is fetched server-side with the request's own
// secrets attached (or used to derive a URL that is), so it must be a
// public https origin — not loopback/link-local/private. This intentionally
// does NOT resolve DNS (no protection against DNS rebinding to a private
// IP behind a public hostname); real-world Nextcloud instances used by this
// app are public (e.g. https://alfycloud.hu), so self-hosted/private-network
// Nextcloud is out of scope for now.
export function assertPublicHttpsUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("serverUrl must be a valid absolute URL");
	}

	if (parsed.protocol !== "https:") {
		throw new Error("serverUrl must use https");
	}

	const hostname = parsed.hostname.toLowerCase();
	if (PRIVATE_HOSTNAMES.has(hostname)) {
		throw new Error("serverUrl must not point to a private or loopback host");
	}
	if (isPrivateOrLoopbackIpv4(hostname)) {
		throw new Error("serverUrl must not point to a private or loopback host");
	}
	if (hostname.includes(":") && isLoopbackOrLinkLocalIpv6(hostname)) {
		throw new Error("serverUrl must not point to a private or loopback host");
	}

	return value.replace(/\/+$/, "");
}

function isUniqueConstraintError(err: unknown): boolean {
	return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

type LoginV2StartResponse = {
	poll: { token: string; endpoint: string };
	login: string;
};

// Validates the shape of a Nextcloud login/v2 poll 200 response before it is
// ever used to create/update a connection. `server` is only checked for
// type (we never trust it for storage — see nextcloudConnectPoll below);
// `loginName`/`appPassword` must be non-empty strings since they become the
// account identifier and the encrypted secret.
function assertValidPollResponse(
	body: unknown,
): asserts body is { server: string; loginName: string; appPassword: string } {
	if (!body || typeof body !== "object") {
		throw new Error("Nextcloud login/v2 poll returned a malformed response");
	}
	const { server, loginName, appPassword } = body as Record<string, unknown>;
	if (typeof server !== "string") {
		throw new Error(
			"Nextcloud login/v2 poll response is missing a string 'server' field",
		);
	}
	if (typeof loginName !== "string" || loginName.length === 0) {
		throw new Error(
			"Nextcloud login/v2 poll response is missing a non-empty 'loginName'",
		);
	}
	if (typeof appPassword !== "string" || appPassword.length === 0) {
		throw new Error(
			"Nextcloud login/v2 poll response is missing a non-empty 'appPassword'",
		);
	}
}

export async function nextcloudConnectStart(
	serverUrl: string,
	opts?: FetchOpt,
): Promise<{
	loginUrl: string;
	pollToken: string;
	pollEndpoint: string;
	serverUrl: string;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const normalized = assertPublicHttpsUrl(serverUrl);

	const response = await fetchImpl(`${normalized}/index.php/login/v2`, {
		method: "POST",
		headers: { "User-Agent": USER_AGENT },
	});
	if (!response.ok) {
		throw new Error(
			`Nextcloud login/v2 start failed with status ${response.status}`,
		);
	}

	const body = (await response.json()) as LoginV2StartResponse;
	return {
		loginUrl: body.login,
		pollToken: body.poll.token,
		pollEndpoint: body.poll.endpoint,
		serverUrl: normalized,
	};
}

// Creates the connection on first successful poll, or refreshes an existing
// one (same userId+provider+loginName) on a re-poll/re-authorization instead
// of colliding on the store's unique index. Also guards against a race
// between the pre-check and the insert by catching the unique-constraint
// error and falling back to an update.
async function upsertNextcloudConnection(params: {
	userId: string;
	serverUrl: string;
	loginName: string;
	appPassword: string;
}): Promise<ConnectionPublic> {
	const config = { serverUrl: params.serverUrl, loginName: params.loginName };

	const existing = await findConnectionByAccount(
		params.userId,
		"nextcloud",
		params.loginName,
	);
	if (existing) {
		await setConnectionSecret(params.userId, existing.id, params.appPassword);
		const updated = await updateConnection(params.userId, existing.id, {
			status: "connected",
			statusDetail: null,
			config,
		});
		if (!updated) throw new Error("Failed to update existing connection");
		return updated;
	}

	try {
		return await createConnection({
			userId: params.userId,
			provider: "nextcloud",
			label: "Nextcloud",
			accountIdentifier: params.loginName,
			capabilities: ["files"],
			status: "connected",
			secret: params.appPassword,
			config,
		});
	} catch (err) {
		if (!isUniqueConstraintError(err)) throw err;
		// Lost a race with a concurrent poll that created the row first.
		const raced = await findConnectionByAccount(
			params.userId,
			"nextcloud",
			params.loginName,
		);
		if (!raced) throw err;
		await setConnectionSecret(params.userId, raced.id, params.appPassword);
		const updated = await updateConnection(params.userId, raced.id, {
			status: "connected",
			statusDetail: null,
			config,
		});
		if (!updated) throw err;
		return updated;
	}
}

export async function nextcloudConnectPoll(
	params: {
		userId: string;
		serverUrl: string;
		pollToken: string;
	} & FetchOpt,
): Promise<
	{ status: "pending" } | { status: "connected"; connection: ConnectionPublic }
> {
	const fetchImpl = params.fetch ?? fetch;
	const serverUrl = assertPublicHttpsUrl(params.serverUrl);
	const pollEndpoint = `${serverUrl}/index.php/login/v2/poll`;

	const response = await fetchImpl(pollEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token: params.pollToken }).toString(),
	});

	if (response.status === 404) {
		return { status: "pending" };
	}
	if (!response.ok) {
		throw new Error(
			`Nextcloud login/v2 poll failed with status ${response.status}`,
		);
	}

	const body: unknown = await response.json();
	assertValidPollResponse(body);

	// The secret is ONLY the appPassword — serverUrl/loginName are non-secret
	// and go in `config` (config_json, 1.7), never bundled into the encrypted
	// secret blob. `config.serverUrl` is always the caller-validated
	// serverUrl, never the response body's `server` field (which is
	// untrusted and could otherwise be used to redirect future checkHealth
	// calls — carrying the decrypted secret — to an attacker-chosen host).
	const connection = await upsertNextcloudConnection({
		userId: params.userId,
		serverUrl,
		loginName: body.loginName,
		appPassword: body.appPassword,
	});

	return { status: "connected", connection };
}

async function checkHealth(
	secret: string,
	conn: ConnectionPublic,
	opts?: FetchOpt,
): Promise<{
	status: "connected" | "needs_reauth" | "error";
	detail: string | null;
}> {
	const fetchImpl = opts?.fetch ?? fetch;
	const serverUrl =
		typeof conn.config.serverUrl === "string" ? conn.config.serverUrl : "";
	const loginName =
		typeof conn.config.loginName === "string" ? conn.config.loginName : "";

	if (!serverUrl || !loginName) {
		return {
			status: "error",
			detail: "Connection is missing serverUrl or loginName in its config",
		};
	}

	try {
		const response = await fetchImpl(`${serverUrl}/ocs/v1.php/cloud/user`, {
			headers: {
				Authorization: `Basic ${Buffer.from(`${loginName}:${secret}`).toString("base64")}`,
				"OCS-APIRequest": "true",
			},
		});

		if (response.status === 200) {
			return { status: "connected", detail: null };
		}
		if (response.status === 401) {
			return {
				status: "needs_reauth",
				detail: "Nextcloud rejected the stored app password",
			};
		}
		return {
			status: "error",
			detail: `Nextcloud returned an unexpected status (${response.status})`,
		};
	} catch (err) {
		return {
			status: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// No server-side revoke call exists for v1: deleting the stored app password
// (handled by the store layer when the connection row is removed) is
// sufficient to cut off access. Kept as an explicit no-op so the adapter
// contract is documented rather than silently absent.
async function disconnect(): Promise<void> {}

// Not annotated as `: ConnectionAdapter` — that would narrow checkHealth's
// call signature to the interface's (secret, conn) shape and break the
// mocked-fetch tests that pass a third `{ fetch }` opts arg. The object is
// still structurally a valid ConnectionAdapter, which is all
// registerConnectionAdapter (typed on that interface) requires.
export const nextcloudFilesAdapter = {
	provider: "nextcloud" as const,
	checkHealth,
	disconnect,
};

registerConnectionAdapter(nextcloudFilesAdapter satisfies ConnectionAdapter);
