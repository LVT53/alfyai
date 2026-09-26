// The one comment layer the whole family shares (ruling 11): threads, replies,
// resolve and delete over the single `artifact_comments` table, with an
// opaque, validated anchor. Where an anchor lands in a Document or on a Canvas
// is each kind's own resolver's business (slices 1 and 3); this module only
// stores it, and reads back `null` — an orphan — for one that no longer
// parses, never a crash.
//
// Every function resolves the artifact through `readScopedArtifactRow` first:
// a comment is exactly as private as the artifact it is on.
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db";
import { artifactComments } from "$lib/server/db/schema";
import {
	ALFY_EMPTY_REPLY_MARKER,
	ALFY_REFUSED_MARKER,
} from "$lib/shared/artifact-document/alfy-reply";
import { resolveTextAnchor } from "$lib/shared/artifact-document/anchor";
import type { DocumentBlock } from "$lib/shared/artifact-document/blocks";
import type { PatchOp, PatchSet } from "$lib/shared/artifact-document/patch";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { sendJsonControlMessage } from "../normal-chat-control-model";
import {
	applyDocumentPatch,
	DocumentOperationError,
	readDocumentForAlfy,
} from "./document-ops";
import { ARTIFACT_COMMENT_BODY_MAX_CHARS } from "./limits";
import { readScopedArtifactRow } from "./record";
import type {
	ArtifactAuthor,
	ArtifactComment,
	ArtifactCommentStatus,
	ArtifactScopeOptions,
} from "./types";

type CommentTarget = {
	userId: string;
	artifactId: string;
} & ArtifactScopeOptions;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toAnchor(value: unknown): Anchor | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	switch (candidate.kind) {
		case "text": {
			const { blockId, quote, prefix, suffix } = candidate;
			// The context may be EMPTY: the editor captures it inside the
			// block, so a selection at a block's start has no prefix and one at
			// its end has no suffix — a whole heading, a first word, a whole
			// task line. Requiring both non-empty refused every such comment
			// with a 400 (RV-1A). An empty context is still a valid anchor: the
			// quote and its block carry it.
			if (
				!isNonEmptyString(blockId) ||
				!isNonEmptyString(quote) ||
				typeof prefix !== "string" ||
				typeof suffix !== "string"
			) {
				return null;
			}
			return { kind: "text", blockId, quote, prefix, suffix };
		}
		case "node":
			return isNonEmptyString(candidate.nodeId)
				? { kind: "node", nodeId: candidate.nodeId }
				: null;
		case "point": {
			const { x, y } = candidate;
			return typeof x === "number" &&
				Number.isFinite(x) &&
				typeof y === "number" &&
				Number.isFinite(y)
				? { kind: "point", x, y }
				: null;
		}
		default:
			return null;
	}
}

/**
 * The only anchor parser. Validates rather than trusts: `null` input,
 * malformed JSON, an unknown `kind`, a missing or wrong-typed field — each is
 * `null`, which the UI renders as an orphaned comment. Fields beyond the shape
 * are dropped, not carried.
 */
export function parseArtifactAnchor(json: string | null): Anchor | null {
	if (!json) return null;
	try {
		return toAnchor(JSON.parse(json));
	} catch {
		return null;
	}
}

type CommentRow = typeof artifactComments.$inferSelect;

function mapComment(row: CommentRow): ArtifactComment {
	return {
		id: row.id,
		artifactId: row.artifactId,
		parentId: row.parentId ?? null,
		// A reply's column is NULL: it is anchored to its parent.
		anchor: row.parentId ? null : parseArtifactAnchor(row.anchorJson),
		author: row.author as ArtifactAuthor,
		body: row.body,
		status: row.status as ArtifactCommentStatus,
		createdAt: row.createdAt.getTime(),
		replies: [],
	};
}

/**
 * A root comment needs a valid anchor; a reply needs a root parent on the same
 * artifact and is stored with a NULL anchor whatever it was handed. Refusals —
 * an over-long body, a root with no anchor, a reply to a reply, an unreachable
 * artifact — are `null`, never a throw.
 */
