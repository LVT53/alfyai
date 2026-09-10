import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import type { ConnectionProvider } from "$lib/server/db/schema";
import { userConnections } from "$lib/server/db/schema";
import { grantedCapabilitiesFor } from "./granted";
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
	// Connections redesign — what the PROVIDER granted, as opposed to
	// `capabilities`, which is what the user has switched on. Derived (never
	// stored): see granted.ts. A capability in the provider's catalogue but
	// absent here was denied, and the settings dialog renders it as a greyed
	// line with "Ask again" instead of a switch with nothing behind it.
	//
	// Optional purely so the many hand-built fixtures that stand in for a
	// connection in tests don't all have to restate three presentational
	// fields they never read. toPublic — the only real producer — always
	// populates it; read it through grantedCapabilitiesOf() on the client,
	// which falls back to the provider's whole catalogue.
	grantedCapabilities?: string[];
	config: Record<string, unknown>;
	oauthScopes: string[];
	tokenExpiresAt: number | null;
	hasSecret: boolean;
	// Issue 6.4 — true iff a SEPARATE write-scoped secret has been provisioned
	// (e.g. Immich's "enable writes" flow minted+stored a write-scoped API
	// key). Deliberately a boolean derived from presence, never the secret
	// itself — same posture as hasSecret above.
	hasWriteSecret: boolean;
	// Connections redesign — the "and when" half of every status sentence.
	// null when a connection has never been read through (lastUsedAt) or has
	// never changed status since it was created (statusChangedAt); the UI
	// falls back to a sentence that doesn't name a time rather than inventing
	// one from `updatedAt`, which also moves for unrelated edits. Optional for
	// the same fixture reason as grantedCapabilities above.
	lastUsedAt?: number | null;
	statusChangedAt?: number | null;
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
	const capabilities = parseJsonArray(row.capabilitiesJson);
	const config = parseJsonObject(row.configJson);
	const oauthScopes = parseJsonArray(row.oauthScopesJson);
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
		capabilities,
		grantedCapabilities: grantedCapabilitiesFor({
			provider: row.provider as ConnectionProvider,
			oauthScopes,
			capabilities,
			config,
		}),
		config,
		oauthScopes,
		tokenExpiresAt: row.tokenExpiresAt
			? toEpochSeconds(row.tokenExpiresAt)
			: null,
		hasSecret: row.secretCiphertext !== null,
		hasWriteSecret: row.writeSecretCiphertext !== null,
		lastUsedAt: row.lastUsedAt ? toEpochSeconds(row.lastUsedAt) : null,
		statusChangedAt: row.statusChangedAt
			? toEpochSeconds(row.statusChangedAt)
			: null,
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

