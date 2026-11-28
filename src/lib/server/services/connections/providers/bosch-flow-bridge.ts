import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { registerConnectionAdapter } from "../adapters";
import {
	createConnection,
	findConnectionByAccount,
	getConnection,
	getConnectionSecretSnapshot,
	mergeConnectionConfig,
	updateConnection,
} from "../store";
import {
	type BoschDetailAnswer,
	type BoschDetailQuery,
	parseBoschDetailQuery,
	parseBoschDetailResult,
	requiredBoschGrant,
} from "./bosch-flow-details";

import {
	readHostedBoschDetail,
	readHostedBoschSummary,
	refreshHostedBoschInventory,
} from "./bosch-flow-hosted";

import { bikeNameKey, savedBikeName } from "./bosch-flow-names";

const rideId = z.string().min(1).max(150);
const instant = z.iso.datetime({ offset: true });
const upload = z
	.object({
		bikes: z
			.array(
				z
					.object({
						id: rideId.nullable(),
						name: z.string().max(180).nullable(),
					})
					.strict(),
			)
			.max(50),
		rides: z
			.array(
				z
					.object({
						id: rideId,
						bikeId: rideId.optional(),
						startTime: instant,
						endTime: instant.nullable(),
						distanceMeters: z.number().nonnegative().nullable(),
					})
					.strict(),
			)
			.max(2000),
		complete: z.boolean(),
	})
	.strict();

function digest(value: string) {
	return createHash("sha256").update(value).digest();
}

export class BoschPairingConflict extends Error {}

export async function pairBoschBridge(userId: string) {
	const secret = randomBytes(32).toString("base64url");
	const prior = await findConnectionByAccount(userId, "bosch", "personal");
	const priorData = prior
		? await getConnectionSecretSnapshot(userId, prior.id)
		: null;
	const previous = priorData ? JSON.parse(priorData.value) : null;
	const awaitingConsent = !prior || previous?.awaitingConsent === true;
	const encryptedValue = JSON.stringify({
		keyHash: digest(secret).toString("hex"),
		snapshot: previous?.snapshot ?? null,
		...(awaitingConsent ? { awaitingConsent: true } : {}),
	});
	const connection = prior
		? await updateConnection(
				userId,
				prior.id,
				{
					secret: encryptedValue,
					status: awaitingConsent ? "disconnected" : "connected",
				},
				priorData?.version,
			)
		: await createConnection({
				userId,
				provider: "bosch",
				accountIdentifier: "personal",
				label: "Bosch eBike Flow",
				status: "disconnected",
				defaultOn: true,
				capabilities: ["cycling"],
				secret: encryptedValue,
			}).catch(async (error: unknown) => {
				if (await findConnectionByAccount(userId, "bosch", "personal"))
					throw new BoschPairingConflict("Pairing changed during setup");
				throw error;
			});
	if (!connection)
		throw new BoschPairingConflict("Pairing changed during setup");
	return {
		connectionId: connection.id,
		pairingToken: [
			Buffer.from(userId).toString("base64url"),
			connection.id,
			secret,
		].join("."),
	};
}

type PendingRead = {
	id: string;
	keyHash: string;
	finished: Promise<boolean>;
	finish: (fresh: boolean) => void;
};
// The production web service is a single Node process. Unanswered questions
// expire promptly; credentials and ride data do not live in this map.
const reads = new Map<string, PendingRead>();
const inventoryReads = new Map<string, PendingRead>();
type PendingDetail = {
	id: string;
	connectionId: string;
	keyHash: string;
	query: BoschDetailQuery;
	finished: Promise<BoschDetailAnswer>;
	finish: (answer: BoschDetailAnswer) => void;
};
const detailReads = new Map<string, PendingDetail>();
const heartbeats = new Map<
	string,
	{
		time: number;
		keyHash: string;
		grants: Set<string>;
		inventorySupported: boolean;
		lastLegacyRefresh: number;
	}
>();

