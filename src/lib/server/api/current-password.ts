import { json } from "@sveltejs/kit";
import type { CurrentPasswordCheck } from "$lib/server/services/auth";

/**
 * The 429 for a Settings action whose current-password check is over the
 * limiter's budget, with the wait the limiter named. The data archive, clear
 * memory, clear workspace and delete account answer it from their services'
 * `throttled` result; the password and email change through
 * {@link currentPasswordRefusal}. One sentence for all six.
 *
 * `error` is the English fallback; `errorKey` is what the browser translates.
 * Both are Settings' own sentences: the throttle shares the sign-in's limiter,
 * but nobody is signing in here, so it does not borrow
 * `login.tooManyAttempts` ("failed sign-in attempts").
 */
export function passwordThrottledResponse(retryAfterSeconds: number): Response {
	return json(
		{
			error: "Too many failed attempts. Please wait a moment and try again.",
			errorKey: "profileTab.currentPasswordTooManyAttempts",
		},
		{
			status: 429,
			headers: { "Retry-After": String(retryAfterSeconds) },
		},
	);
}

/**
 * The answer to a settings action whose current-password check did not pass
 * (`checkCurrentPassword`). One place for the status, the English fallback and
 * the key the Profile card localizes, so the password change and the email
 * change refuse in the same words.
 */
export function currentPasswordRefusal(
	check: Exclude<CurrentPasswordCheck, { outcome: "ok" }>,
): Response {
	switch (check.outcome) {
		case "throttled":
			return passwordThrottledResponse(check.retryAfterSeconds);
		case "no_user":
			return json({ error: "User not found" }, { status: 404 });
		case "wrong":
			return json(
				{
					error: "Current password is incorrect",
					errorKey: "profileTab.currentPasswordWrong",
				},
				{ status: 401 },
			);
	}
}
