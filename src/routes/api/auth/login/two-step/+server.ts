import { json, type RequestHandler } from "@sveltejs/kit";
import { createSession, setSessionCookie } from "$lib/server/services/auth";
import {
	guardCredentialCheck,
	type LoginRateLimitBlock,
	readClientAddressSafely,
	recordLoginFailure,
	recordLoginSuccess,
	resolveRateLimitClientAddress,
} from "$lib/server/services/login-rate-limit";
import {
	clearSignInAttemptCookie,
	consumeSignInChallenge,
	findSignInChallengeAccount,
	SIGN_IN_ATTEMPT_COOKIE,
} from "$lib/server/services/two-step";

/**
 * The second step of a two-step sign-in: a code from the authenticator app, or
 * one of the person's backup codes, against the five-minute attempt a correct
 * password opened. This is the only place an account with a confirmed factor
 * gets a session.
 *
 * JSON only (R15): the code step needs JavaScript, like the rest of the app.
 * Every wrong code is counted by the same login limiter as the password step,
 * under the same keys (the account's email and the client address), and an
 * over-budget request is answered 429 without a comparison (R11).
 */

const TOO_MANY_CODES_KEY = "login.twoStepTooManyAttempts";
const TOO_MANY_CODES_MESSAGE =
	"Too many wrong codes. Please wait a moment and try again.";

function tooManyAttempts(block: LoginRateLimitBlock): Response {
	return json(
		{ error: TOO_MANY_CODES_MESSAGE, errorKey: TOO_MANY_CODES_KEY },
		{
			status: 429,
			headers: { "Retry-After": String(block.retryAfterSeconds) },
		},
	);
}

/** The restarts a person can be sent back to the password step with. */
function restartResponse(why: "expired" | "too_many" | "missing"): Response {
	switch (why) {
		case "too_many":
			return json(
				{
					error: "Too many tries. Sign in again.",
					errorKey: "login.twoStepTooManyTries",
				},
				{ status: 401 },
			);
		case "expired":
			return json(
				{
					error: "That took too long. Sign in again.",
					errorKey: "login.twoStepExpired",
				},
				{ status: 401 },
			);
		case "missing":
			return json(
				{
					error: "Sign in again.",
					errorKey: "login.twoStepRestart",
				},
				{ status: 401 },
			);
	}
}

function wrongCodeResponse(triesLeft: number): Response {
	return json(
		{
			error: "That code didn't work.",
			errorKey: "login.twoStepWrongCode",
			details: { triesLeft },
		},
		{ status: 401 },
	);
}

function unavailableResponse(): Response {
	return json(
		{
			error: "Two-step sign-in is unavailable. Contact your admin.",
			errorKey: "login.twoStepUnavailable",
		},
		{ status: 409 },
	);
}

export const POST: RequestHandler = async ({
	request,
	cookies,
	getClientAddress,
}) => {
	try {
		let body: { code?: unknown; backupCode?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ error: "Invalid JSON" }, { status: 400 });
		}

		const code = typeof body.code === "string" ? body.code.trim() : "";
		const backupCode =
			typeof body.backupCode === "string" ? body.backupCode.trim() : "";
		if (!code && !backupCode) {
			return json(
				{ error: "A code or a backup code is required" },
				{ status: 400 },
			);
		}

		const attemptToken = cookies.get(SIGN_IN_ATTEMPT_COOKIE);
		if (!attemptToken) return restartResponse("missing");

		const account = await findSignInChallengeAccount(attemptToken);
		if (!account) return restartResponse("missing");

		const rateLimitKeys = {
			email: account.email,
			clientAddress: resolveRateLimitClientAddress(
				readClientAddressSafely(getClientAddress),
			),
		};

		// The comparison runs inside the throttle, as the password step's does:
		// over budget nothing runs and the answer is a 429, never a 500.
		const guarded = await guardCredentialCheck(rateLimitKeys, () =>
			consumeSignInChallenge(
				attemptToken,
				code ? { code } : { backupCode },
				new Date(),
			),
		);

		if (guarded.outcome === "refused") {
			return tooManyAttempts(guarded.block);
		}

		const result = guarded.value;

		if (!result.ok) {
			// A wrong code is the account's failure; an attempt that merely ran
			// out of time was never a guess. An attempt that ran out of TRIES
			// was: the fifth wrong code is one more guess than the four the
			// earlier answers counted, so it is recorded too (R11).
			if (result.reason === "wrong_code") {
				recordLoginFailure(rateLimitKeys);
				if (guarded.throttled) return tooManyAttempts(guarded.throttled);
				return wrongCodeResponse(result.triesLeft);
			}
			if (result.reason === "restart" && result.why === "too_many") {
				recordLoginFailure(rateLimitKeys);
				if (guarded.throttled) return tooManyAttempts(guarded.throttled);
				return restartResponse("too_many");
			}
			if (result.reason === "restart") return restartResponse(result.why);
			if (result.reason === "unreadable_secret") return unavailableResponse();
			return restartResponse("missing");
		}

		// The challenge is spent; only now does a session exist. It carries the
		// password step's remember-me choice.
		const session = await createSession(result.userId, {
			rememberMe: result.rememberMe,
		});
		recordLoginSuccess(rateLimitKeys);
		setSessionCookie(cookies, session.token, session.expiresAt, {
			rememberMe: result.rememberMe,
		});
		clearSignInAttemptCookie(cookies);

		return json({
			ok: true,
			usedBackupCode: result.usedBackupCode,
			backupCodesLeft: result.backupCodesLeft,
		});
	} catch (error) {
		console.error("Two-step sign-in error:", error);
		return json({ error: "Internal server error" }, { status: 500 });
	}
};
