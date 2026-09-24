/**
 * Personal and project instruction rules, shared verbatim between the
 * browser (the dialog's live counter and its disabled Save button) and the
 * server (the settings PATCH route). AGENTS.md forbids a second copy of a
 * validation rule, and the two copies must agree exactly: a counter that
 * says "2,000 / 2,000" over text the server rejects is the failure mode this
 * file exists to prevent.
 *
 * Client-safe: no server imports, no DB, no env.
 */

/**
 * Maximum instruction length, counted as Unicode code points.
 *
 * Code points, not UTF-16 units: "ő" and "👍" are each one character to the
 * user even though JS string indexing sees one and two units respectively.
 * Counting units would reject a Hungarian or emoji-heavy text the counter
 * called fine.
 */
export const INSTRUCTIONS_MAX_CHARS = 2000;

export type InstructionScopeKind = "personal" | "project";

export interface InstructionScope {
	kind: InstructionScopeKind;
	/** Present only for kind === "project". */
	projectId?: string;
	/** Project name for the token; absent for kind === "personal". */
	name?: string;
}

/**
 * Which instruction blocks shaped one assistant turn, as persisted on the
 * message and rendered as tokens in the Info popover. It says *which scope*
 * applied, never what it said: the text itself must not reach a surface that
 * can be shown on a shared screen.
 */
export interface InstructionScopeApplication {
	personal: boolean;
	/** Set only when the project instruction block applied. */
	projectId?: string;
}

/**
 * The instruction blocks that actually made it into one turn's prompt, as the
 * turn's own resolved instructions describe them.
 *
 * A pure mapping from the resolved value to the record that gets persisted,
 * so the reported scope cannot drift from the sections the model got. Both
 * sides test the same thing — "is there text?" — which is why an empty string
 * counts as nothing applied: prompt assembly renders no section for one, and
 * a record saying otherwise would be a lie about a section that is not there.
 * Returns `undefined` — never a falsy record — when no block applied, so an
 * absent record and an empty one cannot both exist.
 */
export function resolveInstructionScopeApplication(
	instructions:
		| {
				personal: string | null;
				project: { id: string } | null;
		  }
		| null
		| undefined,
): InstructionScopeApplication | undefined {
	if (!instructions) return undefined;
	const personal = Boolean(instructions.personal);
	const projectId = instructions.project?.id;
	if (!personal && projectId === undefined) return undefined;
	return {
		personal,
		...(projectId === undefined ? {} : { projectId }),
	};
}

/** Counts code points, so "👍" is 1 and "é" is 1. */
export function countInstructionChars(text: string): number {
	return [...text].length;
}

/**
 * "" after trim becomes null, so clearing the box and never having set it
 * are the same stored state — there is no `NULL`-vs-`""` ambiguity to reason
 * about later.
 */
export function normalizeInstructionText(text: string): string | null {
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export type InstructionValidation =
	| { ok: true; value: string | null }
	| { ok: false; error: "not_a_string" | "too_long" };

/**
 * `raw` is the untrusted JSON body value.
 *
 * Always `ok: false` on overflow — never a truncated `ok: true`. Silent
 * truncation would store text the user never saw, which is exactly what the
 * "nothing is saved without the user seeing the full text" rule forbids.
 */
export function validateInstructionInput(raw: unknown): InstructionValidation {
	if (raw === null || raw === undefined) {
		return { ok: true, value: null };
	}
	if (typeof raw !== "string") {
		return { ok: false, error: "not_a_string" };
	}
	const normalized = normalizeInstructionText(raw);
	if (normalized === null) {
		return { ok: true, value: null };
	}
	// Measured after trimming, so whitespace the user cannot see can never
	// push an otherwise valid text over the limit.
	if (countInstructionChars(normalized) > INSTRUCTIONS_MAX_CHARS) {
		return { ok: false, error: "too_long" };
	}
	return { ok: true, value: normalized };
}

/**
 * The key a scope's text is stored under in `InstructionsDialog`'s
 * `initialText` map and in the per-scope buffers.
 */
export function instructionScopeKey(scope: InstructionScope): string {
	return scope.kind === "project" && scope.projectId
		? `project:${scope.projectId}`
		: "personal";
}
