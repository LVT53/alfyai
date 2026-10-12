import { describe, expect, it } from "vitest";
import config from "../../svelte.config.js";

// SvelteKit refuses a POST, PUT, PATCH or DELETE with a form-typed body
// (urlencoded, multipart, text/plain) whose `Origin` is not the server's own.
// `csrf.trustedOrigins: ['*']` turns that off entirely (SvelteKit writes
// `csrf_check_origin: false` into the server's options when it sees the
// wildcard), and a cross-site `text/plain` POST is also what reaches a handler
// that calls `request.json()` without a CORS preflight. It was added for an
// internal OCR route that is gone and nothing posts a form here cross-origin,
// so the check stays on. A real cross-origin form sender, if one ever exists,
// is added by its exact origin in the same change as this test.

describe("svelte.config.js: the CSRF origin check", () => {
	const csrf = config.kit?.csrf;

	it("is not switched off by a wildcard in trustedOrigins", () => {
		expect(csrf?.trustedOrigins ?? []).not.toContain("*");
	});

	it("names only exact origins, never a pattern", () => {
		for (const origin of csrf?.trustedOrigins ?? []) {
			expect(origin).toMatch(/^https?:\/\/[^/*?#\s]+$/);
		}
	});

	it("is not switched off through the deprecated checkOrigin flag either", () => {
		expect(csrf?.checkOrigin).not.toBe(false);
	});
});
