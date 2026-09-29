// create_artifact: make a Document, App, Canvas or Slides item that lives
// beside the chat (ADR-0066). "file" is produce_file's, not this tool's — see
// docs/plans/claude-at-home-2/slice-5.md §The three tools and decisions.md
// ruling 43 (this tool's shell, registration and the family-wide TOOL_I18N
// descriptions are Slice 5a's; each type slice appends ONLY its own entry to
// CREATE_ARTIFACT_HANDLERS below, in this file).
//
// CREATABLE_ARTIFACT_KINDS, CreatableArtifactKind, the handler types, the
// CREATE_ARTIFACT_HANDLERS dict itself, and advertisedArtifactKinds() live in
// the dependency-free kind-registry.ts, not here, and are re-exported below
// for every existing caller of this file. This file is where they get
// WRITTEN (createDocumentArtifact/createAppFromBrief need the artifacts
// service, sandbox config, and eventually config-store.ts — see
// kind-registry.ts's own header for the real circular import that chain
// caused when advertisedArtifactKinds() lived here instead).
import { z } from "zod";
import {
	createArtifact,
	createDocumentArtifact,
	prepareCanvasBoard,
} from "$lib/server/services/artifacts";
import { createAppFromBrief } from "$lib/server/services/artifacts/app/create";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import { truncateText } from "../shared";
import { parseCanvasCreateBody } from "./canvas-model";
import { artifactKindEnumPhrase, createArtifactBodyFormat } from "./kind-prose";
import {
	advertisedArtifactKinds,
	CREATE_ARTIFACT_HANDLERS,
	type CreatableArtifactKind,
	type CreateArtifactHandlerParams,
} from "./kind-registry";

// Used locally above; re-exported too, alongside the rest of kind-registry.ts's
// public surface that this file only passes through for its existing callers.
export {
	advertisedArtifactKinds,
	// Not used locally in this file — re-export only.
	CREATABLE_ARTIFACT_KINDS,
	CREATE_ARTIFACT_HANDLERS,
	type CreatableArtifactKind,
	type CreateArtifactHandler,
	type CreateArtifactHandlerParams,
	type CreateArtifactHandlerSuccess,
} from "./kind-registry";

/**
 * Counted and refused exactly the way produce_file's own per-turn cap is
 * (MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN, produce-file.ts) — every kind
 * shares one turn-wide counter, kept in index.ts's `createNormalChatTools`
 * closure, so it resets with every new turn. Harmless while every kind
 * instant-refuses with no handler registered, but once a real handler runs a
 * ~120s App generation, an unbounded loop of create_artifact calls in one
 * turn would otherwise have no guard at all.
 */
export const MAX_CREATE_ARTIFACT_CALLS_PER_TURN = 3;

/**
 * Zod's enum needs a non-empty tuple type, but the advertised set is only
 * known at runtime (whichever kinds have a registered create handler right
 * now) — `advertisedArtifactKinds()` below always returns at least
 * `["document"]`, so this cast is safe in practice.
 */
type NonEmptyKinds = [CreatableArtifactKind, ...CreatableArtifactKind[]];

/**
 * Advertised to the model: trimmed descriptions, no server-only bounds.
 * Built fresh from `kinds` (default: `advertisedArtifactKinds()`) rather
 * than once at module load, so a newly registered handler — in production or
 * in a test that pokes CREATE_ARTIFACT_HANDLERS directly — is reflected the
 * next time this is called, exactly like `createNormalChatTools` itself.
 */
export function buildCreateArtifactModelInputSchema(
	kinds: readonly CreatableArtifactKind[] = advertisedArtifactKinds(),
) {
	return z.object({
		artifactType: z
			.enum(kinds as NonEmptyKinds)
			.describe(artifactKindEnumPhrase(kinds)),
		title: z
			.string()
			.min(1)
			.describe("What the user will see in the card and the panel."),
		body: z.string().min(1).describe(createArtifactBodyFormat(kinds)),
	});
}

