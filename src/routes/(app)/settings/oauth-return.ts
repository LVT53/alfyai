// Issue 7.3 — maps the Google OAuth callback's `?error=<code>` values (see
// src/routes/api/oauth/google/callback/+server.ts's errorRedirectPath calls)
// to a translated, user-facing reason. Mirrors the
// Record<string, I18nKey> + lookup-function shape of
// src/routes/(app)/chat/[conversationId]/lifecycle-guards.ts's
// forkCreationErrorKeys/getForkCreationErrorKey.
import type { I18nKey } from "$lib/i18n";

const OAUTH_ERROR_REASON_KEYS: Record<string, I18nKey> = {
	google_oauth_denied: "connections.oauthReturn.reason.google_oauth_denied",
	google_oauth_invalid_request:
		"connections.oauthReturn.reason.google_oauth_invalid_request",
	google_oauth_invalid_state:
		"connections.oauthReturn.reason.google_oauth_invalid_state",
	google_oauth_state_mismatch:
		"connections.oauthReturn.reason.google_oauth_state_mismatch",
	google_oauth_failed: "connections.oauthReturn.reason.google_oauth_failed",
};

export function getOAuthErrorReasonKey(code: string): I18nKey {
	return (
		OAUTH_ERROR_REASON_KEYS[code] ?? "connections.oauthReturn.reason.generic"
	);
}
