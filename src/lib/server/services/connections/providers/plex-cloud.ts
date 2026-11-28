import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { z } from "zod";
import { ConnectionHttpError } from "../provider-http";

// Plex's device registration, nonce exchange and resource directory are all
// hosted here. Discovered media server addresses never reach this client.
const base = "https://clients.plex.tv/api/v2";
const product = "AlfyAI";

export type PlexDevice = { clientId: string; kid: string; privateKey: string };
export type PlexServerResource = {
	id: string;
	name: string;
	owned: boolean;
	accessToken: string | null;
	connections: { uri: string; local: boolean; relay: boolean }[];
};
const token = z
	.string()
	.min(1)
	.max(32768)
	.regex(/^[!-~]+$/);
const pinFields = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	code: z.string().min(4).max(512),
});
const resource = z.object({
	clientIdentifier: z.string().min(1).max(512),
	name: z.string().trim().min(1).max(512),
	provides: z.string(),
	owned: z.boolean(),
	accessToken: token.nullish(),
	connections: z
		.array(
			z.object({
				uri: z.string().max(8192),
				local: z.boolean().optional(),
				relay: z.boolean().optional(),
			}),
		)
		.max(256),
});
function fail(code = "request_failed"): never {
	throw new ConnectionHttpError(
		"Plex could not complete the account request",
		code,
	);
}
async function cloud(
	device: PlexDevice,
	path: string,
	fetcher: typeof fetch,
	options: {
		body?: unknown;
		accountToken?: string;
		checkingPin?: boolean;
	} = {},
): Promise<unknown> {
	try {
		const res = await fetcher(base + path, {
			method: options.body ? "POST" : "GET",
			signal: AbortSignal.timeout(15000),
			redirect: "error",
			headers: {
				Accept: "application/json",
				"X-Plex-Product": product,
				"X-Plex-Client-Identifier": device.clientId,
				...(options.accountToken
					? { "X-Plex-Token": options.accountToken }
					: {}),
				...(options.body ? { "Content-Type": "application/json" } : {}),
			},
			...(options.body ? { body: JSON.stringify(options.body) } : {}),
		});
		if (!res.ok) {
			await res.body?.cancel();
			if (options.checkingPin && (res.status === 404 || res.status === 410))
				fail("expired");
			if (res.status === 401 || res.status === 403 || res.status === 498)
				fail("needs_reauth");
			if (res.status === 429) fail("rate_limited");
			fail();
		}
		const reader = res.body?.getReader();
		if (!reader) return fail();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				bytes += part.value.byteLength;
				if (bytes > 2 * 1024 * 1024) {
					await reader.cancel();
					fail();
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		// Never surface upstream URLs (the poll URL contains a signature), payloads or headers.
		if (error instanceof ConnectionHttpError) throw error;
		return fail();
	}
}

function deviceProof(device: PlexDevice, nonce?: string) {
	const now = Math.floor(Date.now() / 1000);
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const claims = {
		iss: device.clientId,
		aud: "plex.tv",
		iat: now,
		exp: now + 300,
		scope: "username",
		...(nonce ? { nonce } : {}),
	};
	const payload =
		encode({ alg: "EdDSA", typ: "JWT", kid: device.kid }) +
		"." +
		encode(claims);
	return (
		payload +
		"." +
		sign(null, Buffer.from(payload), device.privateKey).toString("base64url")
	);
}

export async function startPlexPin(
	forwardUrl?: string,
	fetcher: typeof fetch = fetch,
) {
	const keys = generateKeyPairSync("ed25519");
	const { crv, kty, x } = keys.publicKey.export({ format: "jwk" });
	const kid = createHash("sha256")
		.update(JSON.stringify({ crv, kty, x }))
		.digest("base64url");
	const device: PlexDevice = {
		clientId: randomUUID(),
		kid,
		privateKey: keys.privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString(),
	};
	const jwk = { kty, crv, x, kid, alg: "EdDSA", use: "sig" };
	const pin = pinFields
		.extend({ expiresAt: z.iso.datetime({ offset: true }) })
		.safeParse(
			await cloud(device, "/pins", fetcher, { body: { strong: true, jwk } }),
		);
	if (!pin.success) return fail();
	const params = new URLSearchParams({
		clientID: device.clientId,
		code: pin.data.code,
		"context[device][product]": product,
	});
	if (forwardUrl) params.set("forwardUrl", forwardUrl);
	return {
		device,
		pinId: pin.data.id,
		code: pin.data.code,
		expiresAt: Date.parse(pin.data.expiresAt),
		authUrl: `https://app.plex.tv/auth#?${params}`,
	};
}

export async function pollPlexPin(
	device: PlexDevice,
	pinId: number,
	code: string,
	fetcher: typeof fetch = fetch,
) {
	if (!Number.isSafeInteger(pinId) || pinId <= 0) return fail("expired");
	const params = new URLSearchParams({ deviceJWT: deviceProof(device), code });
	const result = pinFields.extend({ authToken: token.nullable() }).safeParse(
		await cloud(device, `/pins/${pinId}?${params}`, fetcher, {
			checkingPin: true,
		}),
	);
	if (!result.success || result.data.id !== pinId || result.data.code !== code)
		return fail();
	return result.data.authToken;
}

export async function renewPlexToken(
	device: PlexDevice,
	fetcher: typeof fetch = fetch,
) {
	const challenge = z
		.object({ nonce: z.string().min(1).max(512) })
		.safeParse(await cloud(device, "/auth/nonce", fetcher));
	if (!challenge.success) return fail();
	const result = z.object({ auth_token: token }).safeParse(
		await cloud(device, "/auth/token", fetcher, {
			body: { jwt: deviceProof(device, challenge.data.nonce) },
		}),
	);
	if (!result.success) return fail();
	return result.data.auth_token;
}

// Only Plex's HTTPS directory supplies these tokens. An explicit cloud
// audience narrows where we can send one; this check never grants access.
function serverCredential(
	value: string | null | undefined,
	accountToken: string,
) {
	if (!value || value === accountToken) return null;
	const parts = value.split(".");
	if (parts.length === 3) {
		try {
			const aud: unknown = JSON.parse(
				Buffer.from(parts[1], "base64url").toString("utf8"),
			)?.aud;
			if (aud === "plex.tv" || (Array.isArray(aud) && aud.includes("plex.tv")))
				return null;
		} catch {
			// Opaque server tokens have no documented internal format.
		}
	}
	return value;
}

export async function discoverPlexServers(
	device: PlexDevice,
	accountToken: string,
	fetcher: typeof fetch = fetch,
): Promise<PlexServerResource[]> {
	const result = await cloud(
		device,
		"/resources?includeHttps=1&includeRelay=1&includeIPv6=1",
		fetcher,
		{ accountToken },
	);
	if (!Array.isArray(result)) return fail();
	const servers: PlexServerResource[] = [];
	for (const item of result) {
		const parsed = resource.safeParse(item);
		if (!parsed.success) continue;
		const row = parsed.data;
		if (
			!row.provides
				.split(",")
				.some((capability) => capability.trim() === "server")
		)
			continue;
		const connections = row.connections.flatMap(({ uri, local, relay }) => {
			const url = URL.parse(uri);
			if (
				url?.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				return [];
			return [
				{ uri: url.origin, local: local === true, relay: relay === true },
			];
		});
		servers.push({
			id: row.clientIdentifier,
			name: row.name,
			owned: row.owned,
			accessToken: serverCredential(row.accessToken, accountToken),
			connections,
		});
	}
	return servers;
}