async function authenticateBridge(bearer: string) {
	const parts = /^([\w-]{1,180})\.([\w-]{1,128})\.([\w-]{43})$/.exec(bearer);
	if (!parts) return null;
	const userId = Buffer.from(parts[1], "base64url").toString();
	const id = parts[2];
	const connection = await getConnection(userId, id);
	if (
		connection?.provider !== "bosch" ||
		(connection.status !== "connected" &&
			connection.status !== "disconnected") ||
		!connection.capabilities.includes("cycling")
	)
		return null;
	const existing = await getConnectionSecretSnapshot(userId, id);
	if (!existing) return null;
	const saved = JSON.parse(existing.value);
	if (
		typeof saved.keyHash !== "string" ||
		(connection.status === "disconnected" && saved.awaitingConsent !== true)
	)
		return null;
	const storedHash = Buffer.from(saved.keyHash, "hex");
	if (
		storedHash.length !== 32 ||
		!timingSafeEqual(digest(parts[3]), storedHash)
	)
		return null;
	return { userId, id, existing, saved };
}

export async function pollBoschQuestion(
	bearer: string,
	failed: string | null,
	protocol: string | null = null,
	grantHeader: string | null = null,
	failureCode: string | null = null,
	inventoryHeader: string | null = null,
) {
	const auth = await authenticateBridge(bearer);
	if (!auth) return null;
	// The helper polls only after the rider allows on-demand questions. A pairing
	// code on its own grants no access. Leave the rider's default switch as set.
	if (
		auth.saved.awaitingConsent &&
		!(await updateConnection(
			auth.userId,
			auth.id,
			{
				status: "connected",
				secret: JSON.stringify({
					keyHash: auth.saved.keyHash,
					snapshot: auth.saved.snapshot,
				}),
			},
			auth.existing.version,
		))
	) {
		// A simultaneous upload or renewal changed the secret. Re-check it on the next poll.
		return { requestId: null, retryAfterMs: 1000 };
	}
	const now = Date.now();
	for (const [key, beat] of heartbeats) {
		if (now - beat.time > 12000) heartbeats.delete(key);
	}
	const grants = new Set(
		protocol === "2" ? (grantHeader ?? "").split(",").map((g) => g.trim()) : [],
	);
	const previous = heartbeats.get(auth.id);
	const inventorySupported = inventoryHeader === "1";
	heartbeats.set(auth.id, {
		time: now,
		keyHash: auth.saved.keyHash,
		grants,
		inventorySupported,
		lastLegacyRefresh:
			previous && previous.keyHash === auth.saved.keyHash
				? previous.lastLegacyRefresh
				: 0,
	});
	const inventory = inventoryReads.get(auth.id);
	if (inventory) {
		if (inventory.keyHash !== auth.saved.keyHash || !inventorySupported) {
			inventory.finish(false);
		} else if (failed === inventory.id) {
			if (failureCode === "access_denied") {
				// An authenticated denial supersedes the rider's earlier sharing state.
				await updateConnection(
					auth.userId,
					auth.id,
					{
						secret: JSON.stringify({
							...auth.saved,
							snapshot: null,
							bikeInventory: null,
						}),
					},
					auth.existing.version,
				);
			}
			inventory.finish(false);
		}
	}
	for (const pending of detailReads.values()) {
		if (pending.connectionId !== auth.id) continue;
		if (
			pending.keyHash !== auth.saved.keyHash ||
			!grants.has(requiredBoschGrant(pending.query))
		) {
			pending.finish({ status: "consent_required" });
		} else if (failed === pending.id) {
			pending.finish({
				status:
					failureCode === "access_denied" || failureCode === "not_found"
						? failureCode
						: "unavailable",
			});
		}
	}
	const read = reads.get(auth.id);
	if (!read || read.keyHash !== auth.saved.keyHash) {
		const detail = Array.from(detailReads.values()).find(
			(p) => p.connectionId === auth.id,
		);
		return detail
			? { requestId: detail.id, query: detail.query, retryAfterMs: 1000 }
			: inventory && inventoryReads.get(auth.id) === inventory
				? { requestId: inventory.id, inventoryOnly: true, retryAfterMs: 1000 }
				: { requestId: null, retryAfterMs: 2000 };
	}
	if (failed === read.id) {
		read.finish(false);
		return { requestId: null, retryAfterMs: 2000 };
	}
	return { requestId: read.id, retryAfterMs: 2000 };
}

