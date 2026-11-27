import { randomUUID } from "node:crypto";
import {
	type BoschHostedStart as Client,
	boschHostedStartSchema as clientSchema,
	boschHostedGrantsSchema as grantsSchema,
} from "$lib/shared/bosch-hosted";
import { ConnectionHttpError } from "../provider-http";
import {
	createConnection,
	findConnectionByAccount,
	getConnection,
	getConnectionSecretSnapshot,
	updateConnection,
} from "../store";
import { readBoschDetail } from "./bosch-flow-detail-reader";
import {
	type BoschDetailAnswer,
	type BoschDetailGrant,
	type BoschDetailQuery,
	requiredBoschGrant,
} from "./bosch-flow-details";
import {
	beginBoschLogin,
	exchangeBoschCode,
	refreshBoschGrant,
} from "./bosch-flow-oauth";
import { collectBoschSnapshot, type Snapshot } from "./bosch-flow-snapshot";

type Hosted = {
	authorizationId: string;
	client: { clientId: string; clientSecret?: string };
	grant: Awaited<ReturnType<typeof exchangeBoschCode>>;
	grants: BoschDetailGrant[];
};
type Saved = {
	hosted?: Hosted;
	keyHash?: string;
	snapshot?: Snapshot & { syncedAt: number };
};
async function read(userId: string, id: string) {
	const data = await getConnectionSecretSnapshot(userId, id);
	return data
		? { value: JSON.parse(data.value) as Saved, version: data.version }
		: null;
}
async function personal(userId: string) {
	const connection = await findConnectionByAccount(userId, "bosch", "personal");
	if (!connection) return null;
	const saved = await read(userId, connection.id);
	return saved ? { connection, ...saved } : null;
}
export async function getBoschHostedSetup(userId: string) {
	const saved = await personal(userId);
	if (saved?.value.hosted)
		return { mode: "hosted" as const, grants: saved.value.hosted.grants };
	return {
		mode: saved ? ("helper" as const) : ("none" as const),
		grants: [] as BoschDetailGrant[],
	};
}
type Attempt = {
	timer: ReturnType<typeof setTimeout>;
	expires: number;
	state: string;
	verifier: string;
	callback: string;
	client: Client;
	identity: string | null;
	connectionId: string | null;
};
const attempts = new Map<string, Attempt>();
const identity = (saved: Saved | undefined) =>
	saved?.hosted?.authorizationId ?? saved?.keyHash ?? null;
