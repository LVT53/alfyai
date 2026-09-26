import { describe, expect, it } from "vitest";
import {
	APP_SANDBOX_CSP,
	APP_SANDBOX_HEADERS,
	renderAppSessionExpiredResponse,
} from "./sandbox-response";

// Ruling 58: the served route's auth gate answers this instead of its usual
// 303-to-/login for exactly one case — this route loaded with no session left
// inside the App's own sandboxed, opaque-origin iframe (hooks.server.ts).
// A redirect there lands /login INSIDE that same sandboxed browsing context
// (sandbox flags apply to every document a frame loads, not only its first),
// so the login form runs opaque-origin too: no cookie, nothing to submit it
// with. This is a plain, static, localized notice instead.
describe("renderAppSessionExpiredResponse", () => {
	it("serves the SAME strict headers as the App's own served document", () => {
		const response = renderAppSessionExpiredResponse(null);
		for (const [name, value] of Object.entries(APP_SANDBOX_HEADERS)) {
			expect(response.headers.get(name)).toBe(value);
		}
		expect(response.headers.get("Content-Security-Policy")).toBe(
			APP_SANDBOX_CSP,
		);
	});

	it("answers 401 — this IS an authentication failure, just not one an iframe can submit a form for", () => {
		const response = renderAppSessionExpiredResponse(null);
		expect(response.status).toBe(401);
	});

	it("defaults to English with no Accept-Language", async () => {
		const response = renderAppSessionExpiredResponse(null);
		const body = await response.text();
		expect(body).toContain("Your session ended");
	});

	it("answers in Hungarian when Accept-Language ranks it first", async () => {
		const response = renderAppSessionExpiredResponse("hu-HU,hu;q=0.9,en;q=0.1");
		const body = await response.text();
		expect(body).toContain("Lejárt a munkameneted");
	});

	it("falls back to English for an unrelated Accept-Language", async () => {
		const response = renderAppSessionExpiredResponse("fr-FR,fr;q=0.9");
		const body = await response.text();
		expect(body).toContain("Your session ended");
	});

	it("never mentions the word 'artifact' in either language (ADR-0066)", async () => {
		for (const lang of [null, "hu"]) {
			const body = await renderAppSessionExpiredResponse(lang).text();
			expect(body.toLowerCase()).not.toContain("artifact");
			expect(body.toLowerCase()).not.toContain("artefakt");
		}
	});
});
