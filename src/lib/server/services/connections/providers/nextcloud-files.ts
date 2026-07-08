import { registerConnectionAdapter } from "../adapters";
import type { ConnectionAdapter } from "../registry";
import { type ConnectionPublic, createConnection } from "../store";

const USER_AGENT = "AlfyAI";

type FetchOpt = { fetch?: typeof fetch };

function normalizeServerUrl(serverUrl: string): string {
	return serverUrl.replace(/\/+$/, "");
}

type LoginV2StartResponse = {
	poll: { token: string; endpoint: string };
	login: string;
};

type LoginV2PollResponse = {
	server: string;
	loginName: string;
	appPassword: string;
};

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
	const normalized = normalizeServerUrl(serverUrl);

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

export async function nextcloudConnectPoll(
	params: {
		userId: string;
		serverUrl: string;
		pollToken: string;
		pollEndpoint: string;
	} & FetchOpt,
): Promise<
	{ status: "pending" } | { status: "connected"; connection: ConnectionPublic }
> {
	const fetchImpl = params.fetch ?? fetch;

	const response = await fetchImpl(params.pollEndpoint, {
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

	const body = (await response.json()) as LoginV2PollResponse;
	const serverUrl = normalizeServerUrl(body.server || params.serverUrl);

	// The secret is ONLY the appPassword — serverUrl/loginName are non-secret
	// and go in `config` (config_json, 1.7), never bundled into the encrypted
	// secret blob.
	const connection = await createConnection({
		userId: params.userId,
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: body.loginName,
		capabilities: ["files"],
		status: "connected",
		secret: body.appPassword,
		config: { serverUrl, loginName: body.loginName },
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
