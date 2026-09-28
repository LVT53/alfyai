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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactKv, artifacts, artifactVersions } from "$lib/server/db/schema";
import { parseJsonRecord } from "$lib/server/utils/json";
import {
	type BlockKind,
	buildIndex,
	type DocumentBlock,
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
	/** The artifact's own conversation — who pays for a model call made about it. */
	conversationId: string | null;
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
			conversationId: scoped.conversationId ?? null,
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

		const currentVersionNumber =
			snapshot?.docVersion ?? readCurrentVersionNumber(db, scoped.id);

		if (patchResult.applied === 0) {
			return {
				ok: true,
				result: patchResult,
				version: currentVersionNumber,
				versionId: readCurrentVersionId(db, scoped.id),
			};
		}

		// Ruling 61's first point: "no marker yet, and the first new Alfy edit
		// writes the marker as its parent version" — bootstrapped here, the one
		// place an Alfy write actually lands, rather than lazily on a read
		// (`getDocumentReviewState` stays read-only). `currentVersionNumber` is
		// the version THIS patch is landing on top of, i.e. exactly "its parent
		// version". A row that already has a marker (every later Alfy edit)
		// leaves it for `acknowledgeDocumentReviewBlocks` to move.
		const existingReview = readDocumentReviewMetadata(
			parseArtifactMetadata(scoped.metadataJson),
		);
		const reviewMetadataPatch = existingReview
			? undefined
			: {
					review: {
						throughVersion: currentVersionNumber,
						keptBlockIds: [] as string[],
					} satisfies DocumentReviewMetadata,
				};

		const writeResult = await updateArtifactBody({
			userId: params.userId,
			artifactId: scoped.id,
			conversationId: params.conversationId,
			includeIncognito: params.includeIncognito,
			body: patchResult.markdown,
			author: "alfy",
			summary: params.patch.label,
			baseHash: hashArtifactBody(currentBody),
			metadataPatch: reviewMetadataPatch,
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
		/** The body hash the caller read; a save over a body that moved since is `stale`. */
		baseHash?: string;
		coalesceUserEdits?: boolean;
	} & ArtifactScopeOptions,
): Promise<
	// RV-1B, coordinator item 6: `bodyHash` is the NEW body's hash, for the
	// caller to remember as its next `baseHash` — without it, only the
	// version-conflict path could ever ask "is my copy still current", and
	// ruling 47's coalescing means two tabs' autosaves can both legitimately
	// see the SAME (unmoved) version number while their text has already
	// diverged. See `+server.ts`'s own comment on `baseHash`.
	| { ok: true; version: number; bodyHash: string }
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
	// Server authority over what is stored (RV-1A): the body is parsed and
	// minted here, so every block is stored behind its own marker whatever
	// the client sent. The editor canonicalises before it saves, making this a
	// no-op for it; a body that arrives with an unmarked block (an old tab, a
	// hand-made request) no longer reaches Alfy's read as a block with an
	// empty — and, for two such blocks, shared — id.
	const result = await updateArtifactBody({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		body: serialize({
			...params.body,
			markdown: parseDocument(params.body.markdown).markdown,
		}),
		author: params.author,
		summary: params.summary,
		metadataPatch: { tabs: params.body.tabs },
		expectVersion: params.expectVersion,
		baseHash: params.baseHash,
		coalesceUserEdits: params.coalesceUserEdits,
	});
	if (!result.ok) return { ok: false, reason: result.reason };
	return { ok: true, version: result.versionNumber, bodyHash: result.bodyHash };
}

// ---------------------------------------------------------------------------
// Ruling 61's first point: a pending Alfy change survives a reload. Documents
// only (Apps keep their own v2 toast + Undo). Stored on the artifact's own
// `metadata_json` — no migration — as `{ review: { throughVersion,
// keptBlockIds } }`: `throughVersion` is the last version number the user has
// reviewed (always 0 — "no marker yet" — or an ALFY-authored version number,
// never a user one, so the field's own meaning never drifts), and
// `keptBlockIds` are blocks already acknowledged (Kept or Undone) in an Alfy
// version newer than that marker. The bootstrap write (an existing artifact's
// very first marker) lives in `applyDocumentPatch` above, the one place an
// Alfy write actually lands; everything below is either pure computation or
// the acknowledge write, and NEITHER writes on a plain read — a GET recomputes
// from whatever is currently stored rather than normalising it, so the only
// writer of this metadata besides the bootstrap is `acknowledgeDocumentReviewBlocks`.
// ---------------------------------------------------------------------------