export async function createComment(
	params: CommentTarget & {
		anchor: Anchor | null;
		author: ArtifactAuthor;
		body: string;
		parentId?: string | null;
	},
): Promise<ArtifactComment | null> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return null;
	if (Array.from(params.body).length > ARTIFACT_COMMENT_BODY_MAX_CHARS) {
		return null;
	}

	// Normalised once, so the root-vs-reply choice below and the stored value
	// can never disagree: an empty string is falsy, chooses the root path the
	// same as omitting parentId, and must not reach the database as the
	// literal string "" — no comment id is ever equal to it, so inserting it
	// verbatim (the previous `params.parentId ?? null`, which only replaces
	// null/undefined) threw a FOREIGN KEY error instead of refusing cleanly.
	const parentId = params.parentId ? params.parentId : null;

	let anchorJson: string | null = null;
	if (parentId) {
		const [parent] = await db
			.select({ parentId: artifactComments.parentId })
			.from(artifactComments)
			.where(
				and(
					eq(artifactComments.id, parentId),
					eq(artifactComments.artifactId, artifact.id),
					eq(artifactComments.userId, params.userId),
				),
			)
			.limit(1);
		// One level of threading: a reply's parent is a root.
		if (!parent || parent.parentId) return null;
	} else {
		const anchor = toAnchor(params.anchor);
		if (!anchor) return null;
		anchorJson = JSON.stringify(anchor);
	}

	const [row] = await db
		.insert(artifactComments)
		.values({
			id: randomUUID(),
			artifactId: artifact.id,
			userId: params.userId,
			parentId,
			anchorJson,
			author: params.author,
			body: params.body,
			status: "open",
			createdAt: new Date(),
		})
		.returning();
	return row ? mapComment(row) : null;
}

/** Root threads oldest first, each with its replies nested oldest first. */
export async function listComments(
	params: CommentTarget,
): Promise<ArtifactComment[]> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return [];
	const rows = await db
		.select()
		.from(artifactComments)
		.where(
			and(
				eq(artifactComments.artifactId, artifact.id),
				eq(artifactComments.userId, params.userId),
			),
		)
		// `created_at` is second-resolution; insertion order breaks the tie.
		.orderBy(asc(artifactComments.createdAt), sql`rowid`);

	const roots: ArtifactComment[] = [];
	const rootsById = new Map<string, ArtifactComment>();
	for (const row of rows) {
		if (row.parentId) continue;
		const root = mapComment(row);
		roots.push(root);
		rootsById.set(root.id, root);
	}
	for (const row of rows) {
		if (!row.parentId) continue;
		rootsById.get(row.parentId)?.replies.push(mapComment(row));
	}
	return roots;
}

export async function resolveComment(
	params: CommentTarget & { commentId: string; resolved: boolean },
): Promise<boolean> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return false;
	const result = db
		.update(artifactComments)
		.set({ status: params.resolved ? "resolved" : "open" })
		.where(
			and(
				eq(artifactComments.id, params.commentId),
				eq(artifactComments.artifactId, artifact.id),
				eq(artifactComments.userId, params.userId),
			),
		)
		.run();
	return result.changes > 0;
}

/** Deleting a root deletes its replies: `parent_id` cascades. */
export async function deleteComment(
	params: CommentTarget & { commentId: string },
): Promise<boolean> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return false;
	const result = db
		.delete(artifactComments)
		.where(
			and(
				eq(artifactComments.id, params.commentId),
				eq(artifactComments.artifactId, artifact.id),
				eq(artifactComments.userId, params.userId),
			),
		)
		.run();
	return result.changes > 0;
}

/** One comment, scoped exactly like every read above — the `/alfy` and future single-comment routes' own lookup. */
export async function getComment(
	params: CommentTarget & { commentId: string },
): Promise<ArtifactComment | null> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return null;
	const [row] = await db
		.select()
		.from(artifactComments)
		.where(
			and(
				eq(artifactComments.id, params.commentId),
				eq(artifactComments.artifactId, artifact.id),
				eq(artifactComments.userId, params.userId),
			),
		)
		.limit(1);
	return row ? mapComment(row) : null;
}

// ── The @Alfy hook (Slice 1, Task T10) ──────────────────────────────────────
// Ruling 11 assigns this hook to comments.ts alongside threads/status/replies
// ("the whole family shares one comment layer"). Today it is Document-only:
// a comment's own kind is read straight off the artifact, and there is only
// one branch. A later type (Canvas, Slice 3) that wants its own @Alfy
// behavior adds its own dispatch here rather than reusing the Document's
// resolve-and-patch call, the same way `EDIT_ARTIFACT_HANDLERS` dispatches by
// kind for the model's own edit_artifact tool.

const ALFY_COMMENT_MAX_TOKENS = 4000;

