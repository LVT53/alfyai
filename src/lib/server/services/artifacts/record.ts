// The artifact row itself: create, read, write the body, delete — and the one
// place that decides which rows belong to the family and what kind each is.
//
// Every read here starts from `readScopedArtifactRow`, which takes the scope
// from `getArtifactOwnershipScope` and filters with the canonical ownership
// condition, so an artifact is reachable exactly where a library document
// would be: through a conversation of the user's that is in scope, or through
// the user's own stamp once no conversation holds it. Versions, comments and
// the key-value store reach their rows through the same function, which is
// what makes a child row as private as the artifact it hangs off.
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactComments,
	artifactKv,
	artifacts,
	artifactVersions,
} from "$lib/server/db/schema";
import {
	buildArtifactCanonicalOwnershipCondition,
	getArtifactOwnershipScope,
} from "$lib/server/services/knowledge/store/core";
import { parseJsonRecord } from "$lib/server/utils/json";
import { hashArtifactBody } from "./hash";
import {
	ARTIFACT_BODY_MAX_BYTES,
	ARTIFACT_TITLE_MAX_CHARS,
	ARTIFACT_USER_VERSION_COALESCE_MS,
	ARTIFACT_VERSION_SUMMARY_MAX_CHARS,
} from "./limits";
import type {
	ArtifactAuthor,
	ArtifactDetail,
	ArtifactKind,
	ArtifactMetadata,
	ArtifactRecord,
	ArtifactScopeOptions,
	CreatableArtifactKind,
	CreateArtifactInput,
} from "./types";

export type ArtifactRow = typeof artifacts.$inferSelect;

type ArtifactTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The row type the four new kinds are written with. A produced file keeps
 * `generated_output` (ruling 18): `buildArtifactCanonicalOwnershipCondition`
 * and Clear Memory both key on that value, so re-typing it would change who
 * owns it and make Clear Memory delete it.
 */
const ARTIFACT_ROW_TYPE = "artifact";

/**
 * The one key `updateArtifactBody`'s optional `snapshot` param writes to
 * `artifact_kv` (Slice 1). Exported so `document-ops.ts` reads back the exact
 * key this function wrote, rather than a second string literal that could
 * drift from it.
 */
export const ALFY_SNAPSHOT_KV_KEY = "alfy.snapshot";

/** The two row types the family spans in slice 0. */
export const FAMILY_ROW_TYPES = [ARTIFACT_ROW_TYPE, "generated_output"];

const KNOWN_KINDS: Record<ArtifactKind, true> = {
	document: true,
	app: true,
	canvas: true,
	slides: true,
	file: true,
};

function isArtifactKind(value: unknown): value is ArtifactKind {
	return typeof value === "string" && Object.hasOwn(KNOWN_KINDS, value);
}

const CREATABLE_KINDS: Record<CreatableArtifactKind, true> = {
	document: true,
	app: true,
	canvas: true,
	slides: true,
};

/**
 * The runtime half of `CreatableArtifactKind`. The type alone only protects a
 * caller that goes through TypeScript; slice 5's tools hand this a
 * model-supplied string, so "file" (a produced file stays `generated_output`
 * — ruling 18, never a second representation of the same row) and anything
 * else unrecognised must be refused here too.
 */
function isCreatableArtifactKind(
	value: unknown,
): value is CreatableArtifactKind {
	return typeof value === "string" && Object.hasOwn(CREATABLE_KINDS, value);
}

/**
 * `metadata_json` as the family writes it: `{ artifactType, title, … }`.
 * Validating, never throwing — malformed JSON, a non-object, an unknown kind
 * or a missing title all read as `null`.
 */
export function parseArtifactMetadata(
	json: string | null,
): ArtifactMetadata | null {
	const record = parseJsonRecord(json);
	if (!record) return null;
	const { artifactType, title } = record;
	if (!isArtifactKind(artifactType) || typeof title !== "string") return null;
	return { ...record, artifactType, title };
}

