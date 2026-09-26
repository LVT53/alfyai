// create_artifact: make a Document, App, Canvas or Slides item that lives
// beside the chat (ADR-0066). "file" is produce_file's, not this tool's — see
// docs/plans/claude-at-home-2/slice-5.md §The three tools and decisions.md
// ruling 43 (this tool's shell, registration and the family-wide TOOL_I18N
// descriptions are Slice 5a's; each type slice appends ONLY its own entry to
// CREATE_ARTIFACT_HANDLERS below, in this file).
import { z } from "zod";
import { createAppFromBrief } from "$lib/server/services/artifacts/app/create";
import { truncateText } from "../shared";

/** The four types Alfy may create. "file" is produce_file's, not this tool's. */
export const CREATABLE_ARTIFACT_KINDS = [
	"document",
	"app",
	"canvas",
	"slides",
] as const;

export type CreatableArtifactKind = (typeof CREATABLE_ARTIFACT_KINDS)[number];

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

/** Advertised to the model: trimmed descriptions, no server-only bounds. */
export const createArtifactModelInputSchema = z.object({
	artifactType: z
		.enum(CREATABLE_ARTIFACT_KINDS)
		.describe("document, app, canvas or slides"),
	title: z
		.string()
		.min(1)
		.describe("What the user will see in the card and the panel."),
	body: z
		.string()
		.min(1)
		.describe(
			"Documents: Markdown. Slides: the deck JSON. Canvas: the board JSON, or empty for a new board. Apps: the HTML document.",
		),
});

/** Executed against: the same fields, with the server's bounds applied. */
export const createArtifactInputSchema = z.object({
	artifactType: z.enum(CREATABLE_ARTIFACT_KINDS),
	title: z.string().min(1).max(200),
	/** Documents: Markdown with `<!--b:id-->` markers. Slides: the deck JSON.
	 *  Canvas: the board JSON, or empty for a new board. Apps: the HTML document. */
	body: z.string().min(1),
});

export type CreateArtifactToolInput = z.infer<typeof createArtifactInputSchema>;

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

export interface CreateArtifactHandlerParams {
	userId: string;
	conversationId: string;
	turnId: string;
	title: string;
	body: string;
	/**
	 * The turn's own reply language (decisions.md ruling 55), resolved ONCE by
	 * `resolveTurnResponseLanguage` and carried on `CreateNormalChatToolsContext.language`
	 * — never re-detected per kind. The App handler uses this instead of running
	 * `detectLanguage` on its own brief, which read an English brief full of
	 * Hungarian-looking letter pairs as Hungarian. A kind with no language-
	 * sensitive output (Document, Canvas, Slides today) may ignore this field.
	 */
	language: "en" | "hu";
	/**
	 * Fires on the tool's own timeout (120s, TOOL_TIMEOUTS_MS.create_artifact)
	 * or the turn's own stop/disconnect — whichever comes first, the same
	 * combined signal executeToolWithEnvelope already builds for every other
	 * tool. A handler MUST check `abortSignal.aborted` before any write (the
	 * model was already told the call failed once either fires, so a write
	 * after that point is an orphan the user never asked for and a duplicate
	 * when the model retries), and pass it to any model call it makes so that
	 * call is cancelled too rather than left running unattended.
	 */
	abortSignal: AbortSignal;
}

export interface CreateArtifactHandlerSuccess {
	artifactId: string;
	title: string;
	/** Omitted when the kind's handler does not produce a version row (rare). */
	versionId?: string;
}

/**
 * A registered handler owns everything about making its kind: validating and
 * transforming the model's raw `body` (Document mints block ids immediately
 * after parsing — see decisions.md's global constraints; Canvas/Slides
 * validate their JSON; App runs its own thinking-off generation + a
 * verification pass, see plan.md §Global Constraints), then writes the row
 * through `createArtifact` (`$lib/server/services/artifacts`) with
 * `author: "alfy"` — the model made this, not the user. Returns `ok: false`
 * with a model-safe reason on any domain refusal; never throws for an
 * expected refusal (a throw is for the envelope's timeout/abort path only).
 */
export type CreateArtifactHandler = (
	params: CreateArtifactHandlerParams,
) => Promise<
	| { ok: true; value: CreateArtifactHandlerSuccess }
	| { ok: false; reason: string }
>;

/**
 * The per-kind dispatch seam (decisions.md rulings 43/44). Empty in Slice 5a:
 * no type slice has landed yet, so every kind refuses with a model-safe "not
 * yet" message. Slice 1 (document), Slice 2 (app), Slice 3 (canvas) and
 * Slice 4 (slides) each append ONE entry here — and only here. No type slice
 * edits `normal-chat-tools/index.ts` or `shared.ts` (ruling 43).
 */
export const CREATE_ARTIFACT_HANDLERS: Partial<
	Record<CreatableArtifactKind, CreateArtifactHandler>
> = {};

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
	});
	if (!result.ok) {
		return { ok: false, reason: result.detail };
	}
	return {
		ok: true,
		value: { artifactId: result.artifactId, title: result.title },
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