/** Executed against: the same fields, with the server's bounds applied. */
export function buildCreateArtifactInputSchema(
	kinds: readonly CreatableArtifactKind[] = advertisedArtifactKinds(),
) {
	return z.object({
		artifactType: z.enum(kinds as NonEmptyKinds),
		title: z.string().min(1).max(200),
		/** Documents: Markdown with `<!--b:id-->` markers. Apps: the HTML
		 *  document. Canvas/Slides join this once they have a handler — see
		 *  advertisedArtifactKinds() below and kind-prose.ts's own comment. */
		body: z.string().min(1),
	});
}

export type CreateArtifactToolInput = z.infer<
	ReturnType<typeof buildCreateArtifactInputSchema>
>;

export type CreateArtifactModelPayload =
	| {
			success: true;
			artifactId: string;
			artifactType: CreatableArtifactKind;
			title: string;
			versionId?: string;
	  }
	| { success: false; error: string };

// English only, mirroring every other tool's field-level `.describe()` text:
// only the top-level TOOL_I18N description/errorPrefix are bilingual.
const ARTIFACT_KIND_LABELS: Record<CreatableArtifactKind, string> = {
	document: "Document",
	app: "App",
	canvas: "Canvas",
	slides: "Slides",
};

// Slice 1: mint-before-hash happens INSIDE createDocumentArtifact's own
// createBody call (parseDocument runs before anything is hashed or stored —
// decisions.md's global constraints), so this handler is a thin envelope:
// validate the abort signal, write the row, report back. CREATE_ARTIFACT_HANDLERS
// itself (the per-kind dispatch seam, decisions.md rulings 43/44) lives in
// kind-registry.ts, starting empty; each type slice appends ONE entry here —
// and only here.
CREATE_ARTIFACT_HANDLERS.document = async (params) => {
	if (params.abortSignal.aborted) {
		return { ok: false, reason: "The request was cancelled." };
	}
	try {
		const artifact = await createDocumentArtifact({
			userId: params.userId,
			conversationId: params.conversationId,
			title: params.title,
			markdown: params.body,
			author: "alfy",
			summary: VERSION_SUMMARY.alfyFirstDraft,
			artifactId: params.artifactId,
		});
		return {
			ok: true,
			value: { artifactId: artifact.id, title: artifact.title },
		};
	} catch {
		return { ok: false, reason: "Could not create the document." };
	}
};

/**
 * The App branch (Task A7): a thin adapter over
 * `artifacts/app/create.ts`'s `createAppFromBrief`, which owns everything
 * substantive — the thinking-off generation call, the fact-verification
 * pass and its ruling-52 repair/re-verify gate, and the `createArtifact`
 * write with `author: "alfy"`. The model's `body` is its BRIEF (what to
 * build), never HTML it wrote itself: the App contract forbids the chat
 * model from producing the actual markup, so this handler passes `body`
 * straight through as the generation prompt and nothing else ever reaches
 * the model — no HTML, not even on failure (see the file's own A7.4 test).
 *
 * `createAppFromBrief` is a normal static import again (ruling 57): its own
 * chain (generate-and-verify.ts → verify.ts) used to reach back into
 * `normal-chat-tools/index.ts` for the verifier's `research_web` tool, which
 * closed a static cycle back through this very file, which `index.ts`
 * imports to register `create_artifact`. Now that `verify.ts` builds
 * `research_web` through its own module (`research-web-tool.ts`) instead of
 * `createNormalChatTools`, that cycle is gone (Fallow's circular count is
 * back to 4), and the dynamic `import()` this file used to defer it no
 * longer serves a purpose.
 */
CREATE_ARTIFACT_HANDLERS.app = async (params) => {
	const result = await createAppFromBrief({
		userId: params.userId,
		conversationId: params.conversationId,
		prompt: params.body,
		title: params.title,
		language: params.language,
		abortSignal: params.abortSignal,
		artifactId: params.artifactId,
	});
	if (!result.ok) {
		return { ok: false, reason: result.detail };
	}
	return {
		ok: true,
		value: { artifactId: result.artifactId, title: result.title },
	};
};

