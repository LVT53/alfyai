// The type-dispatching envelope for id-addressed changes (Feature 2 ·
// Artifacts, Slice 3; ruling 14). ONE path for a diff, whether it comes from
// the panel through `POST /api/artifacts/[id]/ops` or from the model's
// `edit_artifact` tool calling this in-process:
//
//   ownership scope → load → base-version check → dispatch on kind → read and
//   judge the diff → ONE `updateArtifactBody` (author `alfy`, the diff's
//   summary) → per-op answer.
//
// Auth is the caller's job. A kind with no branch is a 400, never a silent
// success; a diff that changes nothing writes nothing. The mechanism (parse,
// judge, apply, account for every op) is `$lib/shared/artifacts/ops`; what is
// server-shaped stays here: who may touch the row, which version the diff was
// made against, and the write. Slides adds its branch to `OPS_BRANCHES` in a
// later commit and touches neither this control flow nor the route.
import { boardOpsVocabulary } from "$lib/shared/artifacts/board-ops";
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import {
	type OpRefusal,
	parseOpsEnvelope,
	runOps,
} from "$lib/shared/artifacts/ops";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { reviewMarkerPatchFor } from "./document-ops";
import { getArtifact, updateArtifactBody } from "./record";
import { canvasSerializer, prepareCanvasBoard } from "./serialize/canvas";
import type { ArtifactKind, ArtifactScopeOptions } from "./types";
import { getVersionBody, listVersions } from "./versions";

export type OpsEnvelopeInput = {
	userId: string;
	artifactId: string;
	/** The request body as the route parsed it: `{ baseVersionId, diff }`. */
	payload: unknown;
	/**
	 * The version the author of the diff last READ, when it is known (a model's
	 * turn read the board, then edits it). An op that would overwrite something
	 * that changed between that version and now is the reader's newer work and is
	 * refused `stale` (ruling 67); the rest of the batch applies. Absent, or a
	 * version that is not this artifact's, every op is judged against the board
	 * as it is now. In-process only: the route never sets it.
	 */
	readVersionId?: string;
	/**
	 * Who the change is written as. `alfy` (the default) is the model's edit tool
	 * and the `@Alfy` comment reply, calling this in-process: the diff's own
	 * summary, and the change waits for the reader's Keep or Undo (ruling 63).
	 * `user` is a change a browser sent through the route: the caller's own
	 * version with the ordinary summary, never a free-text one under Alfy's name
	 * and never a pending change (RV-3 Minor 6).
	 */
	author?: "alfy" | "user";
} & ArtifactScopeOptions;

export type OpsEnvelopeFailureReason =
	| "not_found"
	| "invalid_diff"
	| "unsupported_kind"
	| "version_conflict"
	| "too_large";

export type OpsEnvelopeResult =
	| {
			ok: true;
			/** The version the diff landed in, or the current one when nothing changed. */
			versionId: string;
			version: number;
			/** How many ops applied. `refused` names the ones that did not, by index. */
			applied: number;
			refused: OpRefusal[];
			/**
			 * Whether a version was written. `false` when nothing applied or what
			 * applied changes nothing (a highlight): the answer then names the
			 * current version, and a caller must not claim the board just changed.
			 */
			changed: boolean;
	  }
	| {
			ok: false;
			status: 400 | 404 | 409 | 413;
			reason: OpsEnvelopeFailureReason;
			/** `version_conflict` only: the version the artifact is really at. */
			version?: number;
			/** `invalid_diff` and `unsupported_kind`: what to fix. A 404 never carries one. */
			detail?: string;
	  };

/**
 * What one kind's branch answers: the new stored body, or `null` when the diff
 * left the artifact exactly as it was (nothing accepted, or only ops that change
 * nothing, like a highlight) — so the envelope writes no version for it.
 */
export type OpsBranchOutcome =
	| {
			ok: true;
			body: string | null;
			applied: number;
			refused: OpRefusal[];
			summary: string;
	  }
	| {
			ok: false;
			status: 400 | 413;
			reason: "invalid_diff" | "too_large";
			detail?: string;
	  };

/**
 * A branch is pure: the stored body and the raw diff in, the outcome out. No
 * database, no route. `readStored` is the body of the version the author last
 * read, when the envelope was told which and it is not the current one.
 */
export type OpsBranch = (input: {
	stored: string | null;
	diff: unknown;
	readStored?: string | null;
}) => OpsBranchOutcome;

/**
 * The canvas branch. A board that does not read (the stored body is not JSON)
 * is treated as an empty one, so a diff is never lost to it — the unreadable
 * body stays in the version it was written in, and Undo goes back to it.
 */
