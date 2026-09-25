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
import { db } from "$lib/server/db";
import { artifactComments } from "$lib/server/db/schema";
import type { Anchor } from "$lib/shared/artifacts/anchor";
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
			if (
				!isNonEmptyString(blockId) ||
				!isNonEmptyString(quote) ||
				!isNonEmptyString(prefix) ||
				!isNonEmptyString(suffix)
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

	let anchorJson: string | null = null;
	if (params.parentId) {
		const [parent] = await db
			.select({ parentId: artifactComments.parentId })
			.from(artifactComments)
			.where(
				and(
					eq(artifactComments.id, params.parentId),
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
			parentId: params.parentId ?? null,
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
