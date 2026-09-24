import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactLinks,
	artifacts,
	projectKnowledgeLinks,
	projects,
} from "$lib/server/db/schema";
import { getProject } from "$lib/server/services/projects";
import {
	buildArtifactCanonicalOwnershipCondition,
	getArtifactOwnershipScope,
} from "./store/core";
import type { ArtifactType } from "./types";

/**
 * Project files (Workspaces feature 1, Slice E): which ordinary Library
 * Documents a project knows about.
 *
 * A link is a link. Linking copies nothing, unlinking deletes nothing, and no
 * code path in this module ever writes to `artifacts` other than to read it —
 * a project file is the library's document, with the library's bytes, and the
 * only thing that changes when it is linked is that the project's chats are
 * told it exists.
 *
 * Ownership is checked on every write against the knowledge boundary's own
 * scope, never against a bare `artifacts.id` lookup, and every read joins
 * `projects` on the caller's id — so "somebody else's project" is structurally
 * incapable of producing a row rather than remembered to be checked.
 */

export interface ProjectKnowledgeItem {
	artifactId: string;
	name: string;
	mimeType: string | null;
	type: ArtifactType;
	/**
	 * `null` for a document whose size was never recorded. Deliberately not
	 * defaulted to 0: the Files modal prints an em dash for an unknown size, and
	 * "0 B" would be a claim the library cannot make.
	 */
	sizeBytes: number | null;
	/** Unix seconds, when the link was added — this is the "Added" column. */
	linkedAt: number;
	summary: string | null;
}

export class ProjectKnowledgeError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code: "project_not_found" | "artifact_not_owned",
	) {
		super(message);
		this.name = "ProjectKnowledgeError";
	}
}

export function isProjectKnowledgeError(
	error: unknown,
): error is ProjectKnowledgeError {
	return (
		error instanceof ProjectKnowledgeError ||
		(typeof error === "object" &&
			error !== null &&
			"name" in error &&
			(error as { name?: unknown }).name === "ProjectKnowledgeError")
	);
}

interface LinkRow {
	artifactId: string;
	createdAt: Date;
}

interface OwnedArtifactRow {
	id: string;
	type: string;
	name: string;
	mimeType: string | null;
	sizeBytes: number | null;
	summary: string | null;
}

/**
 * One linked document, resolved: the display row the library would show, the
 * artifact retrieval actually returns for it, and the link that joined them.
 */
interface ResolvedProjectDocument {
	displayId: string;
	/** The normalized artifact, when the document has one. */
	normalizedId: string | null;
	display: OwnedArtifactRow;
	summary: string | null;
	linkedAt: number;
}

/**
 * The project's link rows, and only the caller's.
 *
 * The join is the ownership check, not a convenience: a link row can only come
 * back through a project whose `user_id` is the caller's, so guessing somebody
 * else's project id yields no rows at all. A project that does not exist, is
 * not the caller's, or simply has no files are the same answer here — an empty
 * list — on purpose, and the API layer is where a 404 is distinguished.
 */
async function readOwnedLinkRows(
	userId: string,
	projectId: string,
): Promise<LinkRow[]> {
	return db
		.select({
			artifactId: projectKnowledgeLinks.artifactId,
			createdAt: projectKnowledgeLinks.createdAt,
		})
		.from(projectKnowledgeLinks)
		.innerJoin(
			projects,
			and(
				eq(projects.id, projectKnowledgeLinks.projectId),
				eq(projects.userId, userId),
			),
		)
		.where(
			and(
				eq(projectKnowledgeLinks.userId, userId),
				eq(projectKnowledgeLinks.projectId, projectId),
			),
		);
}

/**
 * The upload pipeline's `derived_from` links, in both directions, for the given
 * artifact ids.
 *
 * A link is stored against the document's *display* artifact — the row the
 * library shows, with the real file name, type and size — while retrieval
 * returns the normalized artifact. Both directions are needed: to canonicalise
 * an id on the way in (a caller may well hold the normalized one), and to reach
 * the normalized row on the way out.
 */