const canvasBranch: OpsBranch = ({ stored, diff, readStored }) => {
	const before = canvasSerializer.parse(stored ?? "") ?? emptyCanvasBody();
	// The board the author last read: what it changed since is not theirs to overwrite.
	const readBoard = readStored
		? (canvasSerializer.parse(readStored) ?? undefined)
		: undefined;
	const run = runOps(boardOpsVocabulary, before, diff, { readDoc: readBoard });
	if (!run.ok) {
		return {
			ok: false,
			status: 400,
			reason: "invalid_diff",
			detail: run.detail,
		};
	}
	const base = {
		applied: run.applied,
		refused: run.refused,
		summary: run.summary,
	};
	const after = boardJson(run.doc);
	if (run.applied === 0 || after === boardJson(before)) {
		return { ok: true, body: null, ...base };
	}
	// The one gate a board passes on its way into storage: canonical, in caps.
	const prepared = prepareCanvasBoard(after);
	if (!prepared.ok) {
		return prepared.reason === "invalid_body"
			? {
					ok: false,
					status: 400,
					reason: "invalid_diff",
					detail: "The change would not leave a readable board.",
				}
			: { ok: false, status: 413, reason: "too_large" };
	}
	return { ok: true, body: prepared.json, ...base };
};

/** kind → branch. Canvas registers here; Slides registers `slides` beside it. */
export const OPS_BRANCHES: Partial<Record<ArtifactKind, OpsBranch>> = {
	canvas: canvasBranch,
};

/**
 * Applies a diff to an artifact the user may write, as one new Alfy version.
 * `baseVersionId` must be the artifact's newest version — the one the diff was
 * made against; a stale one is refused with the version the artifact is at, so
 * a second writer (a chat turn, a second tab) is told rather than overwritten.
 * The write itself carries the body hash it read, so a save that lands between
 * the read and the write is refused the same way instead of being replaced.
 * When every op is refused (or none changes anything) nothing is written and the
 * answer names the current version.
 */
export async function applyArtifactOps(
	input: OpsEnvelopeInput,
): Promise<OpsEnvelopeResult> {
	const envelope = parseOpsEnvelope(input.payload);
	if (!envelope.ok) {
		return {
			ok: false,
			status: 400,
			reason: "invalid_diff",
			detail: envelope.detail,
		};
	}

	const scope = {
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
		includeIncognito: input.includeIncognito,
	};
	const artifact = await getArtifact(scope);
	// A foreign id and a missing one answer alike: a 403 would confirm the id exists.
	if (!artifact) return { ok: false, status: 404, reason: "not_found" };

	const [newest] = await listVersions({ ...scope, limit: 1 });
	if (!newest || newest.id !== envelope.baseVersionId) {
		return {
			ok: false,
			status: 409,
			reason: "version_conflict",
			version: newest?.versionNumber ?? artifact.versionNumber,
		};
	}

	const branch = OPS_BRANCHES[artifact.kind];
	if (!branch) {
		return {
			ok: false,
			status: 400,
			reason: "unsupported_kind",
			detail: `A ${artifact.kind} cannot be changed with ops.`,
		};
	}
	// The version the author last read, unless it is the current one (then nothing
	// can have changed since) or is not this artifact's (then there is no read).
	const readStored =
		input.readVersionId && input.readVersionId !== newest.id
			? await getVersionBody({ ...scope, versionId: input.readVersionId })
			: null;
	const outcome = branch({
		stored: artifact.body,
		diff: envelope.diff,
		readStored,
	});
	if (!outcome.ok) {
		return {
			ok: false,
			status: outcome.status,
			reason: outcome.reason,
			detail: outcome.detail,
		};
	}

	if (outcome.body === null) {
		return {
			ok: true,
			versionId: newest.id,
			version: newest.versionNumber,
			applied: outcome.applied,
			refused: outcome.refused,
			changed: false,
		};
	}

	// Ruling 63: an Alfy diff is ONE pending change, and a pending change survives
	// a reload through ruling 61's review marker on the artifact's own metadata.
	// The marker is bootstrapped here, the one place an Alfy write lands, exactly
	// as `applyDocumentPatch` does it: absent, it names the version this write
	// lands on top of (so this version is the first one waiting for review); once
	// it exists, only the reader's Keep or Undo moves it.
	const author = input.author ?? "alfy";
	const written = await updateArtifactBody({
		...scope,
		body: outcome.body,
		author,
		summary: author === "alfy" ? outcome.summary : VERSION_SUMMARY.edited,
		baseHash: artifact.bodyHash ?? undefined,
		metadataPatch:
			author === "user"
				? undefined
				: reviewMarkerPatchFor(artifact.metadata, newest.versionNumber),
	});
	if (!written.ok) {
		if (written.reason === "too_large") {
			return { ok: false, status: 413, reason: "too_large" };
		}
		if (written.reason === "not_found") {
			return { ok: false, status: 404, reason: "not_found" };
		}
		// `stale`: someone saved between this read and this write. Say where the
		// artifact is now instead of writing over them.
		const [latest] = await listVersions({ ...scope, limit: 1 });
		return {
			ok: false,
			status: 409,
			reason: "version_conflict",
			version: latest?.versionNumber ?? newest.versionNumber,
		};
	}
	return {
		ok: true,
		versionId: written.versionId,
		version: written.versionNumber,
		applied: outcome.applied,
		refused: outcome.refused,
		changed: true,
	};
}
