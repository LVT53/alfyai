// edit_artifact: patch a Document/Slides item by block/field, or apply a
// Canvas diff. A refusal is the feature, not the failure: the user's own
// concurrent edit wins, and the model is told why so it can act rather than
// retry blind. See docs/plans/claude-at-home-2/slice-5.md §The three tools
// and decisions.md ruling 43.
import { z } from "zod";
import {
	getArtifact,
	listArtifactCatalogueEntries,
} from "$lib/server/services/artifacts";
import { truncateText } from "../shared";
import type { CreatableArtifactKind } from "./create";

/** Advertised to the model. `patches`/`ops` stay permissive on purpose (below). */
export const editArtifactModelInputSchema = z.object({
	artifactId: z
		.string()
		.min(1)
		.describe(
			"The id from create_artifact, read_artifact or the artifact catalogue.",
		),
	patches: z
		.array(z.unknown())
		.optional()
		.describe(
			"Documents and Slides only: [{op, blockId|slideId, fieldId, baseHash, text}]. Read the artifact first; baseHash must be the hash you last read.",
		),
	ops: z
		.array(z.unknown())
		.optional()
		.describe(
			"Canvas only: [{op:'add_frame'|'add_node'|'move'|'add_edge'|'remove_edge'|'update_node'|'remove_node'|'highlight', ...}], at most 40.",
		),
	summary: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe("One short line shown next to Keep/Undo."),
});

/** Executed against: the caps are the server's, and they are enforced here. */
export const editArtifactInputSchema = z.object({
	artifactId: z.string().min(1),
	patches: z.array(z.unknown()).min(1).max(40).optional(),
	ops: z.array(z.unknown()).min(1).max(40).optional(),
	summary: z.string().min(1).max(200).optional(),
});

export type EditArtifactToolInput = z.infer<typeof editArtifactInputSchema>;

/**
 * Composed from each type's own refusal vocabulary, not invented here
 * (ruling 43): Document's `RefusalReason`
 * (`services/artifacts/serialize/document.ts`, slice 1), Canvas's
 * `BoardRefusalReason` (`serialize/canvas.ts`, slice 3), Slides's
 * `SlideRefusalReason` (`serialize/slides.ts`, slice 4). None of those
 * modules exist in this worktree yet — Slice 5a lands right after Slice 0,
 * ahead of every type slice — so this union carries only 5a's OWN member,
 * `unsupported_kind` (no edit handler is registered for this artifact's kind
 * yet). Each type slice widens this union with `|` when it appends its
 * handler below; nobody redeclares it.
 */
export type ArtifactRefusalReason = "unsupported_kind";

export interface ArtifactRefusal {
	/** Document: blockId. Canvas: the op's target id. Slides: slideId. Unset for a whole-artifact refusal (e.g. `unsupported_kind`). */
	target?: string;
	/** Document: blockLabel. Slides: the SlideTarget. */
	label?: string;
	reason: ArtifactRefusalReason;
}

export type EditArtifactModelPayload =
	| {
			success: true;
			artifactId: string;
			versionId: string;
			applied: number;
			refused: ArtifactRefusal[];
	  }
	| {
			success: false;
			error: string;
			refused?: ArtifactRefusal[];
			/**
			 * Widened beyond slice-5.md's literal sketch: an unknown id is exactly
			 * the read_generated_file-style ambiguity read_artifact already answers
			 * with candidates, and the same courtesy belongs here — the model
			 * should not have to call read_artifact with a guessed id just to
			 * discover what IS in this conversation.
			 */
			candidates?: Array<{ artifactId: string; title: string }>;
	  };

export interface EditArtifactHandlerParams {
	userId: string;
	conversationId: string;
	turnId: string;
	artifactId: string;
	title: string;
	patches?: unknown[];
	ops?: unknown[];
	summary?: string;
}

export interface EditArtifactHandlerSuccess {
	versionId: string;
	applied: number;
	refused: ArtifactRefusal[];
}

/**
 * A registered handler dispatches into the SAME validator the type's ops
 * route uses (`applyDocumentPatch`, `validateBoardDiff`, `validateSlidePatch`)
 * — this tool owns only the payload envelope, never a second validator — then
 * writes the result through `updateArtifactBody`
 * (`$lib/server/services/artifacts`) with `author: "alfy"`.
 */
export type EditArtifactHandler = (
	params: EditArtifactHandlerParams,
) => Promise<
	| { ok: true; value: EditArtifactHandlerSuccess }
	| { ok: false; error: string; refused?: ArtifactRefusal[] }
>;

/**
 * The per-kind dispatch seam (rulings 43/44). Empty in Slice 5a: every kind
 * refuses with `unsupported_kind` until its type slice appends ONE entry
 * here — and only here. No type slice edits `normal-chat-tools/index.ts` or
 * `shared.ts`.
 */
export const EDIT_ARTIFACT_HANDLERS: Partial<
	Record<CreatableArtifactKind, EditArtifactHandler>