export async function acceptBoschUpload(
	bearer: string,
	readBody: () => Promise<unknown>,
	requestId: string | null = null,
) {
	const auth = await authenticateBridge(bearer);
	if (!auth) return 401;
	const { userId, id, existing, saved } = auth;
	const detail = requestId ? detailReads.get(requestId) : null;
	if (detail) {
		if (detail.connectionId !== id || detail.keyHash !== saved.keyHash)
			return 409;
		const body = await readBody();
		if (
			typeof body !== "object" ||
			!body ||
			Object.keys(body).length !== 2 ||
			!("query" in body) ||
			!("result" in body)
		)
			return 400;
		const query = parseBoschDetailQuery(body.query);
		if (!query || JSON.stringify(query) !== JSON.stringify(detail.query))
			return 400;
		const result = parseBoschDetailResult(query, body.result);
		if (!result) return 400;
		const current = await authenticateBridge(bearer);
		if (
			!current ||
			detailReads.get(detail.id) !== detail ||
			!heartbeats.get(id)?.grants.has(requiredBoschGrant(query))
		)
			return 409;
		detail.finish({ status: "ready", result });
		return 204;
	}
	const inventory = inventoryReads.get(id);
	if (inventory && requestId === inventory.id) {
		if (inventory.keyHash !== saved.keyHash) return 409;
		const data = upload.pick({ bikes: true }).safeParse(await readBody());
		if (!data.success) return 400;
		if (inventoryReads.get(id) !== inventory) return 409;
		const bikeInventory = { bikes: data.data.bikes, syncedAt: Date.now() };
		const currentIds = new Set(bikeInventory.bikes.map((bike) => bike.id));
		// A removed bike's rides must not outlive its sharing permission in the cache.
		const previousBikes = upload.shape.bikes.safeParse(saved.snapshot?.bikes);
		const revoked =
			saved.snapshot &&
			(!previousBikes.success ||
				currentIds.size === 0 ||
				previousBikes.data.some((bike) => !currentIds.has(bike.id)));
		const updated = await updateConnection(
			userId,
			id,
			{
				secret: JSON.stringify({
					...saved,
					bikeInventory,
					...(revoked ? { snapshot: null } : {}),
				}),
			},
			existing.version,
		);
		if (!updated) return 409;
		inventory.finish(true);
		return 204;
	}
	const read = reads.get(id);
	if (requestId && (read?.id !== requestId || read.keyHash !== saved.keyHash))
		return 409;
	const data = upload.safeParse(await readBody());
	if (!data.success) return 400;
	if (requestId && reads.get(id) !== read) return 409;
	const snapshot = { ...data.data, syncedAt: Date.now() };
	const updated = await updateConnection(
		userId,
		id,
		{
			secret: JSON.stringify({ keyHash: saved.keyHash, snapshot }),
			...(saved.awaitingConsent ? { status: "connected" as const } : {}),
		},
		existing.version,
	);
	if (!updated) return 409;
	if (read && requestId === read.id) read.finish(true);
	return 204;
}

async function readBikeInventory(userId: string, connectionId: string) {
	const connection = await getConnection(userId, connectionId);
	if (
		connection?.provider !== "bosch" ||
		connection.status !== "connected" ||
		!connection.capabilities.includes("cycling")
	)
		return null;
	const data = await getConnectionSecretSnapshot(userId, connectionId);
	if (!data) return null;
	const schema = upload.extend({ syncedAt: z.number().int() });
	const result = schema.safeParse(JSON.parse(data.value).snapshot);
	return result.success
		? { connection, version: data.version, snapshot: result.data }
		: null;
}

