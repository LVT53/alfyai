import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: vi.fn(),
}));

import { getArtifact } from "$lib/server/services/artifacts";
import { APP_SANDBOX_CSP, APP_SANDBOX_HEADERS, GET } from "./+server";

const mockGetArtifact = getArtifact as ReturnType<typeof vi.fn>;

function makeEvent(
	id = "app-1",
	userId: string | null = "owner-user",
	conversationId: string | null = null,
) {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}/app${query}`),
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

		expect(response.headers.get("Content-Security-Policy")).toBe(
			"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
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

	it("forwards ?conversationId= to the scoped read, so an incognito chat's own App can still preview", async () => {
		mockGetArtifact.mockResolvedValue(APP_ARTIFACT);

		await GET(makeEvent("app-1", "owner-user", "conv-incognito"));

		expect(mockGetArtifact).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "app-1",
			conversationId: "conv-incognito",
		});
	});

	it("only ever exports GET — no other HTTP verb handler exists on this route", async () => {
		const module = await import("./+server");
		expect(Object.keys(module).sort()).toEqual(
			["APP_SANDBOX_CSP", "APP_SANDBOX_HEADERS", "GET"].sort(),
		);
	});
});