> = {};

// English only (see create.ts's identical note): App gets its own framing
// because "edited in place" will never be true for it even once Slice 2
// lands — an App's whole HTML is one generated unit, regenerated as a whole,
// never patched field-by-field the way a Document or Slides deck is. The
// other three kinds get the honest "not yet" message because they will.
const UNSUPPORTED_KIND_MESSAGES: Partial<
	Record<CreatableArtifactKind, string>
> = {
	app: "Apps are not edited in place — create a new App with the changes instead of patching this one.",
};

function unsupportedKindMessage(kind: CreatableArtifactKind): string {
	return (
		UNSUPPORTED_KIND_MESSAGES[kind] ??
		`This item's edits are not supported yet. Say so, and offer the closest alternative you can actually do.`
	);
}

export interface EditArtifactRunResult {
	modelPayload: EditArtifactModelPayload;
	outputSummary: string;
	metadata: Record<string, string | number | boolean | null>;
}

async function buildNotFoundResult(params: {
	userId: string;
	conversationId: string;
}): Promise<EditArtifactRunResult> {
	const entries = await listArtifactCatalogueEntries(params).catch(() => []);
	const error =
		"No item with that id exists in this conversation. Read it first, or use one of the candidates below.";
	return {
		modelPayload: {
			success: false,
			error,
			candidates: entries.map((entry) => ({
				artifactId: entry.artifactId,
				title: entry.title,
			})),
		},
		outputSummary: "Not found",
		metadata: { ok: false, found: false },
	};
}

/**
 * The tool's whole domain logic, independent of the AI SDK execution
 * envelope so it can be unit-tested directly.
 */
export async function runEditArtifactTool(params: {
	userId: string;
	conversationId: string;
	turnId: string;
	artifactId: string;
	patches?: unknown[];
	ops?: unknown[];
	summary?: string;
}): Promise<EditArtifactRunResult> {
	if (params.patches && params.ops) {
		const error = "Send patches or ops, never both in the same call.";
		return {
			modelPayload: { success: false, error },
			outputSummary: error,
			metadata: { ok: false },
		};
	}
	if (!params.patches && !params.ops) {
		const error =
			"Send patches (Document/Slides) or ops (Canvas) — this call had neither.";
		return {
			modelPayload: { success: false, error },
			outputSummary: error,
			metadata: { ok: false },
		};
	}

	const record = await getArtifact({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId,
	});
	// getArtifact/readScopedArtifactRow is scoped to "any conversation this
	// user can currently reach" (deliberately wide for its other caller,
	// GET /api/artifacts/[id]) — NOT to this one conversation. The catalogue
	// that hands the model ids is scoped to exactly this conversation, so
	// without this check the model could edit another of the user's own,
	// non-incognito conversations' artifacts just by naming its id. Treat
	// that exactly like the id does not exist, the same as read_artifact.
	if (!record || record.conversationId !== params.conversationId) {
		return buildNotFoundResult(params);
	}

	if (record.kind === "file") {
		const error =
			"Files are produced, not edited — produce_file makes a new one with the changes.";
		const refusal: ArtifactRefusal = {
			target: record.id,
			reason: "unsupported_kind",
		};
		return {
			modelPayload: { success: false, error, refused: [refusal] },
			outputSummary: truncateText(error, 200),
			metadata: {
				ok: false,
				artifactId: record.id,
				artifactKind: "file",
			},
		};
	}

	const handler = EDIT_ARTIFACT_HANDLERS[record.kind];
	if (!handler) {
		const error = unsupportedKindMessage(record.kind);
		const refusal: ArtifactRefusal = {
			target: record.id,
			reason: "unsupported_kind",
		};
		return {
			modelPayload: { success: false, error, refused: [refusal] },
			outputSummary: truncateText(error, 200),
			metadata: {
				ok: false,
				artifactId: record.id,
				artifactKind: record.kind,
			},
		};
	}

	const result = await handler({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId: params.turnId,
		artifactId: record.id,
		title: record.title,
		patches: params.patches,
		ops: params.ops,
		summary: params.summary,
	});
	if (!result.ok) {
		return {
			modelPayload: {
				success: false,
				error: result.error,
				refused: result.refused,
			},
			outputSummary: truncateText(result.error, 200),
			metadata: {
				ok: false,
				artifactId: record.id,
				artifactKind: record.kind,
			},
		};
	}

	const refusedCount = result.value.refused.length;
	const outputSummary = `Edited ${record.kind} "${record.title}" (${result.value.applied} applied${
		refusedCount > 0 ? `, ${refusedCount} refused` : ""
	})`;
	return {
		modelPayload: {
			success: true,
			artifactId: record.id,
			versionId: result.value.versionId,
			applied: result.value.applied,
			refused: result.value.refused,
		},
		outputSummary,
		metadata: {
			ok: true,
			artifactId: record.id,
			artifactKind: record.kind,
			artifactTitle: record.title,
		},
	};
}
