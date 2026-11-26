import { redirect } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	OneDriveError,
	onedriveConnectFinish,
	verifyOAuthState,
} from "$lib/server/services/connections/providers/onedrive";
import type { RequestHandler } from "./$types";

const SETTINGS_PATH = "/settings?section=connections";

function errorRedirectPath(reason: string): string {
	return `${SETTINGS_PATH}&error=${encodeURIComponent(reason)}`;
}

// GET /api/oauth/onedrive/callback — Microsoft redirects the browser here
// after the consent screen. Never renders tokens; every outcome (success,
// denial, state mismatch, exchange failure) ends in a redirect back to the
// connections settings page, optionally carrying an error flag. Mirrors
// src/routes/api/oauth/google/callback/+server.ts byte-for-byte, swapped to
// the OneDrive adapter.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	const params = event.url.searchParams;
	const oauthError = params.get("error");
	if (oauthError) {
		const adminApproval =
			oauthError === "admin_consent_required" ||
			/\bAADSTS9009[45]\b/i.test(params.get("error_description") ?? "");
		throw redirect(
			302,
			errorRedirectPath(
				adminApproval
					? "onedrive_oauth_admin_approval"
					: oauthError === "access_denied"
						? "onedrive_oauth_denied"
						: "onedrive_oauth_failed",
			),
		);
	}

	const code = params.get("code");
	const state = params.get("state");
	if (!code || !state) {
		throw redirect(302, errorRedirectPath("onedrive_oauth_invalid_request"));
	}

	let statePayload: ReturnType<typeof verifyOAuthState>;
	try {
		statePayload = verifyOAuthState(state);
	} catch {
		throw redirect(302, errorRedirectPath("onedrive_oauth_invalid_state"));
	}

	// Reject a state signed for a different user — a valid signature alone
	// isn't enough, it must also match the browser session presenting it.
	if (statePayload.userId !== event.locals.user.id) {
		throw redirect(302, errorRedirectPath("onedrive_oauth_state_mismatch"));
	}

	try {
		await onedriveConnectFinish({ code, state, origin: event.url.origin });
	} catch (err) {
		if (err instanceof OneDriveError && err.code === "wrong_account")
			throw redirect(302, errorRedirectPath("onedrive_oauth_wrong_account"));
		if (err instanceof OneDriveError && err.code === "admin_approval")
			throw redirect(302, errorRedirectPath("onedrive_oauth_admin_approval"));
		throw redirect(302, errorRedirectPath("onedrive_oauth_failed"));
	}

	throw redirect(302, `${SETTINGS_PATH}&connected=onedrive`);
};