async function readDerivedSiblings(
	userId: string,
	artifactIds: string[],
): Promise<{
	normalizedToSource: Map<string, string>;
	sourceToNormalized: Map<string, string>;
}> {
	const normalizedToSource = new Map<string, string>();
	const sourceToNormalized = new Map<string, string>();
	if (artifactIds.length === 0)
		return { normalizedToSource, sourceToNormalized };

	const rows = await db
		.select({
			normalizedId: artifactLinks.artifactId,
			sourceId: artifactLinks.relatedArtifactId,
		})
		.from(artifactLinks)
		.where(
			and(
				eq(artifactLinks.userId, userId),
				or(
					inArray(artifactLinks.artifactId, artifactIds),
					inArray(artifactLinks.relatedArtifactId, artifactIds),
				),
				eq(artifactLinks.linkType, "derived_from"),
			),
		);

	for (const row of rows) {
		if (!row.sourceId) continue;
		normalizedToSource.set(row.normalizedId, row.sourceId);
		sourceToNormalized.set(row.sourceId, row.normalizedId);
	}

	return { normalizedToSource, sourceToNormalized };
}

/**
 * The rows among `artifactIds` the user can actually reach, through the
 * knowledge boundary's canonical ownership scope.
 *
 * This is the read half of the ownership rule: a link row is not a grant, so a
 * document that has since been deleted, moved into another user's hands, or
 * left only inside an incognito chat simply stops resolving — the caller sees
 * one fewer file rather than somebody else's document.
 */