export async function startBoschHostedSetup(
	userId: string,
	input: Client,
	callback: URL,
) {
	const client = clientSchema.parse(input);
	if (
		callback.username ||
		callback.password ||
		callback.search ||
		callback.hash ||
		!(
			callback.protocol === "https:" ||
			(callback.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname))
		)
	)
		throw new Error("Invalid Bosch callback");
	const now = Date.now();

	if (!attempts.has(userId) && attempts.size >= 2048)
		throw new Error("Bosch setup busy");
	const prior = await personal(userId);
	const { url, state, verifier } = beginBoschLogin(client.clientId, callback);
	const previous = attempts.get(userId);
	if (previous) clearTimeout(previous.timer);
	const timer = setTimeout(() => {
		if (attempts.get(userId)?.state === state) attempts.delete(userId);
	}, 600_000);
	timer.unref();
	attempts.set(userId, {
		timer,
		expires: now + 600_000,
		state,
		verifier,
		callback: callback.href,
		client,
		identity: identity(prior?.value),
		connectionId: prior?.connection.id ?? null,
	});
	return { url, state };
}
export async function completeBoschHostedSetup(
	userId: string,
	code: string,
	state: string,
	callback: URL,
	fetcher?: typeof fetch,
) {
	const attempt = attempts.get(userId);
	if (
		!attempt ||
		attempt.expires <= Date.now() ||
		attempt.state !== state ||
		attempt.callback !== callback.href ||
		!code ||
		code.length > 4096
	)
		throw new Error("Invalid or expired Bosch setup");
	attempts.delete(userId);
	clearTimeout(attempt.timer);
	const { grants, ...client } = attempt.client;
	const grant = await exchangeBoschCode(
		client,
		code,
		attempt.verifier,
		callback,
		fetcher,
	);
	if (!grant.refreshToken)
		throw new Error("Bosch did not grant offline access");
	const prior = await personal(userId);
	if (
		attempts.has(userId) ||
		(prior?.connection.id ?? null) !== attempt.connectionId ||
		identity(prior?.value) !== attempt.identity
	)
		throw new Error("Bosch setup changed");
	const hosted: Hosted = {
		authorizationId: randomUUID(),
		client,
		grant,
		grants,
	};
	// A different Bosch identity could have signed in. Never carry over its predecessor's cached rides.
	const secret = JSON.stringify({ hosted });
	if (prior) {
		if (
			!(await updateConnection(
				userId,
				prior.connection.id,
				{ secret, status: "connected", statusDetail: null },
				prior.version,
			))
		)
			throw new Error("Bosch setup changed");
	} else {
		await createConnection({
			userId,
			provider: "bosch",
			accountIdentifier: "personal",
			label: "Bosch eBike Flow",
			capabilities: ["cycling"],
			status: "connected",
			secret,
		});
	}
}
// All credential mutations for the same hosted connection share a short queue. In
// particular, a rotating refresh token must be committed before a consent edit.
const queues = new Map<string, Promise<void>>();
async function serialized<T>(id: string, work: () => Promise<T>) {
	const prior = queues.get(id) ?? Promise.resolve();
	const running = prior.then(work);
	const tail = running.then(
		() => {},
		() => {},
	);
	queues.set(id, tail);
	try {
		return await running;
	} finally {
		if (queues.get(id) === tail) queues.delete(id);
	}
}
export async function setBoschHostedGrants(
	userId: string,
	grants: BoschDetailGrant[],
) {
	const choices = grantsSchema.parse(grants);
	const conn = await findConnectionByAccount(userId, "bosch", "personal");
	if (!conn) return false;
	return serialized(conn.id, async () => {
		const prior = await read(userId, conn.id);
		if (!prior?.value.hosted) return false;
		prior.value.hosted.grants = choices;
		return Boolean(
			await updateConnection(
				userId,
				conn.id,
				{ secret: JSON.stringify(prior.value) },
				prior.version,
			),
		);
	});
}
async function authorized(
	userId: string,
	id: string,
	required?: BoschDetailGrant,
) {
	const conn = await getConnection(userId, id);
	if (
		conn?.provider !== "bosch" ||
		conn.status !== "connected" ||
		!conn.capabilities.includes("cycling")
	)
		return null;
	const saved = await read(userId, id);
	if (!saved?.value.hosted) return null;
	if (required && !saved.value.hosted.grants.includes(required))
		throw new ConnectionHttpError("Permission required", "consent_required");
	return { saved, hosted: saved.value.hosted };
}
async function access(userId: string, id: string, required?: BoschDetailGrant) {
	return serialized(id, async () => {
		const current = await authorized(userId, id, required);
		if (!current) return null;
		const { hosted, saved } = current;
		if (hosted.grant.expiresAt < Date.now() + 30_000) {
			const refresh = hosted.grant.refreshToken;
			if (!refresh)
				throw new ConnectionHttpError(
					"Bosch login expired",
					"authorization_failed",
				);
			try {
				hosted.grant = await refreshBoschGrant(hosted.client, refresh);
			} catch (error) {
				if (
					error instanceof ConnectionHttpError &&
					error.code === "authorization_failed"
				)
					await updateConnection(
						userId,
						id,
						{ status: "needs_reauth", statusDetail: "Bosch sign-in expired" },
						saved.version,
					);
				throw error;
			}
			if (
				!(await updateConnection(
					userId,
					id,
					{ secret: JSON.stringify(saved.value) },
					saved.version,
				))
			)
				throw new Error("Bosch setup changed");
		}
		return {
			token: hosted.grant.accessToken,
			identity: hosted.authorizationId,
		};
	});
}
export async function readHostedBoschSummary(userId: string, id: string) {
	try {
		const current = await access(userId, id);
		if (!current) return false;
		const snapshot = {
			...(await collectBoschSnapshot(current.token)),
			syncedAt: Date.now(),
		};
		return await serialized(id, async () => {
			const latest = await authorized(userId, id);
			if (!latest || latest.hosted.authorizationId !== current.identity)
				return false;
			return Boolean(
				await updateConnection(
					userId,
					id,
					{ secret: JSON.stringify({ ...latest.saved.value, snapshot }) },
					latest.saved.version,
				),
			);
		});
	} catch {
		return false;
	}
}
export async function readHostedBoschDetail(
	userId: string,
	id: string,
	query: BoschDetailQuery,
): Promise<BoschDetailAnswer> {
	const required = requiredBoschGrant(query);
	try {
		const current = await access(userId, id, required);
		if (!current) return { status: "offline" as const };
		const result = await readBoschDetail(query, current.token);
		const latest = await authorized(userId, id, required);
		if (latest?.hosted.authorizationId !== current.identity)
			return { status: "offline" as const };
		return { status: "ready" as const, result };
	} catch (error) {
		if (
			error instanceof ConnectionHttpError &&
			(error.code === "consent_required" ||
				error.code === "access_denied" ||
				error.code === "not_found")
		)
			return { status: error.code };
		return { status: "unavailable" as const };
	}
}