/** The only place row type ↔ kind is decided. Never throws: an unknown row is a file. */
export function kindForArtifactRow(row: {
	type: string;
	metadataJson: string | null;
}): ArtifactKind {
	return parseArtifactMetadata(row.metadataJson)?.artifactType ?? "file";
}

/**
 * The title a card shows: the family's own `metadata.title`, a produced
 * file's document label, and otherwise the row's name.
 */
export function titleForArtifactRow(row: {
	type: string;
	name: string;
	metadataJson: string | null;
}): string {
	const title = parseArtifactMetadata(row.metadataJson)?.title.trim();
	if (title) return title;
	if (row.type === "generated_output") {
		const label = parseJsonRecord(row.metadataJson)?.documentLabel;
		if (typeof label === "string" && label.trim()) return label.trim();
	}
	return row.name;
}

function clampChars(value: string, max: number): string {
	const chars = Array.from(value);
	return chars.length > max ? chars.slice(0, max).join("") : value;
}

function exceedsBodyCap(body: string): boolean {
	return Buffer.byteLength(body, "utf8") > ARTIFACT_BODY_MAX_BYTES;
}

/**
 * THE scoped read. Every other function in this module and in `versions.ts`,
 * `comments.ts` and `kv.ts` resolves its artifact through it before touching a
 * row, so an id that came from anywhere — a route, a model tool, a bridge —
 * reaches nothing the user's scope does not.
 */
export async function readScopedArtifactRow(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<ArtifactRow | null> {
	const ownershipScope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId ?? null,
		includeIncognito: params.includeIncognito === true,
	});
	const [row] = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, params.artifactId),
				inArray(artifacts.type, FAMILY_ROW_TYPES),
				buildArtifactCanonicalOwnershipCondition({
					userId: params.userId,
					ownershipScope,
				}),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Whether the family may write this row in place. Only the four new kinds are
 * edited, restored or deleted here: a File is a produced file, and AGENTS.md's
 * Knowledge Library rule (no in-app editing of generated files) still binds
 * it, so its id answers like any id the family cannot write.
 */
export function isEditableArtifactRow(row: ArtifactRow): boolean {
	return row.type === ARTIFACT_ROW_TYPE;
}

function metadataForRow(
	row: ArtifactRow,
	kind: ArtifactKind,
	title: string,
): ArtifactMetadata {
	// A produced file's metadata is the file pipeline's own bookkeeping (it can
	// carry a whole generated-document source); the family exposes only what
	// it is.
	if (row.type !== ARTIFACT_ROW_TYPE) return { artifactType: kind, title };
	return {
		...(parseJsonRecord(row.metadataJson) ?? {}),
		artifactType: kind,
		title,
	};
}

function insertVersionRow(
	tx: ArtifactTransaction,
	version: {
		artifactId: string;
		userId: string;
		versionNumber: number;
		author: ArtifactAuthor;
		summary: string;
		body: string;
		bodyHash: string;
		createdAt: Date;
	},
): string {
	const id = randomUUID();
	tx.insert(artifactVersions)
		.values({
			id,
			artifactId: version.artifactId,
			userId: version.userId,
			versionNumber: version.versionNumber,
			author: version.author,
			summary: clampChars(version.summary, ARTIFACT_VERSION_SUMMARY_MAX_CHARS),
			body: version.body,
			bodyHash: version.bodyHash,
			createdAt: version.createdAt,
		})
		.run();
	return id;
}

function newestVersion(
	tx: ArtifactTransaction | typeof db,
	artifactId: string,
): { versionNumber: number; bodyHash: string } | undefined {
	return tx
		.select({
			versionNumber: artifactVersions.versionNumber,
			bodyHash: artifactVersions.bodyHash,
		})
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(1)
		.get();
}

/**
 * The hash a writer must quote as `baseHash`: the newest version's, which is
 * the hash of the body as it was stored. A row with no version yet (a produced
 * file, or an artifact created empty) hashes its current body directly, so the
 * two can never disagree about the same stored string.
 */