export interface DocumentReviewMetadata {
	throughVersion: number;
	keptBlockIds: string[];
}

/** Validates, never throws — malformed or missing metadata reads as "no marker yet". */
function readDocumentReviewMetadata(
	metadata: ArtifactMetadata | null,
): DocumentReviewMetadata | null {
	const raw = metadata?.review;
	if (!raw || typeof raw !== "object") return null;
	const { throughVersion, keptBlockIds } = raw as Record<string, unknown>;
	if (typeof throughVersion !== "number" || throughVersion <= 0) return null;
	const ids = Array.isArray(keptBlockIds)
		? keptBlockIds.filter((id): id is string => typeof id === "string")
		: [];
	return { throughVersion, keptBlockIds: ids };
}

/** One pending block: still-unreviewed Alfy content, plus what Undo restores. */
export interface DocumentReviewPendingBlock {
	blockId: string;
	blockLabel: string;
	/** The block's markdown as of the Alfy version's own parent — what Undo restores. Empty when `isNewBlock`. */
	previousMarkdown: string;
	/** True when the block did not exist before the Alfy version that (most recently) changed it — Undo deletes it rather than replacing it with empty content. */
	isNewBlock: boolean;
	/** Which Alfy version most recently changed this block — informational (ordering, tests). */
	alfyVersionNumber: number;
}

interface ReviewVersionRow {
	versionNumber: number;
	author: ArtifactAuthor;
	body: string;
}

function readVersionsAscending(
	tx: ArtifactTransaction | typeof db,
	artifactId: string,
): ReviewVersionRow[] {
	return tx
		.select({
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			body: artifactVersions.body,
		})
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.orderBy(asc(artifactVersions.versionNumber))
		.all()
		.map((row) => ({ ...row, author: row.author as ArtifactAuthor }));
}

/**
 * Pure: every version's body is parsed at most once (`blocksFor`'s own
 * cache) — each version is read as "current" once and, for its own child,
 * as "parent" once more, so memoising avoids parsing the same body twice.
 *
 * For every version newer than `throughVersion`, diffs it against its
 * immediate parent (`versionNumber - 1`; version numbers are contiguous —
 * ruling 47 never leaves a gap) block by block, and keeps, per block id, only
 * the MOST RECENT version that changed it. A block whose last change came
 * from Alfy (never kept, still present in the latest version) is pending —
 * this single "most recent change wins" rule is what quietly satisfies BOTH
 * of ruling 61's other two "minus" clauses without tracking them separately:
 * a user's own later edit to the same block becomes that block's most recent
 * change (author "user"), so it is excluded the same way Undo's own
 * resulting version excludes it (Undo is authored "user" too — ruling 61's
 * "Undo... acknowledges them" is therefore belt-and-braces with the
 * `keptBlockIds` write, not the only thing excluding it).
 */
