import { json } from "@sveltejs/kit";
import {
	guardCredentialCheck,
	type LoginRateLimitBlock,
	recordLoginFailure,
	recordLoginSuccess,
} from "$lib/server/services/login-rate-limit";
import type { SecondFactorInput } from "$lib/server/services/two-step";

/**
 * The route-side half of the second-factor checks (R11): one place for the
 * limiter, the request body and the refusals, so Turn off, New backup codes,
 * the setup's confirm and the admin's own code in a reset all count wrong
 * codes with the same `account:` budget as `checkCurrentPassword`, and all
 * answer in the same words.
 *
 * The service verifies; this file decides what a refusal looks like over
 * HTTP. It never sees a code it has not been handed, and logs none.
 */

const TOO_MANY_CODES_KEY = "profileTab.twoStepTooManyAttempts";
const TOO_MANY_CODES_MESSAGE =
	"Too many wrong codes. Please wait a moment and try again.";

/** The 429 for a wrong-code check that is over the limiter's budget. */
export function tooManyWrongCodes(block: LoginRateLimitBlock): Response {
	return json(
		{ error: TOO_MANY_CODES_MESSAGE, errorKey: TOO_MANY_CODES_KEY },
		{
			status: 429,
			headers: { "Retry-After": String(block.retryAfterSeconds) },
		},
	);
}

/** The refusal sentences Settings and the admin dialog localize. */
export function secondFactorFailureResponse(reason: string): Response {
	switch (reason) {
		case "wrong_code":
			return json(
				{
					error: "That code didn't work.",
					errorKey: "profileTab.twoStepWrongCode",
				},
				{ status: 401 },
			);
		case "unreadable_secret":
			return json(
				{
					error: "Two-step sign-in is unavailable. Contact your admin.",
					errorKey: "profileTab.twoStepUnavailable",
				},
				{ status: 409 },
			);
		case "not_enabled":
			return json(
				{
					error: "Two-step sign-in is not on.",
					errorKey: "profileTab.twoStepNotOn",
				},
				{ status: 409 },
			);
		case "no_setup":
			return json(
				{
					error: "Start the setup again.",
					errorKey: "profileTab.twoStepNoSetup",
				},
				{ status: 409 },
			);
		case "already_on":
			return json(
				{
					error: "Two-step sign-in is already on. Turn it off first.",
					errorKey: "profileTab.twoStepAlreadyOn",
				},
				{ status: 409 },
			);
		default:
			return json(
				{
					error: "Two-step sign-in could not complete.",
					errorKey: "profileTab.twoStepUnavailable",
				},
				{ status: 400 },
			);
	}
}

type ParsedBody =
	| { ok: true; input: SecondFactorInput }
	| { ok: false; response: Response };

/**
 * `{ code }` or `{ backupCode }`, exactly one. Anything else is a 400 before a
 * single comparison runs.
 */
export async function readSecondFactorBody(
	request: Request,
): Promise<ParsedBody> {
	let body: { code?: unknown; backupCode?: unknown };
	try {
		body = await request.json();
	} catch {
		return {
			ok: false,
			response: json({ error: "Invalid JSON" }, { status: 400 }),
		};
	}

	const code = typeof body.code === "string" ? body.code.trim() : "";
	const backupCode =
		typeof body.backupCode === "string" ? body.backupCode.trim() : "";

	if (code && backupCode) {
		return {
			ok: false,
			response: json(
				{
					error: "Send a code or a backup code, not both.",
					errorKey: "profileTab.twoStepOneCodeOnly",
				},
				{ status: 400 },
			),
		};
	}
	if (!code && !backupCode) {
		return {
			ok: false,
			response: json(
				{
					error: "A code or a backup code is required.",
					errorKey: "profileTab.twoStepCodeRequired",
				},
				{ status: 400 },
			),
		};
	}

	return { ok: true, input: code ? { code } : { backupCode } };
}

/**
 * Runs a code check under the account's wrong-answer budget. A success clears
 * it; a wrong code is recorded and, over the budget, answered 429; anything
 * else (a missing factor, an unreadable secret) is left to the caller's
 * mapping.
 */
export async function runGuardedSecondFactor<
	T extends { ok: boolean; reason?: string },
>(
	userId: string,
	attempt: () => Promise<T>,
): Promise<{ result: T } | { response: Response }> {
	const keys = { accountId: userId };
	const guarded = await guardCredentialCheck(keys, attempt);

	if (guarded.outcome === "refused") {
		return { response: tooManyWrongCodes(guarded.block) };
	}

	const result = guarded.value;
	if (result.ok) {
		recordLoginSuccess(keys);
		return { result };
	}

	if (result.reason === "wrong_code") {
		recordLoginFailure(keys);
		if (guarded.throttled) {
			return { response: tooManyWrongCodes(guarded.throttled) };
		}
	}
	return { result };
}