function currentBodyHash(
	row: Pick<ArtifactRow, "contentText">,
	newest: { bodyHash: string } | undefined,
): string | null {
	if (newest) return newest.bodyHash;
	return row.contentText === null ? null : hashArtifactBody(row.contentText);
}

export async function createArtifact(input: CreateArtifactInput): Promise<
	| { ok: true; artifact: ArtifactRecord }
	| {
			ok: false;
			reason:
				| "conversation_not_found"
				| "too_large"
				| "invalid_kind"
				| "invalid_title";
	  }
> {
	// Pure input-shape checks first, before any DB round trip: a caller whose
	// kind or title never went through TypeScript (a model-supplied tool call,
	// slice 5) gets refused without spending a conversation-ownership query on
	// input that was never going to be written anyway.
	if (!isCreatableArtifactKind(input.kind)) {
		return { ok: false, reason: "invalid_kind" };
	}
	const title = clampChars(input.title.trim(), ARTIFACT_TITLE_MAX_CHARS);
	if (title.length === 0) {
		return { ok: false, reason: "invalid_title" };
	}

	if (input.conversationId) {
		// The ownership scope already answers "is this one of the user's
		// conversations" — served conversation included, so an incognito chat can
		// make artifacts of its own. One reason for "missing" and "someone
		// else's", so a caller cannot probe for another user's conversation id.
		const scope = await getArtifactOwnershipScope(input.userId, {
			conversationId: input.conversationId,
		});
		if (!scope.conversationIds.has(input.conversationId)) {
			return { ok: false, reason: "conversation_not_found" };
		}
	}

	const body = input.body ?? null;
	if (body !== null && exceedsBodyCap(body)) {
		return { ok: false, reason: "too_large" };
	}

	const id = randomUUID();
	const metadata: ArtifactMetadata = {
		...(input.metadata ?? {}),
		artifactType: input.kind,
		title,
	};
	const bodyHash = body === null ? null : hashArtifactBody(body);
	const now = new Date();

	db.transaction((tx) => {
		tx.insert(artifacts)
			.values({
				id,
				userId: input.userId,
				conversationId: input.conversationId ?? null,
				type: ARTIFACT_ROW_TYPE,
				// No retrieval query selects `type = 'artifact'`, so the family cannot
				// reach a prompt by accident; evidence integration is slice 5's.
				retrievalClass: "durable",
				name: title,
				contentText: body,
				metadataJson: JSON.stringify(metadata),
				createdAt: now,
				updatedAt: now,
			})
			.run();
		if (body !== null && bodyHash !== null) {
			insertVersionRow(tx, {
				artifactId: id,
				userId: input.userId,
				versionNumber: 1,
				author: input.author ?? "user",
				summary: input.versionSummary ?? "",
				body,
				bodyHash,
				createdAt: now,
			});
		}
	});

	return {
		ok: true,
		artifact: {
			id,
			userId: input.userId,
			conversationId: input.conversationId ?? null,
			kind: input.kind,
			title,
			body,
			bodyHash,
			metadata,
			versionNumber: body === null ? 0 : 1,
			createdAt: now.getTime(),
			updatedAt: now.getTime(),
		},
	};
}

