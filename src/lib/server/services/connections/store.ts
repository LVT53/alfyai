import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import type { ConnectionProvider } from "$lib/server/db/schema";
import { userConnections } from "$lib/server/db/schema";
import { decryptConnectionSecret, encryptConnectionSecret } from "./vault";

type ConnectionRow = typeof userConnections.$inferSelect;
type ConnectionStatus = "connected" | "needs_reauth" | "error" | "disconnected";

// Public DTO — NO secret fields. Fields are mapped explicitly below (never
// spread the raw row) so it is structurally impossible for a secret column
// to leak into this type.
export type ConnectionPublic = {
	id: string;
	userId: string;
	provider: ConnectionProvider;
	label: string;
	accountIdentifier: string;
	status: ConnectionStatus;
	statusDetail: string | null;
	defaultOn: boolean;
	allowWrites: boolean;
	writeAllowlist: string[];
	capabilities: string[];
	config: Record<string, unknown>;
	oauthScopes: string[];
	tokenExpiresAt: number | null;
	hasSecret: boolean;
	createdAt: number;
	updatedAt: number;
};

function parseJsonArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function parseJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function toEpochSeconds(date: Date): number {
	return Math.floor(date.getTime() / 1000);
}

// The ONLY place a raw row is turned into the public shape. Every field is
// named explicitly; secret columns are never touched here.
function toPublic(row: ConnectionRow): ConnectionPublic {
	return {
		id: row.id,
		userId: row.userId,
		provider: row.provider as ConnectionProvider,
		label: row.label,
		accountIdentifier: row.accountIdentifier,
		status: row.status as ConnectionStatus,
		statusDetail: row.statusDetail,
		defaultOn: row.defaultOn,
		allowWrites: row.allowWrites,
		writeAllowlist: parseJsonArray(row.writeAllowlistJson),
		capabilities: parseJsonArray(row.capabilitiesJson),
		config: parseJsonObject(row.configJson),
		oauthScopes: parseJsonArray(row.oauthScopesJson),
		tokenExpiresAt: row.tokenExpiresAt
			? toEpochSeconds(row.tokenExpiresAt)
			: null,
		hasSecret: row.secretCiphertext !== null,
		createdAt: toEpochSeconds(row.createdAt),
		updatedAt: toEpochSeconds(row.updatedAt),
	};
}

function scoped(userId: string, id: string) {
	return and(eq(userConnections.userId, userId), eq(userConnections.id, id));
}

