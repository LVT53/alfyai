import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";

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

export async function decideLocalDistill(params: {
	userId: string;
	modelId: string;
	capability: string;
	userQuestion: string;
	rawText: string;
}): Promise<LocalDistillDecision> {
	const shouldDistill =
		(await hasLocalDistillEnabled(params.userId)) &&
		(await isCloudModel(params.modelId));
	if (!shouldDistill) return { shouldDistill: false };

	const result = await distillConnectorPayload({
		userId: params.userId,
		capability: params.capability,
		userQuestion: params.userQuestion,
		rawText: params.rawText,
	});
	if ("distilled" in result) {
		return { shouldDistill: true, distilled: result.distilled };
	}
	return { shouldDistill: true, unavailable: true };
}