export async function readBoschSnapshot(userId: string, connectionId: string) {
	const inventory = await readBikeInventory(userId, connectionId);
	if (!inventory) return null;
	const { connection, snapshot } = inventory;
	const bikes = snapshot.bikes.map((bike) => ({
		...bike,
		name: savedBikeName(connection.config, bike.id) ?? bike.name,
	}));
	const names = new Map(bikes.map((bike) => [bike.id, bike.name]));
	const rides = snapshot.rides.map((ride) => {
		const bikeName = ride.bikeId && names.get(ride.bikeId);
		return bikeName ? { ...ride, bikeName } : ride;
	});
	return { ...snapshot, bikes, rides };
}

async function namingInventory(userId: string, refreshHelper: boolean) {
	const connection = await findConnectionByAccount(userId, "bosch", "personal");
	if (
		connection?.status !== "connected" ||
		!connection.capabilities.includes("cycling")
	)
		return null;
	const before = await getConnectionSecretSnapshot(userId, connection.id);
	if (!before) return null;
	const { hosted, keyHash } = JSON.parse(before.value);
	if (hosted) {
		if (!(await refreshHostedBoschInventory(userId, connection.id)))
			return null;
	} else if (refreshHelper) {
		await refreshBoschHelperInventory(userId, connection.id);
	}
	const latest = await getConnection(userId, connection.id);
	if (
		latest?.status !== "connected" ||
		!latest.capabilities.includes("cycling")
	)
		return null;
	const data = await getConnectionSecretSnapshot(userId, connection.id);
	if (!data) return null;
	const saved = JSON.parse(data.value);
	if (
		hosted
			? saved.hosted?.authorizationId !== hosted.authorizationId
			: saved.keyHash !== keyHash
	)
		return null;
	// A complete upload supersedes bikeInventory. An inventory-only read can
	// arrive before this account has ever shared any ride history.
	const bikes = upload.shape.bikes.safeParse(
		(saved.bikeInventory ?? saved.snapshot)?.bikes,
	);
	return bikes.success
		? { connection: latest, version: data.version, bikes: bikes.data }
		: null;
}

export async function listBoschBikesForNaming(userId: string) {
	const inventory = await namingInventory(userId, true);
	if (!inventory) return null;
	const ids = new Set(inventory.bikes.map((bike) => bike.id));
	return Array.from(ids).flatMap((id) =>
		id ? [{ id, name: savedBikeName(inventory.connection.config, id) }] : [],
	);
}

export async function nameBoschBike(
	userId: string,
	bikeId: string,
	name: string,
) {
	const inventory = await namingInventory(userId, false);
	if (!inventory?.bikes.some((bike) => bike.id === bikeId)) return false;
	return mergeConnectionConfig(
		userId,
		inventory.connection.id,
		inventory.version,
		{
			bikeNames: { [bikeNameKey(bikeId)]: name || null },
		},
	);
}

export async function loadBoschForQuestion(userId: string, id: string) {
	const connection = await getConnection(userId, id);
	if (
		connection?.provider !== "bosch" ||
		connection.status !== "connected" ||
		!connection.capabilities.includes("cycling")
	)
		return { snapshot: null, fresh: false };
	const grant = await getConnectionSecretSnapshot(userId, id);
	if (!grant) return { snapshot: null, fresh: false };
	const { hosted, keyHash } = JSON.parse(grant.value);
	if (hosted) {
		const fresh = await readHostedBoschSummary(userId, id);
		const snapshot = await readBoschSnapshot(userId, id);
		return { snapshot, fresh: fresh && snapshot !== null };
	}
	const recentlyOnline = Date.now() - (heartbeats.get(id)?.time ?? 0) <= 12000;
	if (!recentlyOnline)
		return { snapshot: await readBoschSnapshot(userId, id), fresh: false };

	const fresh = await requestHelperRead(reads, id, keyHash);
	const snapshot = await readBoschSnapshot(userId, id);
	return { snapshot, fresh: fresh && snapshot !== null };
}