export async function createConnection(params: {
	userId: string;
	provider: ConnectionProvider;
	label: string;
	accountIdentifier?: string;
	status?: ConnectionStatus;
	defaultOn?: boolean;
	allowWrites?: boolean;
	capabilities?: string[];
	writeAllowlist?: string[];
	config?: Record<string, unknown>;
	oauthScopes?: string[];
	secret?: string;
	tokenExpiresAt?: number | null;
}): Promise<ConnectionPublic> {
	const now = new Date();
	const secret = params.secret ? encryptConnectionSecret(params.secret) : null;
	const [row] = await db
		.insert(userConnections)
		.values({
			id: randomUUID(),
			userId: params.userId,
			provider: params.provider,
			label: params.label,
			accountIdentifier: params.accountIdentifier ?? "",
			status: params.status ?? "disconnected",
			defaultOn: params.defaultOn ?? false,
			allowWrites: params.allowWrites ?? false,
			writeAllowlistJson: JSON.stringify(params.writeAllowlist ?? []),
			capabilitiesJson: JSON.stringify(params.capabilities ?? []),
			configJson: JSON.stringify(params.config ?? {}),
			oauthScopesJson: JSON.stringify(params.oauthScopes ?? []),
			secretCiphertext: secret?.ciphertext ?? null,
			secretIv: secret?.iv ?? null,
			secretAuthTag: secret?.authTag ?? null,
			tokenExpiresAt:
				params.tokenExpiresAt != null
					? new Date(params.tokenExpiresAt * 1000)
					: null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toPublic(row);
}

export async function listConnectionsForUser(
	userId: string,
): Promise<ConnectionPublic[]> {
	const rows = await db
		.select()
		.from(userConnections)
		.where(eq(userConnections.userId, userId));
	return rows.map(toPublic);
}

export async function getConnection(
	userId: string,
	id: string,
): Promise<ConnectionPublic | null> {
	const [row] = await db
		.select()
		.from(userConnections)
		.where(scoped(userId, id));
	return row ? toPublic(row) : null;
}

export async function updateConnection(
	userId: string,
	id: string,
	patch: Partial<{
		label: string;
		accountIdentifier: string;
		status: ConnectionStatus;
		statusDetail: string | null;
		defaultOn: boolean;
		allowWrites: boolean;
		capabilities: string[];
		writeAllowlist: string[];
		config: Record<string, unknown>;
		oauthScopes: string[];
		tokenExpiresAt: number | null;
	}>,
): Promise<ConnectionPublic | null> {
	const set: Partial<typeof userConnections.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (patch.label !== undefined) set.label = patch.label;
	if (patch.accountIdentifier !== undefined) {
		set.accountIdentifier = patch.accountIdentifier;
	}
	if (patch.status !== undefined) set.status = patch.status;
	if (patch.statusDetail !== undefined) set.statusDetail = patch.statusDetail;
	if (patch.defaultOn !== undefined) set.defaultOn = patch.defaultOn;
	if (patch.allowWrites !== undefined) set.allowWrites = patch.allowWrites;
	if (patch.capabilities !== undefined) {
		set.capabilitiesJson = JSON.stringify(patch.capabilities);
	}
	if (patch.writeAllowlist !== undefined) {
		set.writeAllowlistJson = JSON.stringify(patch.writeAllowlist);
	}
	if (patch.config !== undefined) {
		set.configJson = JSON.stringify(patch.config);
	}
	if (patch.oauthScopes !== undefined) {
		set.oauthScopesJson = JSON.stringify(patch.oauthScopes);
	}
	if (patch.tokenExpiresAt !== undefined) {
		set.tokenExpiresAt =
			patch.tokenExpiresAt != null
				? new Date(patch.tokenExpiresAt * 1000)
				: null;
	}

	const [row] = await db
		.update(userConnections)
		.set(set)
		.where(scoped(userId, id))
		.returning();
	return row ? toPublic(row) : null;
}

export async function setConnectionSecret(
	userId: string,
	id: string,
	secret: string,
	tokenExpiresAt?: number | null,
): Promise<boolean> {
	const encrypted = encryptConnectionSecret(secret);
	const result = await db
		.update(userConnections)
		.set({
			secretCiphertext: encrypted.ciphertext,
			secretIv: encrypted.iv,
			secretAuthTag: encrypted.authTag,
			...(tokenExpiresAt !== undefined
				? {
						tokenExpiresAt:
							tokenExpiresAt != null ? new Date(tokenExpiresAt * 1000) : null,
					}
				: {}),
			updatedAt: new Date(),
		})
		.where(scoped(userId, id));
	return result.changes > 0;
}

// The ONLY read path for the plaintext secret. Never part of ConnectionPublic.
export async function getConnectionSecret(
	userId: string,
	id: string,
): Promise<string | null> {
	const [row] = await db
		.select({
			secretCiphertext: userConnections.secretCiphertext,
			secretIv: userConnections.secretIv,
			secretAuthTag: userConnections.secretAuthTag,
		})
		.from(userConnections)
		.where(scoped(userId, id));
	if (!row?.secretCiphertext || !row.secretIv || !row.secretAuthTag) {
		return null;
	}
	return decryptConnectionSecret({
		ciphertext: row.secretCiphertext,
		iv: row.secretIv,
		authTag: row.secretAuthTag,
	});
}

export async function deleteConnection(
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db.delete(userConnections).where(scoped(userId, id));
	return result.changes > 0;
}

export async function setAllowWrites(
	userId: string,
	id: string,
	allow: boolean,
): Promise<ConnectionPublic | null> {
	const [row] = await db
		.update(userConnections)
		.set({ allowWrites: allow, updatedAt: new Date() })
		.where(scoped(userId, id))
		.returning();
	return row ? toPublic(row) : null;
}

export async function setDefaultOn(
	userId: string,
	id: string,
	on: boolean,
): Promise<ConnectionPublic | null> {
	const [row] = await db
		.update(userConnections)
		.set({ defaultOn: on, updatedAt: new Date() })
		.where(scoped(userId, id))
		.returning();
	return row ? toPublic(row) : null;
}

export async function setEnabledCapabilities(
	userId: string,
	id: string,
	caps: string[],
): Promise<ConnectionPublic | null> {
	const [row] = await db
		.update(userConnections)
		.set({ capabilitiesJson: JSON.stringify(caps), updatedAt: new Date() })
		.where(scoped(userId, id))
		.returning();
	return row ? toPublic(row) : null;
}
