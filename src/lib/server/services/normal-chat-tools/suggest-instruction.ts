/**
 * `suggest_instruction` — the offer to write a standing instruction the user
 * just stated as a rule.
 *
 * The tool is the *only* thing that creates an offer, and it creates nothing
 * durable: the text becomes a suggestion on this turn's assistant message, the
 * user reviews it, and only `InstructionsDialog`'s Save writes anything. This
 * module owns the parts that must agree with the browser — the input schema,
 * the payloads the model reads, and the shape of the recorded offer.
 *
 * It stays free of the tool registry, DB reads and prompt wording: registration
 * lives in `index.ts` (like every other tool) and the project lookup is passed
 * in, so the clamping rule can be tested without a database.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	countInstructionChars,
	INSTRUCTIONS_MAX_CHARS,
	type InstructionScope,
	type InstructionSuggestion,
	validateInstructionInput,
} from "$lib/shared/instructions";

export const suggestInstructionInputSchema = z.object({
	text: z
		.string()
		.min(1)
		// Counted in code points, exactly as the instruction limit counts them
		// ($lib/shared/instructions.ts, which is the rule the dialog's counter
		// and the settings route already share): zod's own `.max()` counts
		// UTF-16 units, so 1,001 emoji would be a "2,001 character" text to the
		// schema and a 1,001-character text to the user.
		.refine((value) => countInstructionChars(value) <= INSTRUCTIONS_MAX_CHARS, {
			message: `Instruction text must be at most ${INSTRUCTIONS_MAX_CHARS} characters.`,
		}),
	// The scope the model thinks the rule belongs to. It names no ids: a
	// project scope is only honoured when the conversation is actually in a
	// project, which the server decides.
	scope: z.enum(["personal", "project"]).optional(),
});

export type SuggestInstructionInput = z.infer<
	typeof suggestInstructionInputSchema
>;

/** Why an offer was not taken. Everything here is model-correctable. */
export type SuggestInstructionRefusalReason =
	| "already_offered"
	| "empty_text"
	| "text_too_long";

export interface SuggestInstructionOfferedPayload {
	ok: true;
	offered: true;
	/** The scope the offer will actually target, after clamping. */
	scope: "personal" | "project";
	/** What happens next, so the model does not narrate the offer instead. */
	note: string;
}

export interface SuggestInstructionRefusedPayload {
	ok: false;
	offered: false;
	reason: SuggestInstructionRefusalReason;
	message: string;
}

export type SuggestInstructionModelPayload =
	| SuggestInstructionOfferedPayload
	| SuggestInstructionRefusedPayload;

/**
 * A failure of the tool itself (a read that threw, a timeout, an abort) —
 * deliberately not a `SuggestInstructionRefusedPayload`: a refusal is a
 * decision the model can act on, and reporting one for a broken read would
 * tell it to stop offering something that was never actually considered.
 */
export interface SuggestInstructionFailurePayload {
	ok: false;
	offered: false;
	errorCode: "suggest_instruction_failed";
	message: string;
}

// Model-facing English, like every other tool payload (the *description* is
// localized; the payload the model reads is not).
const REFUSAL_MESSAGES: Record<SuggestInstructionRefusalReason, string> = {
	already_offered:
		"One instruction suggestion is allowed per turn, and this turn already made one. Do not offer another one; keep answering the user's message instead.",
	empty_text:
		"The suggested instruction was empty. Offer the rule in the user's own words, or do not offer one at all.",
	text_too_long: `The suggested instruction is over the ${INSTRUCTIONS_MAX_CHARS} character limit. Say the rule in fewer words, or do not offer it.`,
};

export function buildSuggestInstructionRefusal(
	reason: SuggestInstructionRefusalReason,
): SuggestInstructionRefusedPayload {
	return {
		ok: false,
		offered: false,
		reason,
		message: REFUSAL_MESSAGES[reason],
	};
}

export function buildSuggestInstructionOffered(params: {
	scope: InstructionScope;
}): SuggestInstructionOfferedPayload {
	return {
		ok: true,
		offered: true,
		scope: params.scope.kind === "project" ? "project" : "personal",
		note: "The user now sees this offer with a Review and a Dismiss button. Nothing is saved until they review it, and the row is the offer — do not repeat it in prose.",
	};
}

/**
 * The offer as it will be persisted: pending until the user answers it, with
 * the text the user is about to read.
 *
 * `id` and `createdAt` are minted here rather than at persistence time because
 * the row's Dismiss/Review actions address the suggestion by id, and the
 * message does not exist yet while the tool runs.
 */
export function buildInstructionSuggestion(params: {
	text: string;
	scope: InstructionScope;
	now?: number;
	id?: string;
}): InstructionSuggestion {
	return {
		id: params.id ?? randomUUID(),
		status: "pending",
		text: params.text,
		scope: params.scope,
		createdAt: params.now ?? Date.now(),
	};
}

/**
 * The offered text, or null when the model sent something an offer cannot
 * carry.
 *
 * Blank text is a refusal and not an empty offer: `validateInstructionInput`
 * reads whitespace-only text as "clear the instructions", which is a real
 * action in the dialog but not a suggestion anything can be shown for.
 */
export function normalizeSuggestedInstruction(
	raw: string,
):
	| { ok: true; text: string }
	| { ok: false; reason: "empty_text" | "text_too_long" } {
	const validated = validateInstructionInput(raw);
	if (!validated.ok) return { ok: false, reason: "text_too_long" };
	if (validated.value === null) return { ok: false, reason: "empty_text" };
	return { ok: true, text: validated.value };
}

/**
 * Which scope a `"project"` request really targets: the conversation's project
 * when it has one, personal otherwise — the model is never trusted to name a
 * project, and never sees an id either way.
 */
export function resolveOfferedScope(params: {
	requestedScope: "personal" | "project" | undefined;
	project: { id: string; name: string } | null;
}): InstructionScope {
	if (params.requestedScope !== "project" || !params.project) {
		return { kind: "personal" };
	}
	return {
		kind: "project",
		projectId: params.project.id,
		name: params.project.name,
	};
}