export async function getArtifact(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<ArtifactDetail | null> {
	const row = await readScopedArtifactRow(params);
	if (!row) return null;

	const newest = newestVersion(db, row.id);
	const [comments] = await db
		.select({ total: count() })
		.from(artifactComments)
		.where(eq(artifactComments.artifactId, row.id));
	const kind = kindForArtifactRow(row);
	const title = titleForArtifactRow(row);

	return {
		id: row.id,
		kind,
		title,
		conversationId: row.conversationId ?? null,
		versionNumber: newest?.versionNumber ?? 0,
		commentCount: comments?.total ?? 0,
		updatedAt: row.updatedAt.getTime(),
		body: row.contentText ?? null,
		bodyHash: currentBodyHash(row, newest),
		metadata: metadataForRow(row, kind, title),
	};
}

/** Upsert one `artifact_kv` row inside an already-open transaction. */
function writeArtifactKvInTx(
	tx: ArtifactTransaction,
	artifactId: string,
	key: string,
	valueJson: string,
): void {
	const existing = tx
		.select({ id: artifactKv.id })
		.from(artifactKv)
		.where(and(eq(artifactKv.artifactId, artifactId), eq(artifactKv.key, key)))
		.get();
	const now = new Date();
	if (existing) {
		tx.update(artifactKv)
			.set({ valueJson, updatedAt: now })
			.where(eq(artifactKv.id, existing.id))
			.run();
	} else {
		tx.insert(artifactKv)
			.values({ id: randomUUID(), artifactId, key, valueJson, updatedAt: now })
			.run();
	}
}

export async function updateArtifactBody(
	params: {
		userId: string;
		artifactId: string;
		body: string;
		author: ArtifactAuthor;
		summary: string;
		/** Optional optimistic guard: the hash the caller last read. */
		baseHash?: string;
		/** Merged into `metadata_json` in the same transaction (Slice 1: the Document's tab strip). */
		metadataPatch?: Record<string, unknown>;
		/**
		 * Written to `artifact_kv['alfy.snapshot']` in the same transaction as the
		 * body (Slice 1). `docVersion` is advisory: this function always
		 * overwrites it with the version number IT computes below, so a caller
		 * can never persist a snapshot claiming a version that was not, in fact,
		 * the one just written.
		 */
		snapshot?: {
			at: number;
			docVersion: number;
			index: Record<string, string>;
		};
		/**
		 * Ruling 47, opt-in. When true AND `author === "user"`, this save updates
		 * the latest version in place instead of appending — but only when that
		 * latest version is ALSO the user's and less than
		 * `ARTIFACT_USER_VERSION_COALESCE_MS` old. Left unset (the default), every
		 * write appends, which is what every existing caller still gets: Alfy's
		 * edits, `createArtifact`, and — the reason this is opt-in rather than
		 * automatic on `author === "user"` — `restoreVersion`. A restore is
		 * authored `"user"` too, but ruling 47 lists it under "always a new
		 * version" beside Alfy's own writes: a restore immediately after an
		 * ordinary user edit must not merge into it, or "restore" would silently
		 * eat the edit it was supposed to sit beside in the history.
		 */
		coalesceUserEdits?: boolean;
		/** Refuses unless the artifact's current version number matches (the panel's autosave race). */
		expectVersion?: number;
	} & ArtifactScopeOptions,
): Promise<
	| { ok: true; versionId: string; bodyHash: string; versionNumber: number }
	| {
			ok: false;
			reason:
				| "not_found"
				| "too_large"
				| "stale"
				| "hash_mismatch"
				| "version_conflict";
	  }
> {
	const row = await readScopedArtifactRow(params);
	if (!row || !isEditableArtifactRow(row)) {
		return { ok: false, reason: "not_found" };
	}
	if (exceedsBodyCap(params.body)) return { ok: false, reason: "too_large" };

	// The hash is computed here from the body that is stored — there is no
	// caller-supplied hash to disagree with it. `hash_mismatch` is reserved for
	// slice 1's hash-then-hand-off patch path and cannot occur on this one.
	const bodyHash = hashArtifactBody(params.body);

	return db.transaction((tx) => {
		const current = tx
			.select({
				contentText: artifacts.contentText,
				metadataJson: artifacts.metadataJson,
			})
			.from(artifacts)
			.where(eq(artifacts.id, row.id))
			.get();
		if (!current) return { ok: false as const, reason: "not_found" as const };

		const newest = newestVersion(tx, row.id);
		if (
			params.baseHash !== undefined &&
			params.baseHash !== currentBodyHash(current, newest)
		) {
			return { ok: false as const, reason: "stale" as const };
		}
		const currentVersionNumber = newest?.versionNumber ?? 0;
		if (
			params.expectVersion !== undefined &&
			params.expectVersion !== currentVersionNumber
		) {
			return { ok: false as const, reason: "version_conflict" as const };
		}

		const now = new Date();

		// Ruling 47: a user-authored save updates the latest version IN PLACE
		// (same version number) when that latest version is also the user's and
		// was created less than ARTIFACT_USER_VERSION_COALESCE_MS ago. Every
		// Alfy change, restore and creation still always appends — this is the
		// coalescing path's only entry, and it never applies to them.
		//
		// "Also the user's" is not enough on its own: a restore is authored
		// `user`, and so is a document the user created ("Save as new"), and the
		// ruling says those are never merged. A burst is consecutive saves of
		// the SAME kind, so the latest version must also carry this save's own
		// summary — a restore ("restored …") or a creation's summary never
		// matches the editor's "Edited", and the first save after either one
		// starts a version of its own (RV-1A).
		const summary = clampChars(
			params.summary,
			ARTIFACT_VERSION_SUMMARY_MAX_CHARS,
		);
		const latestVersionRow = newest
			? tx
					.select({
						id: artifactVersions.id,
						author: artifactVersions.author,
						summary: artifactVersions.summary,
						createdAt: artifactVersions.createdAt,
					})
					.from(artifactVersions)
					.where(
						and(
							eq(artifactVersions.artifactId, row.id),
							eq(artifactVersions.versionNumber, newest.versionNumber),
						),
					)
					.get()
			: undefined;
		const canCoalesce =
			params.coalesceUserEdits === true &&
			params.author === "user" &&
			latestVersionRow?.author === "user" &&
			latestVersionRow.summary === summary &&
			now.getTime() - latestVersionRow.createdAt.getTime() <
				ARTIFACT_USER_VERSION_COALESCE_MS;

		let versionId: string;
		let versionNumber: number;
		if (canCoalesce && latestVersionRow) {
			tx.update(artifactVersions)
				.set({
					body: params.body,
					bodyHash,
					createdAt: now,
					summary,
				})
				.where(eq(artifactVersions.id, latestVersionRow.id))
				.run();
			versionId = latestVersionRow.id;
			versionNumber = newest?.versionNumber ?? currentVersionNumber;
		} else {
			versionNumber = currentVersionNumber + 1;
			versionId = insertVersionRow(tx, {
				artifactId: row.id,
				userId: params.userId,
				versionNumber,
				author: params.author,
				summary: params.summary,
				body: params.body,
				bodyHash,
				createdAt: now,
			});
		}

		const metadataJson = params.metadataPatch
			? JSON.stringify({
					...(parseJsonRecord(current.metadataJson) ?? {}),
					...params.metadataPatch,
				})
			: undefined;
		tx.update(artifacts)
			.set({
				contentText: params.body,
				updatedAt: now,
				...(metadataJson !== undefined ? { metadataJson } : {}),
			})
			.where(eq(artifacts.id, row.id))
			.run();

		if (params.snapshot) {
			writeArtifactKvInTx(
				tx,
				row.id,
				ALFY_SNAPSHOT_KV_KEY,
				JSON.stringify({ ...params.snapshot, docVersion: versionNumber }),
			);
		}

		return { ok: true as const, versionId, bodyHash, versionNumber };
	});
}

/**
 * A real delete: the row goes, and the `artifact_id` foreign keys take its
 * versions, comments and key-value rows with it (the connection runs with
 * `foreign_keys = ON`; tests/integration/artifact-spine.test.ts asserts it).
 */
export async function deleteArtifact(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<boolean> {
	const row = await readScopedArtifactRow(params);
	if (!row || !isEditableArtifactRow(row)) return false;
	return db.transaction(
		(tx) =>
			tx.delete(artifacts).where(eq(artifacts.id, row.id)).run().changes > 0,
	);
}
