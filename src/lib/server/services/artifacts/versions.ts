// An artifact's history: every saved state, newest first, restore, and the
// reader's name for a version.
//
// Versions are written by `record.ts` inside the same transaction as the body
// they record (create and update are the only writers), so a stored body and
// its newest version can never disagree. This module reads them, and restores
// one by writing its body back through `updateArtifactBody` — a restore is
// itself a new version, so nothing is ever lost. Every function resolves the
// artifact through `readScopedArtifactRow` first: a version is exactly as
// private as the artifact it belongs to.
//
// What a reader sees of all this — moments, folds, statuses — is derived from
// these rows in `history.ts`; nothing here is stored for it except a name.
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactVersions } from "$lib/server/db/schema";
import {
	normalizeVersionLabel,
	type RestoreMomentKind,
} from "$lib/shared/artifacts/history";
import {
	parseRestoredVersion,
	restoredSummary,
	undidAlfyChangeSummary,
	undidRestoreSummary,
} from "$lib/shared/artifacts/version-summaries";
import { appViolations } from "./app/audit";
import { ARTIFACT_VERSIONS_DEFAULT_LIMIT } from "./limits";
import {
	isEditableArtifactRow,
	kindForArtifactRow,
	readScopedArtifactRow,
	updateArtifactBody,
} from "./record";
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
	params: VersionTarget & {
		limit?: number;
		/** Only versions numbered below this: the next page after the last one seen (ruling 47: "paged"). */
		before?: number;
	},
): Promise<ArtifactVersionSummary[]> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact) return [];
	const owned = and(
		eq(artifactVersions.artifactId, artifact.id),
		eq(artifactVersions.userId, params.userId),
	);
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
			params.before === undefined
				? owned
				: and(owned, lt(artifactVersions.versionNumber, params.before)),
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
			versionNumber: artifactVersions.versionNumber,
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
	return row ? { ...row, kind: kindForArtifactRow(artifact) } : null;
}

export async function getVersionBody(
	params: VersionTarget & { versionId: string },
): Promise<string | null> {
	return (await findVersion(params))?.body ?? null;
}

/**
 * Writes an earlier version's body back as a NEW version (author `user`,
 * summary `Restored v<n>` naming the version it came from), numbered after the
 * newest — so the version being replaced stays in the history too.
 *
 * `expectVersion` is the newest version the reader saw (History's
 * `newestVersion`): a restore over a newer one is refused `version_conflict`
 * exactly like a stale save, so it can never silently bury a step the open
 * editor has not saved yet, or a change that landed while History was open.
 *
 * `undoOf` is the restore toast's Undo (and an App rebuild's): it names the
 * newest row, which must be the child of the version being brought back, and
 * the summary says what was undone (`Undid restoring v3`, or `Undid Alfy's
 * change: v3` for an Alfy row). Any other row is not a thing Undo reverses.
 *
 * An App's restore is also an audit (ruling 58): what is written back is the
 * LIVE App, which runs with the writing bridge and today's saved data, so a
 * version the current audit calls a violation (it sends its own document away,
 * or opens a WebRTC channel; `appViolations`) is refused `not_runnable`, the
 * very answer the saved-version route gives it. History offers it as Code only.
 */
export async function restoreVersion(
	params: VersionTarget & {
		versionId: string;
		expectVersion?: number;
		undoOf?: number;
	},
): Promise<
	| {
			ok: true;
			versionId: string;
			versionNumber: number;
			/** What the row written is, so a client that announces it need not guess: a restore, the Undo of one, or the Undo of Alfy's change (an App rebuild's). */
			kind: RestoreMomentKind;
	  }
	| {
			ok: false;
			reason:
				| "not_found"
				| "no_body"
				| "not_runnable"
				| "version_conflict"
				| "invalid_undo";
	  }
> {
	const version = await findVersion(params);
	if (!version) return { ok: false, reason: "not_found" };
	// An empty body restores nothing but a blank page over the current one.
	if (version.body.length === 0) return { ok: false, reason: "no_body" };
	// A Document or a board is text and data: only an App's body is run.
	if (version.kind === "app" && appViolations(version.body).length > 0) {
		return { ok: false, reason: "not_runnable" };
	}

	let summary = restoredSummary(version.versionNumber);
	let kind: RestoreMomentKind = "restore";
	let expectVersion = params.expectVersion;
	if (params.undoOf !== undefined) {
		if (
			params.expectVersion !== undefined &&
			params.expectVersion !== params.undoOf
		) {
			return { ok: false, reason: "invalid_undo" };
		}
		const [newest] = await db
			.select({
				versionNumber: artifactVersions.versionNumber,
				author: artifactVersions.author,
				summary: artifactVersions.summary,
			})
			.from(artifactVersions)
			.where(
				and(
					eq(artifactVersions.artifactId, params.artifactId),
					eq(artifactVersions.userId, params.userId),
				),
			)
			.orderBy(desc(artifactVersions.versionNumber))
			.limit(1);
		if (
			!newest ||
			newest.versionNumber !== params.undoOf ||
			version.versionNumber !== params.undoOf - 1
		) {
			return { ok: false, reason: "invalid_undo" };
		}
		if (newest.author === "alfy") {
			summary = undidAlfyChangeSummary(params.undoOf);
			kind = "undo_alfy_change";
		} else if (parseRestoredVersion(newest.summary) !== null) {
			summary = undidRestoreSummary(params.undoOf);
			kind = "undo_restore";
		} else {
			return { ok: false, reason: "invalid_undo" };
		}
		// The write itself refuses if something landed since.
		expectVersion = params.undoOf;
	}

	const result = await updateArtifactBody({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
		includeIncognito: params.includeIncognito,
		body: version.body,
		author: "user",
		summary,
		expectVersion,
	});
	if (!result.ok) {
		// The old body was under every cap when it was written, and there is no
		// base hash to go stale: what is left is a newer version, or the row gone.
		return {
			ok: false,
			reason:
				result.reason === "version_conflict" ? "version_conflict" : "not_found",
		};
	}
	return {
		ok: true,
		versionId: result.versionId,
		versionNumber: result.versionNumber,
		kind,
	};
}

/**
 * The reader's name for a version (`artifact_versions.label`). A name is a fact
 * about a row, not a body: naming mints no version, leaves the artifact as it
 * was, and stops later typing from being coalesced into the named version
 * (`updateArtifactBody`), so the words under a name stay put. `null` or blank
 * removes it; a name is one line of at most `VERSION_LABEL_MAX_CHARS`.
 */
export async function nameVersion(
	params: VersionTarget & { versionId: string; label: unknown },
): Promise<
	| { ok: true; label: string | null }
	| { ok: false; reason: "not_found" | "invalid_label" }
> {
	const artifact = await readScopedArtifactRow(params);
	if (!artifact || !isEditableArtifactRow(artifact)) {
		return { ok: false, reason: "not_found" };
	}
	const normalized = normalizeVersionLabel(params.label);
	if (!normalized.ok) return { ok: false, reason: "invalid_label" };
	const updated = db
		.update(artifactVersions)
		.set({ label: normalized.label })
		.where(
			and(
				eq(artifactVersions.id, params.versionId),
				eq(artifactVersions.artifactId, artifact.id),
				eq(artifactVersions.userId, params.userId),
			),
		)
		.run();
	if (updated.changes === 0) return { ok: false, reason: "not_found" };
	return { ok: true, label: normalized.label };
}