export function computePendingReviewBlocks(
	throughVersion: number,
	keptBlockIds: readonly string[],
	versions: ReviewVersionRow[],
): DocumentReviewPendingBlock[] {
	if (throughVersion <= 0 || versions.length === 0) return [];
	const byNumber = new Map(versions.map((v) => [v.versionNumber, v]));
	let latest = versions[0];
	for (const v of versions) {
		if (v.versionNumber > latest.versionNumber) latest = v;
	}

	const blocksCache = new Map<number, DocumentBlock[]>();
	const blocksFor = (versionNumber: number): DocumentBlock[] => {
		const cached = blocksCache.get(versionNumber);
		if (cached) return cached;
		const version = byNumber.get(versionNumber);
		const blocks = version
			? parseDocument(version.body, { mint: false }).blocks
			: [];
		blocksCache.set(versionNumber, blocks);
		return blocks;
	};

	const latestIndex = new Map(
		blocksFor(latest.versionNumber).map((b) => [b.id, b] as const),
	);
	const kept = new Set(keptBlockIds);
	const lastChange = new Map<
		string,
		{ versionNumber: number; author: ArtifactAuthor }
	>();

	const ordered = versions
		.filter((v) => v.versionNumber > throughVersion)
		.sort((a, b) => a.versionNumber - b.versionNumber);
	for (const version of ordered) {
		const parentIndex = buildIndex(blocksFor(version.versionNumber - 1));
		for (const block of blocksFor(version.versionNumber)) {
			const parentHash = parentIndex[block.id];
			if (parentHash === undefined || parentHash !== block.hash) {
				lastChange.set(block.id, {
					versionNumber: version.versionNumber,
					author: version.author,
				});
			}
		}
	}

	const pending: DocumentReviewPendingBlock[] = [];
	for (const [blockId, change] of lastChange) {
		if (change.author !== "alfy" || kept.has(blockId)) continue;
		// "minus blocks that no longer exist" (ruling 61).
		const current = latestIndex.get(blockId);
		if (!current) continue;
		const parentBlock = blocksFor(change.versionNumber - 1).find(
			(b) => b.id === blockId,
		);
		pending.push({
			blockId,
			blockLabel: current.label,
			previousMarkdown: parentBlock?.markdown ?? "",
			isNewBlock: !parentBlock,
			alfyVersionNumber: change.versionNumber,
		});
	}
	// The order Alfy actually made them in, so the review bar's stepper and
	// "which one is #1" agree with the version history.
	pending.sort(
		(a, b) =>
			a.alfyVersionNumber - b.alfyVersionNumber ||
			a.blockId.localeCompare(b.blockId),
	);
	return pending;
}

/**
 * Bulk counterpart to `getDocumentReviewState`, for `read-model.ts`'s
 * `listArtifactsForConversation` (Wave 2.5 review, F1: "one pending count
 * per Document as the single source" — the chat card, the panel's list row
 * and the header's count-button dot all read this ONE persisted number
 * instead of each independently re-deriving their own from the ephemeral,
 * session-only `liveDocumentAlfyActivity` signal, which could go stale in a
 * different way for each of the three).
 *
 * Takes rows the caller already fetched (id + metadataJson — never a second
 * query for those) and returns each DOCUMENT row's count, keyed by artifact
 * id, through the exact same `computePendingReviewBlocks` a single-artifact
 * `getDocumentReviewState` call already uses. A row with no `metadata.review`
 * marker (never touched by Alfy) gets NO entry in the returned map — the
 * caller's own "no entry" reads as "not reviewable", distinct from an entry
 * of `0` ("reviewed"); this also means its version history is never even
 * fetched, keeping the common case (most documents were never Alfy-edited)
 * cheap: only a row that already has a marker pays for the extra query.
 */
export async function computeDocumentPendingReviewCounts(
	rows: readonly { id: string; metadataJson: string | null }[],
): Promise<Map<string, number>> {
	const reviewById = new Map<string, DocumentReviewMetadata>();
	for (const row of rows) {
		const review = readDocumentReviewMetadata(
			parseArtifactMetadata(row.metadataJson),
		);
		if (review) reviewById.set(row.id, review);
	}
	if (reviewById.size === 0) return new Map();

	const ids = [...reviewById.keys()];
	const versionRows = db
		.select({
			artifactId: artifactVersions.artifactId,
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			body: artifactVersions.body,
		})
		.from(artifactVersions)
		.where(inArray(artifactVersions.artifactId, ids))
		.orderBy(asc(artifactVersions.versionNumber))
		.all();

	const versionsById = new Map<string, ReviewVersionRow[]>();
	for (const row of versionRows) {
		const entry: ReviewVersionRow = {
			versionNumber: row.versionNumber,
			author: row.author as ArtifactAuthor,
			body: row.body,
		};
		const list = versionsById.get(row.artifactId);
		if (list) list.push(entry);
		else versionsById.set(row.artifactId, [entry]);
	}

	const counts = new Map<string, number>();
	for (const [id, review] of reviewById) {
		const versions = versionsById.get(id) ?? [];
		counts.set(
			id,
			computePendingReviewBlocks(
				review.throughVersion,
				review.keptBlockIds,
				versions,
			).length,
		);
	}
	return counts;
}

