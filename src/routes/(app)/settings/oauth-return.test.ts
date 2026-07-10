import { describe, expect, it } from "vitest";
import { getOAuthErrorReasonKey } from "./oauth-return";

describe("getOAuthErrorReasonKey", () => {
	it("maps known Google OAuth callback error codes to their reason key", () => {
		expect(getOAuthErrorReasonKey("google_oauth_denied")).toBe(
			"connections.oauthReturn.reason.google_oauth_denied",
		);
		expect(getOAuthErrorReasonKey("google_oauth_invalid_request")).toBe(
			"connections.oauthReturn.reason.google_oauth_invalid_request",
		);
		expect(getOAuthErrorReasonKey("google_oauth_invalid_state")).toBe(
			"connections.oauthReturn.reason.google_oauth_invalid_state",
		);
		expect(getOAuthErrorReasonKey("google_oauth_state_mismatch")).toBe(
			"connections.oauthReturn.reason.google_oauth_state_mismatch",
		);
		expect(getOAuthErrorReasonKey("google_oauth_failed")).toBe(
			"connections.oauthReturn.reason.google_oauth_failed",
		);
	});

	it("maps known OneDrive OAuth callback error codes to their reason key", () => {
		expect(getOAuthErrorReasonKey("onedrive_oauth_denied")).toBe(
			"connections.oauthReturn.reason.onedrive_oauth_denied",
		);
		expect(getOAuthErrorReasonKey("onedrive_oauth_invalid_request")).toBe(
			"connections.oauthReturn.reason.onedrive_oauth_invalid_request",
		);
		expect(getOAuthErrorReasonKey("onedrive_oauth_invalid_state")).toBe(
			"connections.oauthReturn.reason.onedrive_oauth_invalid_state",
		);
		expect(getOAuthErrorReasonKey("onedrive_oauth_state_mismatch")).toBe(
			"connections.oauthReturn.reason.onedrive_oauth_state_mismatch",
		);
		expect(getOAuthErrorReasonKey("onedrive_oauth_failed")).toBe(
			"connections.oauthReturn.reason.onedrive_oauth_failed",
		);
	});

	it("falls back to the generic reason key for an unknown code", () => {
		expect(getOAuthErrorReasonKey("something_unexpected")).toBe(
			"connections.oauthReturn.reason.generic",
		);
	});
});
