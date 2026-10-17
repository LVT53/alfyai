import { json } from "@sveltejs/kit";
import {
	readSecondFactorBody,
	runGuardedSecondFactor,
	secondFactorFailureResponse,
} from "$lib/server/api/second-factor";
import { requireAuth } from "$lib/server/auth/hooks";
import { regenerateBackupCodes } from "$lib/server/services/two-step";
import type { RequestHandler } from "./$types";

/**
 * Replaces the ten backup codes after a current code (or a backup code), and
 * returns the new ones once. The old codes stop working in the same
 * transaction that writes the new ones.
 */
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;

	const parsed = await readSecondFactorBody(event.request);
	if (!parsed.ok) return parsed.response;

	const guarded = await runGuardedSecondFactor(userId, () =>
		regenerateBackupCodes(userId, parsed.input, new Date()),
	);
	if ("response" in guarded) return guarded.response;

	const result = guarded.result;
	if (!result.ok) return secondFactorFailureResponse(result.reason);

	return json({ success: true, backupCodes: result.backupCodes });
};
