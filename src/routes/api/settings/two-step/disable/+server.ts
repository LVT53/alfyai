import { json } from "@sveltejs/kit";
import {
	readSecondFactorBody,
	runGuardedSecondFactor,
	secondFactorFailureResponse,
} from "$lib/server/api/second-factor";
import { requireAuth } from "$lib/server/auth/hooks";
import { disableTwoStep } from "$lib/server/services/two-step";
import type { RequestHandler } from "./$types";

/**
 * Turns two-step sign-in off after a current code (or a backup code): deletes
 * the factor and every backup code. Already off reads as success, so a
 * repeated click is harmless.
 */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;

	const parsed = await readSecondFactorBody(event.request);
	if (!parsed.ok) return parsed.response;

	const guarded = await runGuardedSecondFactor(userId, () =>
		disableTwoStep(userId, parsed.input, new Date()),
	);
	if ("response" in guarded) return guarded.response;

	const result = guarded.result;
	if (!result.ok) return secondFactorFailureResponse(result.reason);

	return json({ success: true, wasOn: result.disabled });
};
