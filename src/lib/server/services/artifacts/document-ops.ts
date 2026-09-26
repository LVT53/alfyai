/**
 * The Document's server-side operations (Feature 2 · Artifacts, Slice 1).
 * Routes and the model tools (Slice 5a's dispatch seam) stay thin by calling
 * these; this module is the one place that combines the pure engine
 * (`$lib/shared/artifact-document`) with the artifact row, the version store
 * and the last-read snapshot.
 *
 * The snapshot (`artifact_kv['alfy.snapshot']`) is deliberately NOT read or
 * written through `kv.ts` — that module's four accessors are scoped to kind
 * `"app"` on purpose (its own header: "slice 2 adds the route... it must not
 * add a fifth accessor"). A Document's snapshot is a different concern, so
 * this module resolves its own scoped row through `readScopedArtifactRow`
 * (imported from `./record`, not the public facade — the same internal-import
 * pattern `versions.ts`/`comments.ts`/`kv.ts` already use) and reads/writes
 * `artifact_kv` directly, restricted to kind `"document"`.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactKv, artifacts, artifactVersions } from "$lib/server/db/schema";
import {
	type BlockKind,
	buildIndex,
	parseDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	applyPatchSet,
	type PatchResult,
	type PatchSet,
} from "$lib/shared/artifact-document/patch";
import { hashArtifactBody } from "./hash";
import {
	ALFY_SNAPSHOT_KV_KEY,
	createArtifact,
	kindForArtifactRow,
	parseArtifactMetadata,
	readScopedArtifactRow,
	updateArtifactBody,
} from "./record";
import {
	createBody,
	type DocumentBody,
	type DocumentTab,
	serialize,
} from "./serialize/document";
import type {
	ArtifactAuthor,
	ArtifactMetadata,
	ArtifactRecord,
	ArtifactScopeOptions,
} from "./types";

type ArtifactTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * `readDocumentForAlfy` and `createDocumentArtifact` throw this rather than
 * returning a union: their contracts (slice-1.md §Contracts) resolve to a
 * plain success object, with no `{ok:false,...}` shape to fall back to.
 * `applyDocumentPatch` and `saveDocumentBody`, whose contracts DO show a
 * union, still return one — this class is only for the two whose contract
 * does not.
 */
export class DocumentOperationError extends Error {
	constructor(public readonly reason: string) {
		super(reason);
		this.name = "DocumentOperationError";
	}
}

interface StoredSnapshot {
	at: number;
	docVersion: number;
	index: Record<string, string>;
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as StoredSnapshot).docVersion === "number" &&
		typeof (value as StoredSnapshot).index === "object"
	);
}

