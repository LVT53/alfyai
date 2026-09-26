// The lightweight home for "which artifact kinds exist" (Feature 2 ·
// Artifacts). Deliberately dependency-free: create.ts's own handler closures
// call into createDocumentArtifact/createAppFromBrief, which pull in the
// artifacts service, sandbox config, and eventually config-store.ts. Reading
// "what's advertised right now" (edit.ts's advertised schema, index.ts's
// TOOL_I18N descriptions, both via kind-prose.ts, and tests) should never
// have to pull that chain in just to ask a question — and MUST not, for any
// caller that reads it at its own module's top level rather than inside a
// function body: config-store.ts is itself imported by prompts.ts, so a
// caller like that closes create.ts → artifacts/… → config-store.ts →
// prompts.ts → create.ts, a real circular import (caught by create.test.ts's
// own red run — see the commit this file was added in). This is also why
// prompts.ts's own artifact-kinds paragraph is a plain literal rather than a
// call to advertisedArtifactKinds() at all — see its comment there. This
// file has no imports at all, so nothing that reads it can ever be part of a
// cycle through it.
//
// create.ts is still the ONLY file that WRITES a handler into
// CREATE_ARTIFACT_HANDLERS (ruling 43 — one file per type slice) and
// re-exports everything here for its existing callers; this file just holds
// the dict and the kinds so reading "what's advertised" never has to pull in
// the writing side's heavy dependencies.

export const CREATABLE_ARTIFACT_KINDS = [
	"document",
	"app",
	"canvas",
	"slides",
] as const;

export type CreatableArtifactKind = (typeof CREATABLE_ARTIFACT_KINDS)[number];

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
 * The per-kind dispatch seam (decisions.md rulings 43/44), written to ONLY
 * from create.ts — each type slice appends ONE entry there, and only there.
 * This dict starts empty; create.ts populates it as a side effect of being
 * imported.
 */
export const CREATE_ARTIFACT_HANDLERS: Partial<
	Record<CreatableArtifactKind, CreateArtifactHandler>
> = {};

/**
 * The kinds actually advertised to the model right now: exactly the ones
 * with a registered handler above, in CREATABLE_ARTIFACT_KINDS' canonical
 * order. This is the ONE source create_artifact's/edit_artifact's advertised
 * schemas and their TOOL_I18N descriptions read (through kind-prose.ts's
 * assembly functions, called at request time inside createNormalChatTools)
 * — never a second hand-kept "which kinds exist" list. Canvas and Slides
 * join automatically the moment their own type slice appends a handler in
 * create.ts; nobody has to remember to tell the model separately in those
 * two places. The base prompt's artifact paragraph (`prompts.ts`) is the one
 * deliberate exception — see its own comment for why it stays a hand-edited
 * literal, cross-checked against this function by a test instead of calling
 * it directly.
 *
 * Reading this never triggers create.ts's own module evaluation (see this
 * file's header) — a caller that reads it eagerly, at ITS OWN module's top
 * level rather than inside a function body called later, should import this
 * (and CreatableArtifactKind) from here rather than from create.ts, or it
 * risks seeing an empty registry (nothing registered yet) or, worse, the
 * circular-import crash this file's header describes.
 */
export function advertisedArtifactKinds(): readonly CreatableArtifactKind[] {
	return CREATABLE_ARTIFACT_KINDS.filter(
		(kind) => CREATE_ARTIFACT_HANDLERS[kind] !== undefined,
	);
}
