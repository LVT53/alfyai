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
});
