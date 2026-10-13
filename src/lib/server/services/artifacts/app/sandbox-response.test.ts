import { describe, expect, it } from "vitest";
import {
	APP_SANDBOX_CSP,
	APP_SANDBOX_HEADERS,
	renderAppNotRunnableResponse,
	renderAppSessionExpiredResponse,
} from "./sandbox-response";

describe("APP_SANDBOX_CSP", () => {
	const directives = APP_SANDBOX_CSP.split("; ");

	// ADR-0068: a frame the App makes itself has a window of its own, and the
	// bootstrap's default policy is what refuses every string that would make
	// one. The policy only binds if the document requires it.
	it("requires Trusted Types for scripts and allows no policy but the bootstrap's default", () => {
		expect(directives).toContain("require-trusted-types-for 'script'");
		expect(directives).toContain("trusted-types default");
	});

	it("carries no webrtc directive: Chromium ignores it, and warns about it in every App's console", () => {
		expect(directives.some((part) => part.startsWith("webrtc"))).toBe(false);
	});

	it("keeps the sandbox, the fetch lock and the frame lock it always had", () => {
		expect(directives).toEqual(
			expect.arrayContaining([
				"sandbox allow-scripts allow-forms",
				"default-src 'none'",
				"connect-src 'none'",
				"form-action 'none'",
				"base-uri 'none'",
				"frame-ancestors 'self'",
			]),
		);
	});
});

// ADR-0068: an App whose own markup carries a frame (a tag the parser makes a
// document of without any script running) is not served. The notice goes in the
// App's own frame, with the App's own strict headers, because it renders there.
describe("renderAppNotRunnableResponse", () => {
	it("serves the same strict headers as the App's own served document", () => {
		const response = renderAppNotRunnableResponse(null);
		for (const [name, value] of Object.entries(APP_SANDBOX_HEADERS)) {
			expect(response.headers.get(name)).toBe(value);
		}
	});

	it("answers 422: the document cannot be processed, and is not served", () => {
		expect(renderAppNotRunnableResponse(null).status).toBe(422);
	});

	it("says in English that the app cannot run and why", async () => {
		const body = await renderAppNotRunnableResponse(null).text();
		expect(body).toContain("cannot run");
		expect(body).toContain('<html lang="en">');
	});

	it("says it in Hungarian when Accept-Language ranks it first", async () => {
		const body = await renderAppNotRunnableResponse("hu-HU,hu;q=0.9").text();
		expect(body).toContain("nem futtatható");
		expect(body).toContain('<html lang="hu">');
	});

	it("has no script, no form and no link: nothing for the sandbox to restrict", async () => {
		const body = (
			await renderAppNotRunnableResponse(null).text()
		).toLowerCase();
		for (const tag of ["<script", "<form", "<a ", "<iframe", "<img"]) {
			expect(body).not.toContain(tag);
		}
	});

	it("never mentions the word 'artifact' in either language (ADR-0066)", async () => {
		for (const lang of [null, "hu"]) {
			const body = await renderAppNotRunnableResponse(lang).text();
			expect(body.toLowerCase()).not.toContain("artifact");
			expect(body.toLowerCase()).not.toContain("artefakt");
		}
	});
});

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
