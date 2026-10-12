import { describe, expect, it } from "vitest";
import config from "../../svelte.config.js";

// What svelte.config.js decides about security, held as tests so that a change
// that quietly takes it back fails here and not on a reader's screen.

describe("svelte.config.js: the CSRF origin check", () => {
	// SvelteKit refuses a POST, PUT, PATCH or DELETE with a form-typed body
	// (urlencoded, multipart, text/plain) whose `Origin` is not the server's own.
	// `csrf.trustedOrigins: ['*']` turns that off entirely (SvelteKit writes
	// `csrf_check_origin: false` into the server's options when it sees the
	// wildcard), and a cross-site `text/plain` POST is also what reaches a handler
	// that calls `request.json()` without a CORS preflight. It was added for an
	// internal OCR route that is gone and nothing posts a form here cross-origin,
	// so the check stays on. A real cross-origin form sender, if one ever exists,
	// is added by its exact origin in the same change as this test.
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

describe("svelte.config.js: the Content Security Policy", () => {
	const directives = config.kit?.csp?.directives ?? {};

	it("lets a page draw images from its own origin, data: and blob: only", () => {
		// A picture is a request to whatever address the markup names, made
		// without a click. `https:` (or `http:`, or `*`) here would let model-
		// written markup carry the reader's data to any host in an <img>.
		const sources = (directives["img-src"] ?? []) as string[];
		expect([...sources].sort()).toEqual(["blob:", "data:", "self"]);
	});
});
