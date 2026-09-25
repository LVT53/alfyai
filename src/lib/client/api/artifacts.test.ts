import { describe, expect, it, vi } from "vitest";
import { fetchArtifact, fetchConversationArtifacts } from "./artifacts";

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
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, ...detail }));

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
		const fetchMock = vi.fn(async () => jsonResponse(payload));

		await fetchArtifact("artifact-1", "conv 1/2", fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts/artifact-1?conversationId=conv%201%2F2",
		);
	});

	it("omits the query parameter entirely when no conversation id is given", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ artifact: {}, versions: [], comments: [] }),
		);

		await fetchArtifact("artifact-1", null, fetchMock);

		expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/artifact-1");
	});

	it("throws on a failed response, surfacing the family's 404 status", async () => {
		const fetchMock = vi.fn(async () =>
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
		const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

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
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true, artifacts }));

		await expect(
			fetchConversationArtifacts("conv-1", fetchMock),
		).resolves.toEqual(artifacts);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/artifacts?conversationId=conv-1",
		);
	});

	it("returns an empty list rather than throwing when the field is missing", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({}));

		await expect(
			fetchConversationArtifacts("conv-1", fetchMock),
		).resolves.toEqual([]);
	});
});
