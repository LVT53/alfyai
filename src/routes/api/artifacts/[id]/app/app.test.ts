import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
}));

import { getArtifact } from "$lib/server/services/artifacts";
import {
	APP_SANDBOX_CSP,
	APP_SANDBOX_HEADERS,
} from "$lib/server/services/artifacts/app/sandbox-response";
import { GET } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;

function makeEvent(
	id = "app-1",
	userId: string | null = "owner-user",
	conversationId: string | null = null,
	acceptLanguage: string | null = null,
) {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	const url = new URL(`http://localhost/api/artifacts/${id}/app${query}`);
	return {
		params: { id },
		url,
		request: new Request(url, {
			headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
		}),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

const APP_ARTIFACT = {
	id: "app-1",
	kind: "app" as const,
	title: "Trip cost splitter",
	conversationId: "conv-1",
	versionNumber: 1,
	commentCount: 0,
	updatedAt: 1,
	body: "<!doctype html><head><title>x</title></head><body>hi</body>",
	bodyHash: "hash",
	metadata: { artifactType: "app" as const, title: "Trip cost splitter" },
};

describe("GET /api/artifacts/[id]/app", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user (requireApiUser)", async () => {
		await expect(GET(makeEvent("app-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockGetArtifact).not.toHaveBeenCalled();
	});

	it("404s with the family's one not_found shape for a foreign, missing, or incognito-from-outside artifact", async () => {
		mockGetArtifact.mockResolvedValue(null);

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ ok: false, reason: "not_found" });
	});

	it("404s for a non-App artifact kind — never serves a Document's or Canvas's body as if it were runnable", async () => {
		mockGetArtifact.mockResolvedValue({ ...APP_ARTIFACT, kind: "document" });

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
	});

	it("404s when the artifact has no stored body", async () => {
		mockGetArtifact.mockResolvedValue({ ...APP_ARTIFACT, body: null });

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
	});

	it("serves the owner's App with text/html, nosniff and no-store", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);

		const response = await GET(makeEvent());

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("sends the CSP as an EXACT string — a partial check would pass on a later, weaker header", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);

		const response = await GET(makeEvent());

		// Ruling 58: the sandbox directive widens by exactly `allow-forms`.
		expect(response.headers.get("Content-Security-Policy")).toBe(
			"sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; require-trusted-types-for 'script'; trusted-types default",
		);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			APP_SANDBOX_CSP,
		);
		expect(APP_SANDBOX_HEADERS["Content-Security-Policy"]).toBe(
			APP_SANDBOX_CSP,
		);
	});

	it("never allows allow-same-origin to slip into the CSP", async () => {
		expect(APP_SANDBOX_CSP).not.toContain("allow-same-origin");
	});

	it("injects the bootstrap into the served body, before the artifact's own script", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);

		const response = await GET(makeEvent());
		const body = await response.text();

		expect(body.indexOf("<script>")).toBeGreaterThan(-1);
		expect(body.indexOf("<script>")).toBeLessThan(body.indexOf("<title>"));
	});

	// ADR-0068. A frame the browser's parser makes from the App's own markup runs
	// whatever it was given, with constructors the bootstrap cannot reach, and no
	// script of the app's has to run first. The document is not served; its code
	// stays readable in the Code tab (the artifact API, not this route).
	describe("an App whose own markup carries a frame", () => {
		it.each([
			[
				"an iframe with a document",
				'<iframe srcdoc="<script>1</script>"></iframe>',
			],
			["an upper-case IFRAME", "<IFRAME SRC=javascript:1></IFRAME>"],
			["a frame behind a slash", "<iframe/srcdoc=x>"],
			[
				"a frame in a template a script clones",
				"<template><iframe></template>",
			],
			["an object", "<object data=x></object>"],
			["an embed", "<embed src=x>"],
			["a frameset", "<frameset><frame src=x></frameset>"],
		])("is not served for %s: a 422 notice with the App's own strict headers", async (_name, markup) => {
			mockGetArtifact.mockResolvedValue({
				...APP_ARTIFACT,
				body: `<!doctype html><title>x</title><script>window.ran = 1</script>${markup}`,
			});

			const response = await GET(makeEvent());
			const body = await response.text();

			expect(response.status).toBe(422);
			for (const [name, value] of Object.entries(APP_SANDBOX_HEADERS)) {
				expect(response.headers.get(name)).toBe(value);
			}
			expect(body).toContain("cannot run");
			expect(body).not.toContain("window.ran");
		});

		it("says so in Hungarian for a Hungarian browser", async () => {
			mockGetArtifact.mockResolvedValue({
				...APP_ARTIFACT,
				body: "<iframe></iframe>",
			});

			const response = await GET(
				makeEvent("app-1", "owner-user", null, "hu-HU,hu;q=0.9"),
			);

			expect(response.status).toBe(422);
			expect(await response.text()).toContain("nem futtatható");
		});

		it("serves an App that only talks about frames, or builds one from a script: the browser's policy refuses that", async () => {
			for (const body of [
				"<!doctype html><p>An iframe is a frame; so is an object.</p><code>&lt;iframe&gt;</code>",
				'<!doctype html><script>var f = document.createElement("iframe");</script>',
			]) {
				mockGetArtifact.mockResolvedValue({ ...APP_ARTIFACT, body });
				const response = await GET(makeEvent());
				expect(response.status).toBe(200);
			}
		});
	});

	it("puts the bootstrap first, ahead of everything the App wrote, a doctype's copy aside", async () => {
		mockGetArtifact.mockResolvedValue({
			...APP_ARTIFACT,
			body: "<!--><script>window.early = 1</script><!-- --><!doctype html><head></head>",
		});

		const body = await (await GET(makeEvent())).text();

		expect(body.startsWith("<script>")).toBe(true);
		expect(body.indexOf("window.early")).toBeGreaterThan(
			body.indexOf("alfy.storage"),
		);
	});

	it("forwards ?conversationId= to the scoped read, so an incognito chat's own App can still preview", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);

		await GET(makeEvent("app-1", "owner-user", "conv-incognito"));

		expect(mockGetArtifact).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "app-1",
			conversationId: "conv-incognito",
		});
	});

	it("only ever exports GET — no other HTTP verb handler, and no other named export SvelteKit's build would reject", async () => {
		const module = await import("./+server");
		expect(Object.keys(module)).toEqual(["GET"]);
	});
});
