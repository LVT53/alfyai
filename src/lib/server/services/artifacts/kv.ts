// An App's stored state — what slice 2's `window.alfy.storage` bridge reads
// and writes — as scoped accessors over `artifact_kv`.
//
// A key-value row has NO user column, so a table-level accessor could be
// handed an artifact id that came from anywhere. That is why these four exist
// and why each one begins with `readScopedArtifactRow`: the artifact is
// resolved through the user's ownership scope first, and every refusal —
// another user's id, an incognito App read from outside, an artifact that is
// not an App — is the accessor's empty value (`null` / `false` / `[]`), never
// a throw. Slice 2 adds the route and the postMessage bridge on top of these;
// it must not add a fifth accessor.
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactKv } from "$lib/server/db/schema";
import {
	ARTIFACT_KV_KEY_MAX_CHARS,
	ARTIFACT_KV_MAX_KEYS,
	ARTIFACT_KV_TOTAL_MAX_BYTES,
	ARTIFACT_KV_VALUE_MAX_BYTES,
} from "./limits";
import {
	type ArtifactRow,
	kindForArtifactRow,
	readScopedArtifactRow,
} from "./record";
import type { ArtifactKvRow, ArtifactScopeOptions } from "./types";

type KvTarget = { userId: string; artifactId: string } & ArtifactScopeOptions;

/** The scoped read, narrowed to an App: storage is an App's and nothing else's. */
async function readScopedApp(params: KvTarget): Promise<ArtifactRow | null> {
	const artifact = await readScopedArtifactRow(params);
	return artifact && kindForArtifactRow(artifact) === "app" ? artifact : null;
}

function isValidKey(key: string): boolean {
	return key.length > 0 && Array.from(key).length <= ARTIFACT_KV_KEY_MAX_CHARS;
}

function isValidValueJson(valueJson: string): boolean {
	if (Buffer.byteLength(valueJson, "utf8") > ARTIFACT_KV_VALUE_MAX_BYTES) {
		return false;
	}
	try {
		JSON.parse(valueJson);
		return true;
	} catch {
		return false;
	}
}

export async function getKv(
	params: KvTarget & { key: string },
): Promise<string | null> {
	const app = await readScopedApp(params);
	if (!app) return null;
	const [row] = await db
		.select({ valueJson: artifactKv.valueJson })
		.from(artifactKv)
		.where(
			and(eq(artifactKv.artifactId, app.id), eq(artifactKv.key, params.key)),
		)
		.limit(1);
	return row?.valueJson ?? null;
}

/**
 * Upsert. Refuses (`false`) a key over the length cap, a value over the byte
 * cap or not JSON, a NEW key once the App holds the key cap (updating an
 * existing key never counts against that cap), and — ruling 48 — any write
 * whose resulting SUM of value bytes for the artifact would exceed
 * `ARTIFACT_KV_TOTAL_MAX_BYTES`. The sum is computed inside this same
 * transaction, so two concurrent writers cannot each slip a value past the
 * total independently; the worst case under a race is one value over the cap,
 * bounded by a single write, with no cross-user effect and the per-value and
 * per-key caps still holding (this is a comment about layering, not a claim
 * of an atomicity `setKv` does not have across separate calls).
 */
export async function setKv(
	params: KvTarget & { key: string; valueJson: string },
): Promise<boolean> {
	const app = await readScopedApp(params);
	if (!app) return false;
	if (!isValidKey(params.key) || !isValidValueJson(params.valueJson)) {
		return false;
	}
	const newValueBytes = Buffer.byteLength(params.valueJson, "utf8");

	return db.transaction((tx) => {
		const existing = tx
			.select({ id: artifactKv.id })
			.from(artifactKv)
			.where(
				and(eq(artifactKv.artifactId, app.id), eq(artifactKv.key, params.key)),
			)
			.get();

		const otherRows = tx
			.select({ valueJson: artifactKv.valueJson })
			.from(artifactKv)
			.where(
				existing
					? and(
							eq(artifactKv.artifactId, app.id),
							ne(artifactKv.id, existing.id),
						)
					: eq(artifactKv.artifactId, app.id),
			)
			.all();
		const otherBytes = otherRows.reduce(
			(sum, row) => sum + Buffer.byteLength(row.valueJson, "utf8"),
			0,
		);
		if (otherBytes + newValueBytes > ARTIFACT_KV_TOTAL_MAX_BYTES) return false;

		const now = new Date();
		if (existing) {
			tx.update(artifactKv)
				.set({ valueJson: params.valueJson, updatedAt: now })
				.where(eq(artifactKv.id, existing.id))
				.run();
			return true;
		}
		const held = tx
			.select({ total: count() })
			.from(artifactKv)
			.where(eq(artifactKv.artifactId, app.id))
			.get();
		if ((held?.total ?? 0) >= ARTIFACT_KV_MAX_KEYS) return false;
		tx.insert(artifactKv)
			.values({
				id: randomUUID(),
				artifactId: app.id,
				key: params.key,
				valueJson: params.valueJson,
				updatedAt: now,
			})
			.run();
		return true;
	});
}

/** Key ascending. */
export async function listKv(params: KvTarget): Promise<ArtifactKvRow[]> {
	const app = await readScopedApp(params);
	if (!app) return [];
	const rows = await db
		.select({
			key: artifactKv.key,
			valueJson: artifactKv.valueJson,
			updatedAt: artifactKv.updatedAt,
		})
		.from(artifactKv)
		.where(eq(artifactKv.artifactId, app.id))
		.orderBy(asc(artifactKv.key));
	return rows.map((row) => ({
		key: row.key,
		valueJson: row.valueJson,
		updatedAt: row.updatedAt.getTime(),
	}));
}

export async function deleteKv(
	params: KvTarget & { key: string },
): Promise<boolean> {
	const app = await readScopedApp(params);
	if (!app) return false;
	const result = db
		.delete(artifactKv)
		.where(
			and(eq(artifactKv.artifactId, app.id), eq(artifactKv.key, params.key)),
		)
		.run();
	return result.changes > 0;
}