const alfyCommentPatchOpSchema = z.object({
	op: z.enum([
		"replaceBlock",
		"insertText",
		"replaceRange",
		"toggleTask",
		"addTableRow",
	]),
	text: z.string().optional(),
	find: z.string().optional(),
	at: z.enum(["start", "end"]).optional(),
	checked: z.boolean().optional(),
	cells: z
		.array(
			z.union([
				z.string(),
				z.object({
					chip: z.object({
						kind: z.enum(["status", "date"]),
						value: z.string(),
					}),
				}),
			]),
		)
		.optional(),
});

const alfyCommentReplySchema = z.object({
	note: z.string(),
	ops: z.array(alfyCommentPatchOpSchema),
});

/**
 * `blockId`/`baseHash` are never model-facing here (unlike `edit_artifact`,
 * which reads them off the model because the model chose which block to
 * touch): a comment is already scoped to ONE block by its own anchor, so the
 * server supplies both from a fresh read and the model only ever describes
 * the change itself. This is what makes "scoped to the anchored block" a
 * server guarantee rather than a prompt request.
 */
const ALFY_COMMENT_REPLY_JSON_SCHEMA = {
	name: "alfy_comment_reply",
	schema: {
		type: "object",
		properties: {
			note: { type: "string" },
			ops: {
				type: "array",
				items: {
					type: "object",
					properties: {
						op: {
							type: "string",
							enum: [
								"replaceBlock",
								"insertText",
								"replaceRange",
								"toggleTask",
								"addTableRow",
							],
						},
						text: { type: "string" },
						find: { type: "string" },
						at: { type: "string", enum: ["start", "end"] },
						checked: { type: "boolean" },
					},
					required: ["op"],
				},
			},
		},
		required: ["note", "ops"],
	},
} as const;

function buildAlfyCommentSystemPrompt(params: {
	blockText: string;
	quote: string;
	commentBody: string;
}): string {
	return [
		"You are Alfy, replying inside a comment thread attached to one passage of a shared document.",
		"The user quoted this passage and left a comment mentioning you.",
		"",
		`Passage: ${params.blockText}`,
		`Quoted text: ${params.quote}`,
		`Comment: ${params.commentBody}`,
		"",
		"If the comment asks for a text change, describe it with one or more ops against ONLY this passage:",
		'- replaceRange: {"op":"replaceRange","find":"<exact text in the passage>","text":"<replacement>"}',
		'- replaceBlock: {"op":"replaceBlock","text":"<the whole new passage>"}',
		'- insertText: {"op":"insertText","text":"<text>","at":"start"|"end"}',
		'- toggleTask: {"op":"toggleTask","checked":true|false}',
		"If the comment is a question, an observation, or needs no change, leave ops empty.",
		'Always write a short "note": your answer if it was a question, or one short line about what you changed. Write it in the same language as the comment.',
		'Respond with JSON only, in the shape {"note": string, "ops": [...]}.',
	].join("\n");
}

export type AlfyCommentOutcome = "applied" | "refused" | "answered";

export interface AlfyCommentReplyResult {
	outcome: AlfyCommentOutcome;
	applied: number;
	refused: number;
	/** The version this reply's own change landed in, or the CURRENT version when nothing changed. */
	version: number;
	reply: ArtifactComment;
}

function parseAlfyReplyJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * The `@Alfy` hook (T10.5): one patch attempt scoped to the comment's
 * anchored block, through the SAME engine and hash guard `edit_artifact` uses
 * (`applyDocumentPatch` — never a second one), abort-aware end to end (the
 * envelope's signal fires on the caller's own timeout or the user
 * disconnecting; nothing is written once it has), and always ending with a
 * reply in the thread — applied, refused, or an answer, never silence.
 */
export async function runAlfyCommentReply(
	params: CommentTarget & { commentId: string; abortSignal: AbortSignal },
): Promise<
	| { ok: true; value: AlfyCommentReplyResult }
	| { ok: false; reason: "not_found" | "not_a_document" | "aborted" }