function requestHelperRead(
	queue: Map<string, PendingRead>,
	id: string,
	keyHash: string,
) {
	let pending = queue.get(id);
	if (!pending || pending.keyHash !== keyHash) {
		pending?.finish(false);
		const requestId = randomUUID();
		let resolve!: (fresh: boolean) => void;
		const finished = new Promise<boolean>((done) => {
			resolve = done;
		});
		const finish = (fresh: boolean) => {
			if (queue.get(id)?.id !== requestId) return;
			clearTimeout(timeout);
			queue.delete(id);
			resolve(fresh);
		};
		const timeout = setTimeout(() => finish(false), 15000);
		pending = { id: requestId, keyHash, finished, finish };
		queue.set(id, pending);
	}
	return pending.finished;
}

async function refreshBoschHelperInventory(userId: string, id: string) {
	const grant = await getConnectionSecretSnapshot(userId, id);
	const beat = heartbeats.get(id);
	if (
		!beat ||
		Date.now() - beat.time > 12_000 ||
		!grant ||
		JSON.parse(grant.value).keyHash !== beat.keyHash
	)
		return;
	const fullRead = reads.get(id);
	if (fullRead?.keyHash === beat.keyHash) {
		await fullRead.finished;
		return;
	}
	if (beat.inventorySupported) {
		await requestHelperRead(inventoryReads, id, beat.keyHash);
	} else if (Date.now() - beat.lastLegacyRefresh >= 60_000) {
		// Original helpers upload ride history with the inventory. Bound that cost.
		beat.lastLegacyRefresh = Date.now();
		await requestHelperRead(reads, id, beat.keyHash);
	}
}

// Details answer only the question that requested them. No detailed response is
// written to the saved summary, served to another rider, or reused offline.
export async function loadBoschDetailForQuestion(
	userId: string,
	id: string,
	input: BoschDetailQuery,
): Promise<BoschDetailAnswer> {
	const query = parseBoschDetailQuery(input);
	if (!query) return { status: "unavailable" };
	const conn = await getConnection(userId, id);
	if (
		conn?.provider !== "bosch" ||
		conn.status !== "connected" ||
		!conn.capabilities.includes("cycling")
	)
		return { status: "offline" };
	const beat = heartbeats.get(id);
	const grant = await getConnectionSecretSnapshot(userId, id);
	if (grant && JSON.parse(grant.value).hosted)
		return readHostedBoschDetail(userId, id, query);
	if (
		!beat ||
		Date.now() - beat.time > 12000 ||
		!grant ||
		JSON.parse(grant.value).keyHash !== beat.keyHash
	)
		return { status: "offline" };
	if (!beat.grants.has(requiredBoschGrant(query)))
		return { status: "consent_required" };
	const active = Array.from(detailReads.values()).filter(
		(p) => p.connectionId === id && p.keyHash === beat.keyHash,
	);
	const existing = active.find(
		(p) => JSON.stringify(p.query) === JSON.stringify(query),
	);
	if (existing) return existing.finished;
	if (active.length >= 4) return { status: "unavailable" };
	const requestId = randomUUID();
	let resolve!: (answer: BoschDetailAnswer) => void;
	const finished = new Promise<BoschDetailAnswer>((done) => {
		resolve = done;
	});
	const finish = (answer: BoschDetailAnswer) => {
		clearTimeout(timeout);
		detailReads.delete(requestId);
		resolve(answer);
	};
	const timeout = setTimeout(() => finish({ status: "unavailable" }), 15000);
	detailReads.set(requestId, {
		id: requestId,
		connectionId: id,
		keyHash: beat.keyHash,
		query,
		finished,
		finish,
	});
	return finished;
}

registerConnectionAdapter({
	provider: "bosch",
	async checkHealth(secret, connection) {
		const saved = JSON.parse(secret);
		if (saved?.hosted?.grant?.refreshToken) {
			if (connection?.status === "needs_reauth")
				return { status: "needs_reauth", detail: "Bosch sign-in expired" };
			return { status: "connected", detail: null };
		}
		const keyHash = saved?.keyHash;
		return typeof keyHash === "string" && /^[a-f0-9]{64}$/.test(keyHash)
			? { status: "connected", detail: null }
			: { status: "needs_reauth", detail: "Pair the rider helper again" };
	},
});
