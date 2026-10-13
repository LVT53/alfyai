import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { isInsideToolCall, markCallLocallyDistilled } from "./shared";

// Option A (locality) — the shared "should we distill, and if so what did the
// local model produce" decision used by every connector-backed chat tool
// (files.ts, calendar.ts, ...) that would otherwise inline raw connector text
// into the model-bound payload. Each tool still owns its own domain-specific
// stripping of the raw fields and message rebuilding — the payload shapes
// differ too much (a file's body text vs. a calendar event's summary/
// location) to unify that part — but the "is Option A active for this turn,
// and what's the distilled replacement" logic is identical everywhere, so it
// lives here once instead of being copy-pasted per tool. Originally
// (issue 2.3/3.2) this lived inline in files.ts as `applyLocalDistillGate`;
// factored out here in 5.2 so the calendar tool can reuse the same decision
// without duplicating the hasLocalDistillEnabled/isCloudModel/
// distillConnectorPayload wiring.
export type LocalDistillDecision =
	| { shouldDistill: false }
	| { shouldDistill: true; distilled: string }
	| { shouldDistill: true; unavailable: true };

type DistillQuestion = {
	userId: string;
	modelId: string;
	capability: string;
	userQuestion: string;
	rawText: string;
};

async function decide(
	params: DistillQuestion,
	marksCall: boolean,
): Promise<LocalDistillDecision> {
	const shouldDistill =
		(await hasLocalDistillEnabled(params.userId)) &&
		(await isCloudModel(params.modelId));
	if (!shouldDistill) return { shouldDistill: false };

	// Fail closed, and before the local model reads anything: a summary asked for
	// with no tool call to carry the mark would later count as a tool's own words.
	if (marksCall && !isInsideToolCall()) {
		throw new Error(
			"A local summary was asked for outside a tool call, so there is no call to mark (ADR-0068). A summary that goes into the prompt asks with decideLocalDistillForPrompt.",
		);
	}

	const result = await distillConnectorPayload({
		userId: params.userId,
		capability: params.capability,
		userQuestion: params.userQuestion,
		rawText: params.rawText,
	});
	if ("distilled" in result) {
		// Every summary a tool result carries is asked for here, by the read gate
		// below and by the write proposals that call this directly, so this marks
		// the tool call it goes into: an address in it is the local model's, not a
		// tool's (ADR-0068).
		if (marksCall) markCallLocallyDistilled();
		return { shouldDistill: true, distilled: result.distilled };
	}
	return { shouldDistill: true, unavailable: true };
}

/**
 * A summary for a TOOL RESULT: asked for inside a tool call (every connector
 * tool runs in `executeToolWithEnvelope`), which it marks, and refused outside
 * one.
 */
export function decideLocalDistill(
	params: DistillQuestion,
): Promise<LocalDistillDecision> {
	return decide(params, true);
}

/**
 * A summary for the PROMPT: the proactive connector block, which is spliced
 * into this turn's prompt and never into a tool result. An address in the prompt
 * does not count for fetch_url or produce_file whoever wrote it, so there is no
 * call to mark and none is asked for. This is the one caller that is not a tool
 * (`connector-distill.test.ts` holds the list of who asks).
 */
export function decideLocalDistillForPrompt(
	params: DistillQuestion,
): Promise<LocalDistillDecision> {
	return decide(params, false);
}

// The shared Option-A gate every connector-backed tool wraps its read outcome
// in. Each tool used to re-declare a near-identical `applyLocalDistillGate`
// that repeated the SAME control flow — bail on a failed outcome, bail when
// there's no raw connector text to protect, run decideLocalDistill, bail when
// the gate is inactive, then rebuild the outcome for the distilled vs.
// unavailable case. Only two things genuinely differ per tool: how the raw
// text is assembled from the payload, and how the payload's raw fields are
// stripped/redacted afterward — so those stay at the call site (the tool
// assembles `rawText` and supplies `onDistilled`/`onUnavailable` rebuilders),
// while this helper owns the identical gating in one place. `rawText === ""`
// means "nothing raw to protect" and short-circuits to a no-op WITHOUT calling
// the local model, preserving each tool's prior empty-list early return.
export async function applyLocalDistillGate<
	T extends { modelPayload: { success: boolean } },
>(params: {
	outcome: T;
	userId: string;
	modelId: string;
	capability: string;
	userQuestion: string;
	rawText: string;
	onDistilled: (outcome: T, distilled: string) => T;
	onUnavailable: (outcome: T) => T;
}): Promise<T> {
	if (!params.outcome.modelPayload.success) return params.outcome;
	if (params.rawText.length === 0) return params.outcome;

	const decision = await decideLocalDistill({
		userId: params.userId,
		modelId: params.modelId,
		capability: params.capability,
		userQuestion: params.userQuestion,
		rawText: params.rawText,
	});
	if (!decision.shouldDistill) return params.outcome;
	if ("distilled" in decision) {
		return params.onDistilled(params.outcome, decision.distilled);
	}
	return params.onUnavailable(params.outcome);
}
