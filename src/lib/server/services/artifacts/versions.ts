// An artifact's history: every saved state, newest first, and restore.
//
// Versions are written by `record.ts` inside the same transaction as the body
// they record (create and update are the only writers), so a stored body and
// its newest version can never disagree. This module reads them, and restores
// one by writing its body back through `updateArtifactBody` — a restore is
// itself a new version, so nothing is ever lost. Every function resolves the
// artifact through `readScopedArtifactRow` first: a version is exactly as
// private as the artifact it belongs to.
import { and, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactVersions } from "$lib/server/db/schema";
import { ARTIFACT_VERSIONS_DEFAULT_LIMIT } from "./limits";
import { readScopedArtifactRow, updateArtifactBody } from "./record";
import type {
	ArtifactAuthor,
	ArtifactScopeOptions,
	ArtifactVersionSummary,
} from "./types";

type VersionTarget = {
	userId: string;
	artifactId: string;
} & ArtifactScopeOptions;

export async function listVersions(
	params: VersionTarget & { limit?: number },
): Promise<ArtifactVersionSummary[]> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return [];
	const rows = await db
		.select({
			id: artifactVersions.id,
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			summary: artifactVersions.summary,
			createdAt: artifactVersions.createdAt,
		})
		.from(artifactVersions)
		.where(
			and(
				eq(artifactVersions.artifactId, artifact.id),
				eq(artifactVersions.userId, params.userId),
			),
		)
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(params.limit ?? ARTIFACT_VERSIONS_DEFAULT_LIMIT);
	return rows.map((row) => ({
		id: row.id,
		versionNumber: row.versionNumber,
		author: row.author as ArtifactAuthor,
		summary: row.summary,
		createdAt: row.createdAt.getTime(),
	}));
}

async function findVersion(params: VersionTarget & { versionId: string }) {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return null;
	const [row] = await db
		.select({
			body: artifactVersions.body,
			summary: artifactVersions.summary,
		})
		.from(artifactVersions)
		.where(
			and(
				eq(artifactVersions.id, params.versionId),
				eq(artifactVersions.artifactId, artifact.id),
				eq(artifactVersions.userId, params.userId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getVersionBody(
	params: VersionTarget & { versionId: string },
): Promise<string | null> {
	return (await findVersion(params))?.body ?? null;
}

/**
 * Writes an earlier version's body back as a NEW version (author `user`,
 * summary `restored <that version's summary>`), numbered after the newest —
 * so the version being replaced stays in the history too.
 */
export async function restoreVersion(
	params: VersionTarget & { versionId: string },
): Promise<
	| { ok: true; versionId: string; versionNumber: number }
	| { ok: false; reason: "not_found" | "no_body" }
> {
	const version = await findVersion(params);
	if (!version) return { ok: false, reason: "not_found" };
	// An empty body restores nothing but a blank page over the current one.
	if (version.body.length === 0) return { ok: false, reason: "no_body" };

	const result = await updateArtifactBody({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		body: version.body,
		author: "user",
		summary: `restored ${version.summary}`,
	});
	// The old body was under every cap when it was written, and there is no
	// base hash to go stale, so the one refusal left is the row disappearing.
	if (!result.ok) return { ok: false, reason: "not_found" };
	return {
		ok: true,
		versionId: result.versionId,
		versionNumber: result.versionNumber,
	};
}
