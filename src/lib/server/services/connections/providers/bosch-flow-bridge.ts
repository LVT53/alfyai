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
	updateConnection,
} from "../store";

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
	const previousSnapshot = priorData
		? JSON.parse(priorData.value).snapshot
		: null;
	const encryptedValue = JSON.stringify({
		keyHash: digest(secret).toString("hex"),
		snapshot: previousSnapshot,
	});
	const connection = prior
		? await updateConnection(
				userId,
				prior.id,
				{ secret: encryptedValue, status: "connected" },
				priorData?.version,
			)
		: await createConnection({
				userId,
				provider: "bosch",
				accountIdentifier: "personal",
				label: "Bosch eBike Flow",
				status: "connected",
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
const heartbeats = new Map<string, number>();

async function authenticateBridge(bearer: string) {
	const parts = /^([\w-]{1,180})\.([\w-]{1,128})\.([\w-]{43})$/.exec(bearer);
	if (!parts) return null;
	const userId = Buffer.from(parts[1], "base64url").toString();
	const id = parts[2];
	const connection = await getConnection(userId, id);
	if (connection?.provider !== "bosch" || connection.status !== "connected")
		return null;
	const existing = await getConnectionSecretSnapshot(userId, id);
	if (!existing) return null;
	const saved = JSON.parse(existing.value);
	const storedHash = Buffer.from(saved.keyHash, "hex");
	if (
		storedHash.length !== 32 ||
		!timingSafeEqual(digest(parts[3]), storedHash)
	)
		return null;
	return { userId, id, existing, saved };
}

export async function pollBoschQuestion(bearer: string, failed: string | null) {
	const auth = await authenticateBridge(bearer);
	if (!auth) return null;
	const now = Date.now();
	for (const [key, time] of heartbeats) {
		if (now - time > 12000) heartbeats.delete(key);
	}
	heartbeats.set(auth.id, now);
	const read = reads.get(auth.id);
	if (!read || read.keyHash !== auth.saved.keyHash)
		return { requestId: null, retryAfterMs: 2000 };
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
		{ secret: JSON.stringify({ keyHash: saved.keyHash, snapshot }) },
		existing.version,
	);
	if (!updated) return 409;
	if (read && requestId === read.id) read.finish(true);
	return 204;
}

export async function readBoschSnapshot(userId: string, connectionId: string) {
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
	return result.success ? result.data : null;
}

export async function loadBoschForQuestion(userId: string, id: string) {
	const connection = await getConnection(userId, id);
	if (
		connection?.provider !== "bosch" ||
		connection.status !== "connected" ||
		!connection.capabilities.includes("cycling")
	)
		return { snapshot: null, fresh: false };
	const recentlyOnline = Date.now() - (heartbeats.get(id) ?? 0) <= 12000;
	if (!recentlyOnline)
		return { snapshot: await readBoschSnapshot(userId, id), fresh: false };
	const grant = await getConnectionSecretSnapshot(userId, id);
	if (!grant) return { snapshot: null, fresh: false };
	const { keyHash } = JSON.parse(grant.value);
	let pending = reads.get(id);
	if (!pending || pending.keyHash !== keyHash) {
		pending?.finish(false);
		const requestId = randomUUID();
		let resolve!: (fresh: boolean) => void;
		const finished = new Promise<boolean>((done) => {
			resolve = done;
		});
		const finish = (fresh: boolean) => {
			if (reads.get(id)?.id !== requestId) return;
			clearTimeout(timeout);
			reads.delete(id);
			resolve(fresh);
		};
		const timeout = setTimeout(() => finish(false), 15000);
		pending = { id: requestId, keyHash, finished, finish };
		reads.set(id, pending);
	}
	const fresh = await pending.finished;
	const snapshot = await readBoschSnapshot(userId, id);
	return { snapshot, fresh: fresh && snapshot !== null };
}

registerConnectionAdapter({
	provider: "bosch",
	async checkHealth(secret) {
		const keyHash = JSON.parse(secret)?.keyHash;
		return typeof keyHash === "string" && /^[a-f0-9]{64}$/.test(keyHash)
			? { status: "connected", detail: null }
			: { status: "needs_reauth", detail: "Pair the rider helper again" };
	},
});
