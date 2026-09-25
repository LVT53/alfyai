import { describe, expect, it, vi } from "vitest";
import { fetchArtifact, fetchConversationArtifacts } from "./artifacts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("artifacts client API", () => {
	it("fetches one artifact's detail, versions and comments", async () => {
		const payload = {
			artifact: { id: "artifact-1", kind: "document", title: "Weekend" },
			versions: [],
			comments: [],
		};
		const fetchMock = vi.fn(async () => jsonResponse(payload));

		await expect(fetchArtifact("artifact-1", fetchMock)).resolves.toEqual(
			payload,
		);
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
		await expect(fetchArtifact("missing", fetchMock)).rejects.toMatchObject({
			status: 404,
		});
	});

	it("falls back to the caller's message on an empty error body", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

		await expect(fetchArtifact("artifact-1", fetchMock)).rejects.toThrow(
			"Failed to open this item",
		);
	});

	it("fetches a conversation's artifacts, unwrapping the list", async () => {
		const artifacts = [
			{ id: "artifact-2", kind: "document", title: "Newer" },
			{ id: "artifact-1", kind: "file", title: "Older" },
		];
		const fetchMock = vi.fn(async () => jsonResponse({ artifacts }));

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
