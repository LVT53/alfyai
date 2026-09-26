import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/workspace-search", () => ({
	searchWorkspace: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { searchWorkspace } from "$lib/server/services/workspace-search";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockSearchWorkspace = searchWorkspace as ReturnType<typeof vi.fn>;
type WorkspaceSearchEvent = Parameters<typeof GET>[0];

function makeEvent(url = "http://localhost/api/workspace-search?q=atlas") {
	return {
		request: new Request(url),
		locals: { user: { id: "user-1" } },
		params: {},
		url: new URL(url),
		route: { id: "/api/workspace-search" },
	} as WorkspaceSearchEvent;
}

describe("GET /api/workspace-search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockSearchWorkspace.mockResolvedValue({
			query: "atlas",
			mode: "query",
			conversations: [],
			documents: [],
			documentOverflow: false,
			knowledgeHref: null,
		});
	});

	it("requires auth and returns grouped workspace search results", async () => {
		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockRequireAuth).toHaveBeenCalledTimes(1);
		expect(mockSearchWorkspace).toHaveBeenCalledWith("user-1", {
			query: "atlas",
		});
		expect(data).toEqual({
			query: "atlas",
			mode: "query",
			conversations: [],
			documents: [],
			documentOverflow: false,
			knowledgeHref: null,
		});
	});

	// Slice 7: the route is a 15-line pass-through and stays one — `kind` is
	// an additive JSON field on a document result, not a new route contract.
	it("passes a document result's kind field straight through to the JSON body", async () => {
		mockSearchWorkspace.mockResolvedValue({
			query: "vienna",
			mode: "query",
			conversations: [],
			documents: [
				{
					id: "art-canvas-1",
					displayArtifactId: "art-canvas-1",
					promptArtifactId: null,
					familyArtifactIds: ["art-canvas-1"],
					name: "Vienna trip board",
					mimeType: null,
					sizeBytes: null,
					conversationId: "conv-1",
					summary: null,
					updatedAt: 100,
					href: "/knowledge?open_artifact=art-canvas-1&open_filename=Vienna+trip+board",
					sourceHref: null,
					kind: "canvas",
					match: { type: "name", snippet: null },
				},
			],
			documentOverflow: false,
			knowledgeHref: null,
		});

		const response = await GET(
			makeEvent("http://localhost/api/workspace-search?q=vienna"),
		);
		const data = await response.json();

		expect(data.documents[0]).toMatchObject({
			displayArtifactId: "art-canvas-1",
			kind: "canvas",
		});
	});
});