function readSnapshot(
	tx: ArtifactTransaction | typeof db,
	artifactId: string,
): StoredSnapshot | null {
	const row = tx
		.select({ valueJson: artifactKv.valueJson })
		.from(artifactKv)
		.where(
			and(
				eq(artifactKv.artifactId, artifactId),
				eq(artifactKv.key, ALFY_SNAPSHOT_KV_KEY),
			),
		)
		.get();
	if (!row) return null;
	try {
		const parsed: unknown = JSON.parse(row.valueJson);
		return isStoredSnapshot(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function writeSnapshot(
	tx: ArtifactTransaction,
	artifactId: string,
	snapshot: StoredSnapshot,
): void {
	const existing = tx
		.select({ id: artifactKv.id })
		.from(artifactKv)
		.where(
			and(
				eq(artifactKv.artifactId, artifactId),
				eq(artifactKv.key, ALFY_SNAPSHOT_KV_KEY),
			),
		)
		.get();
	const now = new Date();
	const valueJson = JSON.stringify(snapshot);
	if (existing) {
		tx.update(artifactKv)
			.set({ valueJson, updatedAt: now })
			.where(eq(artifactKv.id, existing.id))
			.run();
	} else {
		tx.insert(artifactKv)
			.values({
				id: randomUUID(),
				artifactId,
				key: ALFY_SNAPSHOT_KV_KEY,
				valueJson,
				updatedAt: now,
			})
			.run();
	}
}

function readCurrentVersionNumber(
	tx: ArtifactTransaction | typeof db,
	artifactId: string,
): number {
	const row = tx
		.select({ versionNumber: artifactVersions.versionNumber })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(1)
		.get();
	return row?.versionNumber ?? 0;
}

/** The current newest version's row id — `edit_artifact`'s `versionId` needs a real string even on an all-refused patch (nothing new was written, so it names the version the read stays true of). */
function readCurrentVersionId(
	tx: ArtifactTransaction | typeof db,
	artifactId: string,
): string | null {
	const row = tx
		.select({ id: artifactVersions.id })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(1)
		.get();
	return row?.id ?? null;
}

/**
 * `metadata.tabs`, validated field by field — malformed or missing reads as
 * `[]`, never a throw. Exported (not just used internally) so a caller that
 * already has an artifact's parsed metadata — the body-write route (T7),
 * which must carry the CURRENT tabs forward on an ordinary autosave rather
 * than overwriting them with `[]` — reads the same tab list this module does,
 * instead of a second, possibly-drifted parser.
 */
export function documentTabsFromMetadata(
	metadata: ArtifactMetadata | null,
): DocumentTab[] {
	const raw = metadata?.tabs;
	if (!Array.isArray(raw)) return [];
	const tabs: DocumentTab[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const { id, title, startBlockId } = entry as Record<string, unknown>;
		if (
			typeof id === "string" &&
			typeof title === "string" &&
			typeof startBlockId === "string"
		) {
			tabs.push({ id, title, startBlockId });
		}
	}
	return tabs;
}

async function readScopedDocumentRow(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
) {
	const row = await readScopedArtifactRow(params);
	if (!row) throw new DocumentOperationError("not_found");
	if (kindForArtifactRow(row) !== "document") {
		throw new DocumentOperationError("not_a_document");
	}
	return row;
}

/**
 * Alfy's read: every block with its hash, the tab list, and a snapshot write
 * in the same beat as the read (Contracts: "read_artifact writes it in the
 * same transaction as the read"). `mint: false` on purpose — a well-formed
 * store already has every id (every write path mints before storing), so a
 * read never mints: minting here without persisting would hand out ids the
 * stored text does not actually have yet, and the very next patch against one
 * would refuse `block_missing`.
 */
export async function readDocumentForAlfy(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<{
	artifactId: string;
	title: string;
	version: number;
	tabs: { id: string; title: string }[];
	blocks: {
		blockId: string;
		kind: BlockKind;
		label: string;
		hash: string;
		text: string;
	}[];
}> {
	const scoped = await readScopedDocumentRow(params);

	return db.transaction((tx) => {
		const fresh = tx
			.select({
				contentText: artifacts.contentText,
				metadataJson: artifacts.metadataJson,
				name: artifacts.name,
			})
			.from(artifacts)
			.where(eq(artifacts.id, scoped.id))
			.get();
		if (!fresh) throw new DocumentOperationError("not_found");

		const parsed = parseDocument(fresh.contentText ?? "", { mint: false });
		const index = buildIndex(parsed.blocks);
		const metadata = parseArtifactMetadata(fresh.metadataJson);
		const title = metadata?.title?.trim() || fresh.name;
		const tabs = documentTabsFromMetadata(metadata).map((tab) => ({
			id: tab.id,
			title: tab.title,
		}));

		const snapshot: StoredSnapshot = {
			at: Date.now(),
			docVersion: readCurrentVersionNumber(tx, scoped.id),
			index,
		};
		writeSnapshot(tx, scoped.id, snapshot);

		return {
			artifactId: scoped.id,
			title,
			version: snapshot.docVersion,
			tabs,
			blocks: parsed.blocks.map((block) => ({
				blockId: block.id,
				kind: block.kind,
				label: block.label,
				hash: block.hash,
				text: block.markdown,
			})),
		};
	});
}

/**
 * How many times a patch re-reads and re-applies when its write finds the
 * body changed since its read. Each retry reads the new body, so this only
 * runs out if that many writers land inside one patch's read→write window.
 */
const PATCH_WRITE_ATTEMPTS = 5;

/**
 * Applies a model patch against the CURRENT stored state (never a stale copy)
 * and, if anything applied, persists the result as a new version (Alfy writes
 * always append — ruling 47) with a fresh snapshot in the same transaction as
 * the body, so Alfy's next edit is checked against exactly what it just wrote.
 * A patch that applies nothing still returns `ok: true` with the (all-refused)
 * result: a refusal is the feature, not an error (spec §4).
 *
 * The write only lands over the body this patch read (`baseHash`): between
 * the read and the write there are awaits, and two edit_artifact calls in one
 * model step run concurrently, so without the guard the later write replaced
 * the earlier one's body with its own, built from the older text — an applied
 * edit (or a user's save) vanished while its tool result said "applied"
 * (RV-1A). A write that finds the body changed re-reads and re-applies, so
 * the guard re-checks every op against what is really there now.
 */
export async function applyDocumentPatch(
	params: {
		userId: string;
		artifactId: string;
		patch: PatchSet;
	} & ArtifactScopeOptions,
): Promise<
	| {
			ok: true;
			result: PatchResult;
			version: number;
			/** The version this patch landed in, or the CURRENT version when every op refused (nothing new was written). */
			versionId: string | null;
	  }
	| { ok: false; reason: "not_found" | "not_a_document" }
> {
	for (let attempt = 0; attempt < PATCH_WRITE_ATTEMPTS; attempt += 1) {
		let scoped: Awaited<ReturnType<typeof readScopedDocumentRow>>;
		try {
			scoped = await readScopedDocumentRow(params);
		} catch (error) {
			if (error instanceof DocumentOperationError) {
				return {
					ok: false,
					reason: error.reason as "not_found" | "not_a_document",
				};
			}
			throw error;
		}

		const currentBody = scoped.contentText ?? "";
		const parsedNow = parseDocument(currentBody, { mint: false });
		const snapshot = readSnapshot(db, scoped.id);

		const patchResult = applyPatchSet({
			blocks: parsedNow.blocks,
			patch: params.patch,
			snapshot: snapshot?.index ?? {},
		});

		if (patchResult.applied === 0) {
			return {
				ok: true,
				result: patchResult,
				version:
					snapshot?.docVersion ?? readCurrentVersionNumber(db, scoped.id),
				versionId: readCurrentVersionId(db, scoped.id),
			};
		}

		const writeResult = await updateArtifactBody({
			userId: params.userId,
			artifactId: scoped.id,
			conversationId: params.conversationId,
			includeIncognito: params.includeIncognito,
			body: patchResult.markdown,
			author: "alfy",
			summary: params.patch.label,
			baseHash: hashArtifactBody(currentBody),
			snapshot: {
				at: Date.now(),
				docVersion: 0,
				index: buildIndex(patchResult.blocks),
			},
		});
		if (!writeResult.ok) {
			// Someone wrote between this read and this write: go again against
			// what they wrote, never over it.
			if (writeResult.reason === "stale") continue;
			// The only other realistic failure is the row disappearing between
			// the read above and this write (a delete raced in) — `not_found` is
			// the one answer this function promises for that.
			return { ok: false, reason: "not_found" };
		}

		return {
			ok: true,
			result: patchResult,
			version: writeResult.versionNumber,
			versionId: writeResult.versionId,
		};
	}
	// PATCH_WRITE_ATTEMPTS writers landed inside this patch's window: nothing
	// was written over any of them, and there is no honest "applied" to report.
	return { ok: false, reason: "not_found" };
}

/**
 * Creates a Document artifact: the body goes through the serializer's
 * `createBody` (mint-before-hash again, for the artifact's very first write),
 * and the initial tab strip lands in `metadata` in the SAME `createArtifact`
 * call — never a second write after the fact.
 */
export async function createDocumentArtifact(params: {
	userId: string;
	conversationId: string | null;
	title: string;
	markdown?: string;
	author: ArtifactAuthor;
	summary: string;
}): Promise<ArtifactRecord> {
	const body = createBody({ title: params.title, markdown: params.markdown });
	const result = await createArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		kind: "document",
		title: params.title,
		body: serialize(body),
		metadata: { tabs: body.tabs },
		author: params.author,
		versionSummary: params.summary,
	});
	if (!result.ok) throw new DocumentOperationError(result.reason);
	return result.artifact;
}

/**
 * The panel's own save path: `body.tabs` and `body.markdown` land in one
 * `updateArtifactBody` call (tabs in `metadataPatch`, text in `body`), so a
 * tab rename and a keystroke can never be torn apart by a crash between two
 * writes. `coalesceUserEdits` is threaded straight through — only a
 * user-authored save actually coalesces (ruling 47), never one from Alfy.
 */
export async function saveDocumentBody(
	params: {
		userId: string;
		artifactId: string;
		body: DocumentBody;
		author: ArtifactAuthor;
		summary: string;
		expectVersion?: number;
		coalesceUserEdits?: boolean;
	} & ArtifactScopeOptions,
): Promise<
	| { ok: true; version: number }
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
	const result = await updateArtifactBody({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		body: serialize(params.body),
		author: params.author,
		summary: params.summary,
		metadataPatch: { tabs: params.body.tabs },
		expectVersion: params.expectVersion,
		coalesceUserEdits: params.coalesceUserEdits,
	});
	if (!result.ok) return { ok: false, reason: result.reason };
	return { ok: true, version: result.versionNumber };
}
