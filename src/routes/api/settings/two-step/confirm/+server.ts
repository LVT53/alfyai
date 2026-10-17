import { json } from "@sveltejs/kit";
import {
	readSecondFactorBody,
	runGuardedSecondFactor,
	secondFactorFailureResponse,
} from "$lib/server/api/second-factor";
import { requireAuth } from "$lib/server/auth/hooks";
import { confirmTwoStepSetup } from "$lib/server/services/two-step";
import type { RequestHandler } from "./$types";

/**
 * Step 2 of setup: a working code turns the factor on, creates the ten backup
 * codes (returned once, in clear) and signs out the other devices, all in one
 * transaction (R10). The current session's token is kept.
 *
 * Wrong codes share the account's limiter budget (R11), so a lockout is 429.
 */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;

	const parsed = await readSecondFactorBody(event.request);
	if (!parsed.ok) return parsed.response;

	const guarded = await runGuardedSecondFactor(userId, () =>
		confirmTwoStepSetup(
			userId,
			parsed.input.code ?? "",
			new Date(),
			event.cookies.get("session") ?? null,
		),
	);
	if ("response" in guarded) return guarded.response;

	const result = guarded.result;
	if (!result.ok) return secondFactorFailureResponse(result.reason);

	return json({
		success: true,
		backupCodes: result.backupCodes,
		signedOutOtherDevices: result.signedOutOtherDevices,
	});
};