async function readOwnedArtifactRows(
	userId: string,
	artifactIds: string[],
): Promise<Map<string, OwnedArtifactRow>> {
	if (artifactIds.length === 0) return new Map();

	const ownershipScope = await getArtifactOwnershipScope(userId);
	const rows = await db
		.select({
			id: artifacts.id,
			type: artifacts.type,
			name: artifacts.name,
			mimeType: artifacts.mimeType,
			sizeBytes: artifacts.sizeBytes,
			summary: artifacts.summary,
		})
		.from(artifacts)
		.where(
			and(
				buildArtifactCanonicalOwnershipCondition({ userId, ownershipScope }),
				inArray(artifacts.id, artifactIds),
			),
		);

	return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The one resolution both reads share: link rows in, display documents out.
 *
 * Two links that resolve to the same document — one through the source row and
 * one through its normalized artifact — collapse into one entry, because the
 * library shows one document and so must this.
 */
async function resolveProjectDocuments(
	userId: string,
	projectId: string,
): Promise<ResolvedProjectDocument[]> {
	const linkRows = await readOwnedLinkRows(userId, projectId);
	if (linkRows.length === 0) return [];

	const linkedIds = [...new Set(linkRows.map((row) => row.artifactId))];
	const { normalizedToSource, sourceToNormalized } = await readDerivedSiblings(
		userId,
		linkedIds,
	);
	const owned = await readOwnedArtifactRows(userId, [
		...new Set([
			...linkedIds,
			...normalizedToSource.keys(),
			...sourceToNormalized.values(),
		]),
	]);

	const resolved: ResolvedProjectDocument[] = [];
	const seenDisplayIds = new Set<string>();

	for (const linkRow of linkRows) {
		const displayId =
			normalizedToSource.get(linkRow.artifactId) ?? linkRow.artifactId;
		const display = owned.get(displayId);
		if (!display) continue;
		if (seenDisplayIds.has(displayId)) continue;
		seenDisplayIds.add(displayId);

		const normalizedId = normalizedToSource.has(linkRow.artifactId)
			? linkRow.artifactId
			: (sourceToNormalized.get(displayId) ?? null);
		const normalized = normalizedId ? owned.get(normalizedId) : undefined;

		resolved.push({
			displayId,
			normalizedId: normalized ? normalizedId : null,
			display,
			// The normalized artifact carries the summary the pipeline wrote for
			// this document; the source row's own summary is the fallback, exactly
			// as the library's logical-document row prefers it.
			summary: normalized?.summary ?? display.summary,
			linkedAt: Math.floor(linkRow.createdAt.getTime() / 1000),
		});
	}

	return resolved;
}

/**
 * Name order, case-insensitively, with the link as the tie-break.
 *
 * One order, shared by the Files modal and the prompt section, so the section's
 * text is stable turn over turn and the model's prefix cache keeps matching.
 */
function sortItems(items: ProjectKnowledgeItem[]): ProjectKnowledgeItem[] {
	return items.sort(
		(left, right) =>
			left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
			right.linkedAt - left.linkedAt ||
			left.artifactId.localeCompare(right.artifactId),
	);
}

export async function listProjectKnowledge(params: {
	userId: string;
	projectId: string;
}): Promise<ProjectKnowledgeItem[]> {
	const resolved = await resolveProjectDocuments(
		params.userId,
		params.projectId,
	);

	return sortItems(
		resolved.map((document) => ({
			artifactId: document.displayId,
			name: document.display.name,
			mimeType: document.display.mimeType,
			type: document.display.type as ArtifactType,
			sizeBytes: document.display.sizeBytes,
			linkedAt: document.linkedAt,
			summary: document.summary,
		})),
	);
}

/**
 * The ids only: the retrieval boost needs them without the metadata.
 *
 * Both the display artifact and the normalized artifact a document was derived
 * from are returned, because retrieval returns the normalized row for an
 * uploaded document — a boost that named only the source row would never fire.
 */
export async function listProjectKnowledgeArtifactIds(params: {
	userId: string;
	projectId: string;
}): Promise<string[]> {
	const resolved = await resolveProjectDocuments(
		params.userId,
		params.projectId,
	);

	const ids = new Set<string>();
	for (const document of resolved) {
		ids.add(document.displayId);
		if (document.normalizedId) ids.add(document.normalizedId);
	}

	return [...ids].sort();
}

/**
 * Link documents to a project.
 *
 * Both ids are attacker-controlled, so both are checked before anything is
 * written: the project through `getProject` (which is scoped to the caller) and
 * every artifact through the knowledge ownership scope. The whole call fails if
 * any id is not the caller's — a partial link would tell the caller both
 * documents were added.
 *
 * Ids are canonicalised to the document's display artifact first, so linking
 * a normalized artifact is the same act as linking the row the library shows,
 * and the unique index stays a real guarantee rather than a formality.
 */
export async function linkProjectKnowledge(params: {
	userId: string;
	projectId: string;
	artifactIds: string[];
}): Promise<ProjectKnowledgeItem[]> {
	const { userId, projectId } = params;
	const project = await getProject(userId, projectId);
	if (!project) {
		throw new ProjectKnowledgeError(
			"Project not found or access denied",
			404,
			"project_not_found",
		);
	}

	const requestedIds = [
		...new Set(
			params.artifactIds.map((id) => id.trim()).filter((id) => id.length > 0),
		),
	];
	if (requestedIds.length === 0) {
		return listProjectKnowledge({ userId, projectId });
	}

	const { normalizedToSource } = await readDerivedSiblings(
		userId,
		requestedIds,
	);
	const displayIds = [
		...new Set(requestedIds.map((id) => normalizedToSource.get(id) ?? id)),
	];

	const owned = await readOwnedArtifactRows(userId, displayIds);
	if (displayIds.some((id) => !owned.has(id))) {
		throw new ProjectKnowledgeError(
			"Artifact not found or access denied",
			404,
			"artifact_not_owned",
		);
	}

	const linkedAt = new Date();
	db.transaction((tx) => {
		for (const artifactId of displayIds) {
			tx.insert(projectKnowledgeLinks)
				.values({
					id: randomUUID(),
					userId,
					projectId,
					artifactId,
					createdAt: linkedAt,
				})
				.onConflictDoNothing()
				.run();
		}
	});

	return listProjectKnowledge({ userId, projectId });
}

/**
 * Unlink only. The document, its row and its bytes are untouched; removing a
 * link is not removing a file, and the Files modal's footer says so.
 *
 * Unlinking a document through either of its ids removes the link, so a caller
 * holding the library's own id never has to know which id was stored. Asking
 * twice is not an error — it answers `false`, and a project that is not the
 * caller's is a 404 rather than a silent no-op.
 */
export async function unlinkProjectKnowledge(params: {
	userId: string;
	projectId: string;
	artifactId: string;
}): Promise<boolean> {
	const { userId, projectId } = params;
	const project = await getProject(userId, projectId);
	if (!project) {
		throw new ProjectKnowledgeError(
			"Project not found or access denied",
			404,
			"project_not_found",
		);
	}

	const artifactId = params.artifactId.trim();
	if (artifactId.length === 0) return false;

	const { normalizedToSource, sourceToNormalized } = await readDerivedSiblings(
		userId,
		[artifactId],
	);
	const candidates = [
		...new Set(
			[
				artifactId,
				normalizedToSource.get(artifactId),
				sourceToNormalized.get(artifactId),
			].filter((id): id is string => Boolean(id)),
		),
	];

	const result = db
		.delete(projectKnowledgeLinks)
		.where(
			and(
				eq(projectKnowledgeLinks.userId, userId),
				eq(projectKnowledgeLinks.projectId, projectId),
				inArray(projectKnowledgeLinks.artifactId, candidates),
			),
		)
		.run();

	return result.changes > 0;
}
