import {
	assessOutboundUrl,
	createPlexServerFetch,
} from "$lib/server/outbound/fetch";
import { ConnectionHttpError } from "../provider-http";
import {
	discoverPlexServers,
	type PlexDevice,
	type PlexServerResource,
	renewPlexToken,
} from "./plex-cloud";

export type LinkedPlexSecret = {
	device: PlexDevice;
	serverToken: string;
	tokenOrigin: string;
};
export type PlexTransport = { fetch?: typeof fetch };
export function linkedPlexGet(origin: string, opts?: PlexTransport) {
	const transport = createPlexServerFetch(origin);
	return async (path: string, headers: HeadersInit) => {
		const url = new URL(path, origin);
		if (url.origin !== origin || !assessOutboundUrl(url).ok)
			throw new ConnectionHttpError("Invalid Plex origin", "request_failed");
		return opts?.fetch
			? opts.fetch(url.href, {
					headers,
					redirect: "error",
					signal: AbortSignal.timeout(6000),
				})
			: transport(url, { headers });
	};
}

export function linkedHeaders(token: string | null, clientId: string) {
	return {
		Accept: "application/json",
		"X-Plex-Product": "AlfyAI",
		"X-Plex-Client-Identifier": clientId,
		...(token ? { "X-Plex-Token": token } : {}),
	};
}

// Probe an unauthenticated identity before sending even the server-specific
// grant, then verify a protected endpoint. /identity by itself is public.
export async function locateLinkedPlexServer(
	server: PlexServerResource,
	device: PlexDevice,
	accountToken: string,
	opts?: PlexTransport,
) {
	const candidates = server.connections
		.filter((c) => assessOutboundUrl(c.uri).ok)
		.sort((a, b) => Number(a.local) - Number(b.local));
	const direct = candidates.filter((c) => !c.relay).slice(0, 3);
	const relay = candidates.find((c) => c.relay);
	const origins = [
		...new Set([...direct, ...(relay ? [relay] : [])].map((c) => c.uri)),
	];
	let eligible = false;
	for (const origin of origins) {
		const hostedByPlex = new URL(origin).hostname.endsWith(".plex.direct");
		const token =
			server.accessToken ??
			(server.owned && hostedByPlex ? accountToken : null);
		if (!token) continue;
		eligible = true;
		const get = linkedPlexGet(origin, opts);
		try {
			const identity = await get(
				"/identity",
				linkedHeaders(null, device.clientId),
			);
			if (
				!identity.ok ||
				(await identity.json()).MediaContainer?.machineIdentifier !== server.id
			)
				continue;
			const library = await get(
				"/library/sections",
				linkedHeaders(token, device.clientId),
			);
			if (!library.ok) continue;
			const body = await library.json();
			if (
				!body?.MediaContainer ||
				typeof body.MediaContainer !== "object" ||
				Array.isArray(body.MediaContainer)
			)
				continue;
			return { origin, token };
		} catch {
			/* Try the next advertised address, including Plex Relay. */
		}
	}
	if (!eligible && !server.accessToken)
		throw new ConnectionHttpError(
			"Plex did not issue an eligible server credential",
			"no_server_grant",
		);
	throw new ConnectionHttpError(
		"This Plex server is unreachable",
		"server_unavailable",
	);
}

export async function renewLinkedPlexServer(
	device: PlexDevice,
	serverId: string,
	opts?: PlexTransport,
) {
	const jwt = await renewPlexToken(device, opts?.fetch);
	const servers = await discoverPlexServers(device, jwt, opts?.fetch);
	const server = servers.find((s) => s.id === serverId);
	if (!server)
		throw new ConnectionHttpError(
			"This server is no longer shared",
			"server_unavailable",
		);
	return {
		server,
		...(await locateLinkedPlexServer(server, device, jwt, opts)),
	};
}