/**
 * The Canvas branch (Slice 3): the model's `body` is the board JSON — or empty,
 * or `{}`, for an empty board. `parseCanvasCreateBody` judges it by the board's
 * own vocabulary (the same validator an edit runs), and any refusal refuses the
 * WHOLE create with a message that names the fix: a board quietly thinner than
 * the one the model described is worse than one that says why it was not made.
 * What is stored went through `prepareCanvasBoard`, the one gate a board passes
 * on its way into storage (canonical JSON, its caps, the family's one hash), and
 * is written under the id it is given when Regenerate re-runs this handler.
 * Ruling 53: the abort signal is checked before the write, and a failure writes
 * nothing.
 */
CREATE_ARTIFACT_HANDLERS.canvas = async (params) => {
	if (params.abortSignal.aborted) {
		return { ok: false, reason: "The request was cancelled." };
	}
	const parsed = parseCanvasCreateBody(params.body);
	if (!parsed.ok) return { ok: false, reason: parsed.error };

	const prepared = prepareCanvasBoard(JSON.stringify(parsed.body));
	if (!prepared.ok) {
		return {
			ok: false,
			reason:
				prepared.reason === "invalid_body"
					? "The board could not be read. Send it as a JSON object with nodes and edges."
					: "The board is larger than a board may be. Make it smaller: fewer or shorter blocks.",
		};
	}
	// The board was judged block by block above, so nothing should be left out
	// here — but a board that lost a block on its way in would be the silent kind
	// of thin, so it is refused instead of stored.
	const dropped = [
		...prepared.dropped.nodes,
		...prepared.dropped.edges,
		...prepared.dropped.annotations,
	];
	if (dropped.length > 0) {
		return {
			ok: false,
			reason: `Nothing was created: the board would have left out ${dropped.slice(0, 6).join(", ")}. Check those ids and call create_artifact again.`,
		};
	}
	if (params.abortSignal.aborted) {
		return { ok: false, reason: "The request was cancelled." };
	}

	const created = await createArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		id: params.artifactId,
		kind: "canvas",
		title: params.title,
		body: prepared.json,
		author: "alfy",
		versionSummary: VERSION_SUMMARY.alfyFirstDraft,
	});
	if (!created.ok) {
		return {
			ok: false,
			reason:
				created.reason === "invalid_title"
					? "The board needs a title."
					: "Could not create the board.",
		};
	}
	return {
		ok: true,
		value: { artifactId: created.artifact.id, title: created.artifact.title },
	};
};

export interface CreateArtifactRunResult {
	modelPayload: CreateArtifactModelPayload;
	outputSummary: string;
	metadata: Record<string, string | number | boolean | null>;
}

/**
 * The tool's whole domain logic, independent of the AI SDK execution
 * envelope so it can be unit-tested directly (`index.ts`'s `execute` closure
 * only adds the `ToolCallEntry` plumbing options.toolCallId/status require).
 */
export async function runCreateArtifactTool(
	params: CreateArtifactHandlerParams & { artifactType: CreatableArtifactKind },
): Promise<CreateArtifactRunResult> {
	const handler = CREATE_ARTIFACT_HANDLERS[params.artifactType];
	if (!handler) {
		const label = ARTIFACT_KIND_LABELS[params.artifactType];
		const error = `${label} items cannot be made yet. Say so, and offer the closest alternative you can actually do.`;
		return {
			modelPayload: { success: false, error },
			outputSummary: truncateText(error, 200),
			metadata: { ok: false },
		};
	}

	const result = await handler({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId: params.turnId,
		title: params.title,
		body: params.body,
		language: params.language,
		abortSignal: params.abortSignal,
		artifactId: params.artifactId,
	});

	if (!result.ok) {
		return {
			modelPayload: { success: false, error: result.reason },
			outputSummary: truncateText(result.reason, 200),
			metadata: { ok: false, artifactKind: params.artifactType },
		};
	}

	const label = ARTIFACT_KIND_LABELS[params.artifactType];
	return {
		modelPayload: {
			success: true,
			artifactId: result.value.artifactId,
			artifactType: params.artifactType,
			title: result.value.title,
			versionId: result.value.versionId,
		},
		outputSummary: `Created ${label} "${result.value.title}"`,
		metadata: {
			ok: true,
			artifactId: result.value.artifactId,
			artifactKind: params.artifactType,
			artifactTitle: result.value.title,
		},
	};
}