// Looks up a connection by its natural key (matches the
// user_connections_user_provider_account_unique index) — used to upsert
// instead of colliding on re-connect flows.
export async function findConnectionByAccount(
	userId: string,
	provider: ConnectionProvider,
	accountIdentifier: string,
): Promise<ConnectionPublic | null> {
	const [row] = await db
		.select()
		.from(userConnections)
		.where(
			and(
				eq(userConnections.userId, userId),
				eq(userConnections.provider, provider),
				eq(userConnections.accountIdentifier, accountIdentifier),
			),
		);
	return row ? toPublic(row) : null;
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
	const now = new Date();
	const set: Partial<typeof userConnections.$inferInsert> = {
		updatedAt: now,
	};
	if (patch.label !== undefined) set.label = patch.label;
	if (patch.accountIdentifier !== undefined) {
		set.accountIdentifier = patch.accountIdentifier;
	}
	if (patch.status !== undefined) {
		// Connections redesign — statusChangedAt answers "when did this break /
		// come back?", which `updatedAt` cannot: a capability toggle moves that
		// too. Stamped only on a REAL transition, so a health check that keeps
		// re-confirming "connected" (or a provider that keeps re-reporting the
		// same failure) doesn't keep pushing the date forward and turn "stopped
		// working on 8 September" into "stopped working seconds ago".
		const [current] = await db
			.select({ status: userConnections.status })
			.from(userConnections)
			.where(scoped(userId, id));
		if (current && current.status !== patch.status) {
			set.statusChangedAt = now;
		}
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

// Issue 6.4 — sets the SEPARATE write-scoped secret (distinct columns from
// setConnectionSecret's primary secret; see schema.ts's doc comment on
// writeSecretCiphertext). Encrypted via the same vault/key derivation as the
// primary secret — there is no separate encryption key per secret kind, only
// separate storage columns so both can coexist.
export async function setConnectionWriteSecret(
	userId: string,
	id: string,
	secret: string,
): Promise<boolean> {
	const encrypted = encryptConnectionSecret(secret);
	const result = await db
		.update(userConnections)
		.set({
			writeSecretCiphertext: encrypted.ciphertext,
			writeSecretIv: encrypted.iv,
			writeSecretAuthTag: encrypted.authTag,
			updatedAt: new Date(),
		})
		.where(scoped(userId, id));
	return result.changes > 0;
}

// The ONLY read path for the plaintext write-scoped secret. Never part of
// ConnectionPublic (only the derived `hasWriteSecret` boolean is) — same
// posture as getConnectionSecret for the primary secret.
export async function getConnectionWriteSecret(
	userId: string,
	id: string,
): Promise<string | null> {
	const [row] = await db
		.select({
			writeSecretCiphertext: userConnections.writeSecretCiphertext,
			writeSecretIv: userConnections.writeSecretIv,
			writeSecretAuthTag: userConnections.writeSecretAuthTag,
		})
		.from(userConnections)
		.where(scoped(userId, id));
	if (
		!row?.writeSecretCiphertext ||
		!row.writeSecretIv ||
		!row.writeSecretAuthTag
	) {
		return null;
	}
	return decryptConnectionSecret({
		ciphertext: row.writeSecretCiphertext,
		iv: row.writeSecretIv,
		authTag: row.writeSecretAuthTag,
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

// Issue 7.1 — persists the (already-validated/normalized by the caller)
// write-allowlist root paths for a path-based writable provider (e.g.
// nextcloud). Mirrors setAllowWrites/setDefaultOn/setEnabledCapabilities:
// user-scoped via `scoped`, returns null (no-op) for another user's id.
export async function setWriteAllowlist(
	userId: string,
	id: string,
	paths: string[],
): Promise<ConnectionPublic | null> {
	const [row] = await db
		.update(userConnections)
		.set({ writeAllowlistJson: JSON.stringify(paths), updatedAt: new Date() })
		.where(scoped(userId, id))
		.returning();
	return row ? toPublic(row) : null;
}

// Connections redesign — stamps "a tool just read through this connection" so
// the settings row can say "Last used 12 minutes ago" instead of showing a
// healthy connection with no indicator at all. Called fire-and-forget from
// withCapabilityConnection (capability-read.ts), i.e. at the one moment a
// connection is genuinely used, not merely listed.
//
// Deliberately does NOT touch `updatedAt`: a read is not an edit, and moving
// updatedAt here would make every chat turn look like a settings change.
// Throttled to at most one write per connection per throttleSeconds so a
// multi-tool turn doesn't issue one UPDATE per tool call.
export const LAST_USED_THROTTLE_SECONDS = 60;

export async function touchConnectionUsed(
	userId: string,
	id: string,
	options: { now?: Date; throttleSeconds?: number } = {},
): Promise<void> {
	const now = options.now ?? new Date();
	const throttleSeconds = options.throttleSeconds ?? LAST_USED_THROTTLE_SECONDS;
	const [current] = await db
		.select({ lastUsedAt: userConnections.lastUsedAt })
		.from(userConnections)
		.where(scoped(userId, id));
	if (!current) return;
	if (
		current.lastUsedAt &&
		now.getTime() - current.lastUsedAt.getTime() < throttleSeconds * 1000
	) {
		return;
	}
	await db
		.update(userConnections)
		.set({ lastUsedAt: now })
		.where(scoped(userId, id));
}
