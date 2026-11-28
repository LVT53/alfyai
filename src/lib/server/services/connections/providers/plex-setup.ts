import { createHash, randomUUID } from "node:crypto";
import { ConnectionHttpError } from "../provider-http";
import { getConnection, getConnectionWithCredential } from "../store";
import { connectLinkedPlex } from "./plex";
import {
	discoverPlexServers,
	type PlexServerResource,
	pollPlexPin,
	renewPlexToken,
	startPlexPin,
} from "./plex-cloud";

type Pin = Awaited<ReturnType<typeof startPlexPin>>;
type Attempt = {
	id: string;
	session: string;
	pin: Pin;
	expires: number;
	repair?: { id: string; machine: string; version: string };
	accountToken?: string;
	resources?: PlexServerResource[];
	lastDiscovery: number;
	lastPoll: number;
	connected?: { serverId: string; connectionId: string };
};
const attempts = new Map<string, Attempt>();
const busy = new Set<string>();
const hour = 3_600_000;

function fail(code: string): never {
	throw new ConnectionHttpError("Plex setup could not complete", code);
}
async function exclusive<T>(userId: string, run: () => Promise<T>): Promise<T> {
	if (busy.has(userId)) fail("busy");
	busy.add(userId);
	try {
		return await run();
	} finally {
		busy.delete(userId);
	}
}
function prune() {
	const now = Date.now();
	for (const [user, entry] of attempts)
		if (entry.expires <= now) attempts.delete(user);
}
export function plexSetupSession(cookie: string) {
	return createHash("sha256").update(cookie).digest("hex");
}

async function discover(
	userId: string,
	entry: Attempt,
	fetcher?: typeof fetch,
) {
	if (!entry.accountToken) fail("pending");
	if (!entry.resources || Date.now() - entry.lastDiscovery >= 3000) {
		let servers: PlexServerResource[];
		try {
			servers = await discoverPlexServers(
				entry.pin.device,
				entry.accountToken,
				fetcher,
			);
		} catch (err) {
			if (!(err instanceof ConnectionHttpError) || err.code !== "needs_reauth")
				throw err;
			try {
				entry.accountToken = await renewPlexToken(entry.pin.device, fetcher);
				servers = await discoverPlexServers(
					entry.pin.device,
					entry.accountToken,
					fetcher,
				);
			} catch (retryError) {
				if (
					retryError instanceof ConnectionHttpError &&
					retryError.code === "needs_reauth"
				)
					attempts.delete(userId);
				throw retryError;
			}
		}
		entry.resources = servers.filter(
			(s) => !entry.repair || s.id === entry.repair.machine,
		);
		entry.lastDiscovery = Date.now();
	}
	return {
		status: "ready" as const,
		servers: entry.resources.map(({ id, name }) => ({ id, name })),
	};
}
export function startPlexSetup(
	userId: string,
	session: string,
	connectionId?: string,
	fetcher?: typeof fetch,
) {
	return exclusive(userId, async () => {
		prune();
		const prior = attempts.get(userId);
		if (
			prior &&
			!prior.connected &&
			prior.session === session &&
			prior.repair?.id === connectionId
		) {
			if (prior.accountToken)
				return {
					attemptId: prior.id,
					...(await discover(userId, prior, fetcher)),
				};
			return {
				attemptId: prior.id,
				authUrl: prior.pin.authUrl,
				expiresAt: prior.expires,
			};
		}
		if (!prior && attempts.size >= 2048) fail("busy");
		let repair: Attempt["repair"];
		if (connectionId) {
			const snapshot = await getConnectionWithCredential(userId, connectionId);
			const conn = snapshot?.connection;
			const secret = snapshot?.credential;
			if (conn?.provider !== "plex" || !conn.accountIdentifier || !secret)
				fail("expired");
			repair = {
				id: connectionId,
				machine: conn.accountIdentifier,
				version: secret.version,
			};
		}
		const pin = await startPlexPin(undefined, fetcher);
		const id = randomUUID();
		attempts.set(userId, {
			id,
			session,
			pin,
			repair,
			expires: pin.expiresAt,
			lastPoll: 0,
			lastDiscovery: 0,
		});
		return { attemptId: id, authUrl: pin.authUrl, expiresAt: pin.expiresAt };
	});
}
function active(userId: string, session: string, attemptId: string) {
	prune();
	const entry = attempts.get(userId);
	return entry?.id === attemptId && entry.session === session ? entry : null;
}
export function pollPlexSetup(
	userId: string,
	session: string,
	attemptId: string,
	fetcher?: typeof fetch,
) {
	return exclusive(userId, async () => {
		const entry = active(userId, session, attemptId);
		if (!entry) return { status: "expired" as const };
		if (!entry.accountToken) {
			if (Date.now() - entry.lastPoll < 1000)
				return { status: "pending" as const };
			entry.lastPoll = Date.now();
			try {
				const token = await pollPlexPin(
					entry.pin.device,
					entry.pin.pinId,
					entry.pin.code,
					fetcher,
				);
				if (!token) return { status: "pending" as const };
				entry.accountToken = token;
				entry.expires = Date.now() + 24 * hour;
			} catch (err) {
				if (
					!(err instanceof ConnectionHttpError) ||
					!(err.code === "expired" || err.code === "needs_reauth")
				)
					throw err;
				attempts.delete(userId);
				return { status: "expired" as const };
			}
		}
		return discover(userId, entry, fetcher);
	});
}
export function selectPlexServer(
	userId: string,
	session: string,
	attemptId: string,
	serverId: string,
	fetcher?: typeof fetch,
) {
	return exclusive(userId, async () => {
		const entry = active(userId, session, attemptId);
		if (!entry) fail("expired");
		if (entry.connected) {
			const { connectionId, serverId: chosen } = entry.connected;
			const connection =
				chosen === serverId && (await getConnection(userId, connectionId));
			if (!connection) fail("expired");
			return { connection };
		}
		if (!entry.accountToken) fail("pending");
		await discover(userId, entry, fetcher);
		const server = entry.resources?.find((s) => s.id === serverId);
		if (!server) fail("server_unavailable");
		const connection = await connectLinkedPlex({
			userId,
			device: entry.pin.device,
			accountToken: entry.accountToken,
			server,
			repair: entry.repair,
			fetch: fetcher,
		});
		entry.connected = { serverId, connectionId: connection.id };
		entry.expires = Date.now() + 60_000;
		return { connection };
	});
}