/**
 * Read-only (ruling 61: "the pending set... recomputed on load", never a
 * write) — every version is read fresh and diffed against the CURRENTLY
 * stored marker/kept-list, so this always answers the truth even for an
 * artifact nobody has acknowledged anything on since the marker moved.
 */
export async function getDocumentReviewState(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<
	| { ok: true; pending: DocumentReviewPendingBlock[] }
	| { ok: false; reason: "not_found" | "not_a_document" }
> {
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
	const review = readDocumentReviewMetadata(
		parseArtifactMetadata(scoped.metadataJson),
	);
	if (!review) return { ok: true, pending: [] };
	const versions = readVersionsAscending(db, scoped.id);
	return {
		ok: true,
		pending: computePendingReviewBlocks(
			review.throughVersion,
			review.keptBlockIds,
			versions,
		),
	};
}

/**
 * Keep and Undo both "acknowledge" (ruling 61) — this is the one write for
 * both: the caller (Keep, Undo, Keep all, Undo all) names the block ids it
 * just resolved, and this adds them to `keptBlockIds` before recomputing.
 * When that empties the pending set, the marker advances to the latest ALFY
 * version (never a later user version — `throughVersion`'s own meaning never
 * drifts) and `keptBlockIds` clears, exactly as ruling 61 states. A caller
 * with nothing to acknowledge against an artifact that has no marker yet is a
 * harmless no-op: there was never anything pending to acknowledge.
 */
export async function acknowledgeDocumentReviewBlocks(
	params: {
		userId: string;
		artifactId: string;
		blockIds: string[];
	} & ArtifactScopeOptions,
): Promise<
	| { ok: true; pending: DocumentReviewPendingBlock[] }
	| { ok: false; reason: "not_found" | "not_a_document" }
> {
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

	return db.transaction((tx) => {
		const current = tx
			.select({ metadataJson: artifacts.metadataJson })
			.from(artifacts)
			.where(eq(artifacts.id, scoped.id))
			.get();
		if (!current) return { ok: false as const, reason: "not_found" as const };

		const review = readDocumentReviewMetadata(
			parseArtifactMetadata(current.metadataJson),
		);
		if (!review) return { ok: true as const, pending: [] };

		const versions = readVersionsAscending(tx, scoped.id);
		const keptSet = new Set(review.keptBlockIds);
		for (const id of params.blockIds) keptSet.add(id);
		const keptChanged = keptSet.size !== review.keptBlockIds.length;

		const pending = computePendingReviewBlocks(
			review.throughVersion,
			[...keptSet],
			versions,
		);

		let nextThroughVersion = review.throughVersion;
		let nextKeptIds = [...keptSet];
		let advanced = false;
		if (pending.length === 0) {
			let latestAlfyVersion = 0;
			for (const v of versions) {
				if (v.author === "alfy" && v.versionNumber > latestAlfyVersion) {
					latestAlfyVersion = v.versionNumber;
				}
			}
			if (latestAlfyVersion > nextThroughVersion) {
				nextThroughVersion = latestAlfyVersion;
				advanced = true;
			}
			if (nextKeptIds.length > 0) {
				nextKeptIds = [];
				advanced = true;
			}
		}

		if (keptChanged || advanced) {
			const metadataJson = JSON.stringify({
				...(parseJsonRecord(current.metadataJson) ?? {}),
				review: {
					throughVersion: nextThroughVersion,
					keptBlockIds: nextKeptIds,
				} satisfies DocumentReviewMetadata,
			});
			tx.update(artifacts)
				.set({ metadataJson, updatedAt: new Date() })
				.where(eq(artifacts.id, scoped.id))
				.run();
		}

		return { ok: true as const, pending };
	});
}
