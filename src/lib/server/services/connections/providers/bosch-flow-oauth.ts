import { createHash, randomBytes } from "node:crypto";
import { ConnectionHttpError, providerFetch } from "../provider-http";
import { boschJson } from "./bosch-flow-json";

const issuer =
	"https://p9.authz.bosch.com/auth/realms/obc/protocol/openid-connect";

type BoschClient = { clientId: string; clientSecret?: string };
type BoschGrant = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
};

export function beginBoschLogin(clientId: string, callback: URL) {
	const state = randomBytes(32).toString("base64url");
	const verifier = randomBytes(48).toString("base64url");
	const url = new URL(`${issuer}/auth`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: callback.href,
		scope: "openid",
		state,
		code_challenge_method: "S256",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
	}).toString();
	return { url: url.href, state, verifier };
}

// A rejected redirect never returns the browser to AlfyAI. Ask Bosch anonymously
// with a separate PKCE attempt so the rider can correct their client in setup.
export async function boschRejectsCallback(
	clientId: string,
	callback: URL,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	const probe = new URL(beginBoschLogin(clientId, callback).url);
	probe.searchParams.set("prompt", "none");
	try {
		const response = await fetcher(probe, {
			headers: { Accept: "application/json", "Accept-Language": "en" },
			redirect: "manual",
			credentials: "omit",
			signal: AbortSignal.timeout(4000),
		});
		if (response.status !== 400) {
			await response.body?.cancel();
			return false;
		}
		const body = await boschJson(response, 8192);
		return (
			typeof body.error === "string" &&
			/invalid parameter:\s*redirect_uri/i.test(body.error)
		);
	} catch {
		// An inconclusive probe must still allow the regular interactive sign-in.
		return false;
	}
}

async function tokenRequest(
	client: BoschClient,
	params: URLSearchParams,
	previousRefresh: string | null,
	fetchImpl?: typeof fetch,
): Promise<BoschGrant> {
	params.set("client_id", client.clientId);
	if (client.clientSecret) params.set("client_secret", client.clientSecret);
	const response = await providerFetch(`${issuer}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		redirect: "error",
		body: params,
		fetch: fetchImpl,
	});
	if (!response.ok) {
		const err = await boschJson(response, 65536).catch(() => ({ error: null }));
		const permanent =
			response.status === 401 ||
			response.status === 403 ||
			["invalid_grant", "invalid_client", "unauthorized_client"].includes(
				String(err.error),
			);
		throw new ConnectionHttpError(
			"Bosch authorization failed",
			permanent ? "authorization_failed" : "provider_unavailable",
		);
	}
	const body = await boschJson(response, 65536);
	if (
		typeof body?.access_token !== "string" ||
		!body.access_token ||
		typeof body.token_type !== "string" ||
		body.token_type.toLowerCase() !== "bearer" ||
		typeof body.expires_in !== "number" ||
		!Number.isSafeInteger(body.expires_in) ||
		body.expires_in <= 0
	) {
		throw new ConnectionHttpError(
			"Unexpected Bosch token response",
			"invalid_response",
		);
	}
	return {
		accessToken: body.access_token,
		refreshToken:
			typeof body.refresh_token === "string" && body.refresh_token
				? body.refresh_token
				: previousRefresh,
		expiresAt: Date.now() + body.expires_in * 1000,
	};
}

export function exchangeBoschCode(
	client: BoschClient,
	code: string,
	verifier: string,
	callback: URL,
	fetchImpl?: typeof fetch,
) {
	return tokenRequest(
		client,
		new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: callback.href,
		}),
		null,
		fetchImpl,
	);
}

export function refreshBoschGrant(
	client: BoschClient,
	refreshToken: string,
	fetchImpl?: typeof fetch,
) {
	return tokenRequest(
		client,
		new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
		refreshToken,
		fetchImpl,
	);
}
