import { describe, expect, it, vi } from "vitest";
import {
	downloadAppAsHtml,
	fetchArtifact,
	fetchConversationArtifacts,
	readAppValue,
	regenerateApp,
	writeAppValue,
} from "./artifacts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("artifacts client API", () => {
	it("fetches one artifact's detail, versions and comments, leaving the wire-level ok behind", async () => {
		const detail = {
			artifact: { id: "artifact-1", kind: "document", title: "Weekend" },
			versions: [],
			comments: [],
		};
		// Ruling 49: the route answers { ok: true, artifact, versions, comments }.
		const fetchMock = vi.fn(async (..._args: unknown[]) =>
			jsonResponse({ ok: true, ...detail }),
		);

		const result = await fetchArtifact("artifact-1", undefined, fetchMock);
		expect(result).toEqual(detail);
		expect(result).not.toHaveProperty("ok");
		expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/artifact-1");
	});

	// The default ownership scope hides an incognito conversation's own
	// artifacts (see ArtifactScopeOptions), so opening one from inside its
	// own chat needs the conversation id widened into scope, the same way
	// `fetchConversationArtifacts` already carries it. The server only
	// widens the scope to a conversation the caller owns, so sending it is
	// always safe for a non-incognito chat too.
	it("carries the current conversation id as a query parameter, so an incognito artifact stays in scope", async () => {
		const payload = {
			artifact: { id: "artifact-1", kind: "document", title: "Weekend" },
			versions: [],
			comments: [],
		};
		const fetchMock = vi.fn(async (..._args: unknown[]) =>
			jsonResponse(payload),
		);

		await fetchArtifact("artifact-1", "conv 1/2", fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts/artifact-1?conversationId=conv%201%2F2",
		);
	});

	it("omits the query parameter entirely when no conversation id is given", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) =>
			jsonResponse({ artifact: {}, versions: [], comments: [] }),
		);

		await fetchArtifact("artifact-1", null, fetchMock);

		expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/artifact-1");
	});

	it("throws on a failed response, surfacing the family's 404 status", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) =>
			jsonResponse({ ok: false, reason: "not_found" }, 404),
		);

		// The panel maps ANY caught error to its own artifacts.error.load
		// copy rather than trusting the message text (readErrorPayload has no
		// special case for the family's `reason` field, and does not need
		// one): this proves the request rejects with the right status, which
		// is what a caller actually branches on.
		await expect(
			fetchArtifact("missing", undefined, fetchMock),
		).rejects.toMatchObject({
			status: 404,
		});
	});

	it("falls back to the caller's message on an empty error body", async () => {
		const fetchMock = vi.fn(
			async (..._args: unknown[]) => new Response(null, { status: 500 }),
		);

		await expect(
			fetchArtifact("artifact-1", undefined, fetchMock),
		).rejects.toThrow("Failed to open this item");
	});

	it("fetches a conversation's artifacts, unwrapping the list", async () => {
		const artifacts = [
			{ id: "artifact-2", kind: "document", title: "Newer" },
			{ id: "artifact-1", kind: "file", title: "Older" },
		];
		// Ruling 49: the route answers { ok: true, artifacts }; _unwrapList reads
		// only the `artifacts` key, so the sibling `ok` is simply ignored.
		const fetchMock = vi.fn(async (..._args: unknown[]) =>
			jsonResponse({ ok: true, artifacts }),
		);

		await expect(
			fetchConversationArtifacts("conv-1", fetchMock),
		).resolves.toEqual(artifacts);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts?conversationId=conv-1",
		);
	});

	it("returns an empty list rather than throwing when the field is missing", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => jsonResponse({}));

		await expect(
			fetchConversationArtifacts("conv-1", fetchMock),
		).resolves.toEqual([]);
	});

	describe("readAppValue / writeAppValue", () => {
		it("reads the parsed body on a NON-2xx status instead of throwing, so the reason survives", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: false, reason: "not_found" }, 404),
			);

			await expect(
				readAppValue("app-1", "k", undefined, fetchMock),
			).resolves.toEqual({
				ok: false,
				reason: "not_found",
			});
			expect(fetchMock.mock.calls[0][0]).toBe(
				"/api/artifacts/app-1/app/kv?key=k",
			);
		});

		it("posts { key, value } for a write and reads the reason on a refusal", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: false, reason: "too_large" }, 413),
			);

			await expect(
				writeAppValue("app-1", "k", { a: 1 }, undefined, fetchMock),
			).resolves.toEqual({ ok: false, reason: "too_large" });

			const [, init] = fetchMock.mock.calls[0];
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				key: "k",
				value: { a: 1 },
			});
		});

		it("appends conversationId to the read URL when given one, to widen scope for an incognito conversation's own App", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true, value: 1 }),
			);

			await readAppValue("app-1", "k", "conv-1", fetchMock);

			expect(fetchMock.mock.calls[0][0]).toBe(
				"/api/artifacts/app-1/app/kv?key=k&conversationId=conv-1",
			);
		});

		it("appends conversationId to the write URL when given one, and leaves the body as { key, value }", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true }),
			);

			await writeAppValue("app-1", "k", { a: 1 }, "conv-1", fetchMock);

			expect(fetchMock.mock.calls[0][0]).toBe(
				"/api/artifacts/app-1/app/kv?conversationId=conv-1",
			);
			const [, init] = fetchMock.mock.calls[0];
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				key: "k",
				value: { a: 1 },
			});
		});
	});

	describe("regenerateApp", () => {
		it("posts prompt and expectVersion, and returns the parsed body on success", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({
					ok: true,
					version: 2,
					title: "Split",
					verification: { checked: false },
				}),
			);

			const result = await regenerateApp(
				"app-1",
				"add a currency switch",
				1,
				null,
				fetchMock,
			);

			expect(result).toEqual({
				ok: true,
				version: 2,
				title: "Split",
				verification: { checked: false },
			});
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("/api/artifacts/app-1/app/regenerate");
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				prompt: "add a currency switch",
				expectVersion: 1,
				conversationId: null,
			});
		});

		// RV-2A (ruling 51): the regenerate route widens its scope from the
		// body's conversationId, exactly as the download route does.
		it("sends the panel's conversationId in the body, so an incognito conversation's own App resolves", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({
					ok: true,
					version: 2,
					title: "Split",
					verification: { checked: false },
				}),
			);

			await regenerateApp(
				"app-1",
				"add a currency switch",
				1,
				"conv-incognito",
				fetchMock,
			);

			const [, init] = fetchMock.mock.calls[0];
			expect(JSON.parse((init as RequestInit).body as string)).toEqual({
				prompt: "add a currency switch",
				expectVersion: 1,
				conversationId: "conv-incognito",
			});
		});

		it("a 409 keeps returning the version, so the caller can offer to retry with the same prompt", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse(
					{ ok: false, reason: "version_conflict", version: 4 },
					409,
				),
			);

			await expect(
				regenerateApp("app-1", "add a currency switch", 1, null, fetchMock),
			).resolves.toEqual({ ok: false, reason: "version_conflict", version: 4 });
		});
	});

	describe("downloadAppAsHtml", () => {
		it("posts only the conversation id — never an html field the client could have composed", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: true, job: { id: "job-1" }, reused: false }, 202),
			);

			const result = await downloadAppAsHtml("app-1", "conv-1", fetchMock);

			expect(result).toEqual({ ok: true, job: { id: "job-1" }, reused: false });
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("/api/artifacts/app-1/app/download");
			const body = JSON.parse((init as RequestInit).body as string);
			expect(Object.keys(body)).toEqual(["conversationId"]);
			expect(body.conversationId).toBe("conv-1");
		});

		it("reads the refusal reason for a project-linked App with no conversation", async () => {
			const fetchMock = vi.fn(async (..._args: unknown[]) =>
				jsonResponse({ ok: false, reason: "conversation_required" }, 422),
			);

			await expect(
				downloadAppAsHtml("app-1", null, fetchMock),
			).resolves.toEqual({
				ok: false,
				reason: "conversation_required",
			});
		});
	});
});
