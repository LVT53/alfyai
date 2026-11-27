import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
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

export async function acceptBoschUpload(
	bearer: string,
	readBody: () => Promise<unknown>,
) {
	const parts = /^([\w-]{1,180})\.([\w-]{1,128})\.([\w-]{43})$/.exec(bearer);
	if (!parts) return 401;
	const userId = Buffer.from(parts[1], "base64url").toString();
	const id = parts[2];
	const connection = await getConnection(userId, id);
	if (connection?.provider !== "bosch" || connection.status !== "connected")
		return 401;
	const existing = await getConnectionSecretSnapshot(userId, id);
	if (!existing) return 401;
	const saved = JSON.parse(existing.value);
	const storedHash = Buffer.from(saved.keyHash, "hex");
	if (
		storedHash.length !== 32 ||
		!timingSafeEqual(digest(parts[3]), storedHash)
	)
		return 401;
	const data = upload.safeParse(await readBody());
	if (!data.success) return 400;
	const snapshot = { ...data.data, syncedAt: Date.now() };
	return (await updateConnection(
		userId,
		id,
		{ secret: JSON.stringify({ keyHash: saved.keyHash, snapshot }) },
		existing.version,
	))
		? 204
		: 409;
}

export async function readBoschSnapshot(userId: string, connectionId: string) {
	const connection = await getConnection(userId, connectionId);
	if (connection?.provider !== "bosch" || connection.status !== "connected")
		return null;
	const data = await getConnectionSecretSnapshot(userId, connectionId);
	if (!data) return null;
	const schema = upload.extend({ syncedAt: z.number().int() });
	const result = schema.safeParse(JSON.parse(data.value).snapshot);
	return result.success ? result.data : null;
}