> {
	if (params.abortSignal.aborted) return { ok: false, reason: "aborted" };

	// readDocumentForAlfy is Alfy's own read (Contracts: "read_artifact writes
	// [the snapshot] in the same transaction as the read") — calling it here,
	// rather than a second ad hoc read, is what makes the block this function
	// resolves against one the guard below actually recognizes as "just seen".
	// Without it every op would refuse `block_unseen`, the correct answer for
	// a block with no snapshot entry at all.
	let alfyRead: Awaited<ReturnType<typeof readDocumentForAlfy>>;
	try {
		alfyRead = await readDocumentForAlfy({
			userId: params.userId,
			artifactId: params.artifactId,
			conversationId: params.conversationId,
			includeIncognito: params.includeIncognito,
		});
	} catch (error) {
		if (error instanceof DocumentOperationError) {
			return {
				ok: false,
				reason: error.reason as "not_found" | "not_a_document",
			};
		}
		throw error;
	}

	const target = await getComment(params);
	if (!target) return { ok: false, reason: "not_found" };

	const rootId = target.parentId ?? target.id;
	const anchor = target.parentId
		? parseArtifactAnchor(
				(
					await db
						.select({ anchorJson: artifactComments.anchorJson })
						.from(artifactComments)
						.where(eq(artifactComments.id, target.parentId))
						.limit(1)
				)[0]?.anchorJson ?? null,
			)
		: target.anchor;

	async function reply(body: string): Promise<ArtifactComment> {
		const created = await createComment({
			userId: params.userId,
			artifactId: alfyRead.artifactId,
			conversationId: params.conversationId,
			includeIncognito: params.includeIncognito,
			anchor: null,
			author: "alfy",
			body,
			parentId: rootId,
		});
		if (!created)
			throw new Error("alfy's own reply to a valid thread was refused");
		return created;
	}

	async function refused(): Promise<AlfyCommentReplyResult> {
		return {
			outcome: "refused",
			applied: 0,
			refused: 0,
			version: alfyRead.version,
			reply: await reply(ALFY_REFUSED_MARKER),
		};
	}

	if (!anchor || anchor.kind !== "text") {
		return { ok: true, value: await refused() };
	}

	// The SAME read that just wrote the snapshot feeds resolution too, so the
	// block applyDocumentPatch checks below is exactly the one the anchor
	// resolved against — never a second, later read that could disagree.
	const blocksForResolution: DocumentBlock[] = alfyRead.blocks.map((b) => ({
		id: b.blockId,
		kind: b.kind,
		markdown: b.text,
		hash: b.hash,
		label: b.label,
	}));
	const resolution = resolveTextAnchor(anchor, blocksForResolution);
	if (resolution.state === "orphaned" || !resolution.blockId) {
		return { ok: true, value: await refused() };
	}
	const block = blocksForResolution.find(
		(candidate) => candidate.id === resolution.blockId,
	);
	if (!block) return { ok: true, value: await refused() };

	if (params.abortSignal.aborted) return { ok: false, reason: "aborted" };

	const modelResult = await sendJsonControlMessage(target.body, undefined, {
		systemPrompt: buildAlfyCommentSystemPrompt({
			blockText: block.markdown,
			quote: anchor.quote,
			commentBody: target.body,
		}),
		thinkingMode: "off",
		maxTokens: ALFY_COMMENT_MAX_TOKENS,
		jsonSchema: ALFY_COMMENT_REPLY_JSON_SCHEMA,
		signal: params.abortSignal,
	}).catch(() => null);

	if (params.abortSignal.aborted) return { ok: false, reason: "aborted" };
	if (!modelResult) return { ok: true, value: await refused() };

	const parsedReply = alfyCommentReplySchema.safeParse(
		parseAlfyReplyJson(modelResult.text),
	);
	if (!parsedReply.success) return { ok: true, value: await refused() };

	const note = parsedReply.data.note.trim();

	if (parsedReply.data.ops.length === 0) {
		return {
			ok: true,
			value: {
				outcome: "answered",
				applied: 0,
				refused: 0,
				version: alfyRead.version,
				reply: await reply(note || ALFY_EMPTY_REPLY_MARKER),
			},
		};
	}

	if (params.abortSignal.aborted) return { ok: false, reason: "aborted" };

	const ops: PatchOp[] = parsedReply.data.ops.map((op) => ({
		opId: `alfy-comment-${randomUUID()}`,
		kind: op.op,
		blockId: block.id,
		baseHash: block.hash,
		blockLabel: block.label,
		text: op.text,
		find: op.find,
		at: op.at,
		checked: op.checked,
		cells: op.cells,
	}));
	const patch: PatchSet = {
		patchId: `alfy-comment-${rootId}`,
		label: "Alfy's comment reply",
		ops,
	};

	const patchResult = await applyDocumentPatch({
		userId: params.userId,
		artifactId: alfyRead.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		patch,
	});
	if (!patchResult.ok) return { ok: false, reason: patchResult.reason };

	if (patchResult.result.applied === 0) {
		return { ok: true, value: await refused() };
	}

	return {
		ok: true,
		value: {
			outcome: "applied",
			applied: patchResult.result.applied,
			refused: patchResult.result.refused,
			version: patchResult.version,
			reply: await reply(note || ALFY_EMPTY_REPLY_MARKER),
		},
	};
}
