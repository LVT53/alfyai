import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/projects", () => ({
	listProjects: vi.fn(),
	saveProjectSidebarOrder: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	listProjects,
	saveProjectSidebarOrder,
} from "$lib/server/services/projects";
import { PATCH } from "./+server";
import type { RequestEvent } from "./$types";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockListProjects = listProjects as ReturnType<typeof vi.fn>;
const mockSaveProjectSidebarOrder = saveProjectSidebarOrder as ReturnType<
	typeof vi.fn
>;

function makePatchEvent(body: unknown): RequestEvent {
	return {
		request: new Request("http://localhost/api/projects/sidebar-order", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
		params: {},
		url: new URL("http://localhost/api/projects/sidebar-order"),
		route: { id: "/api/projects/sidebar-order" },
	} as unknown as RequestEvent;
}

describe("PATCH /api/projects/sidebar-order", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockListProjects.mockResolvedValue([
			{
				id: "project-2",
				name: "Pinned",
				color: null,
				sidebarPinned: true,
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("persists project order inside supplied sidebar groups", async () => {
		const response = await PATCH(
			makePatchEvent({ pinnedIds: ["project-2"], unpinnedIds: ["project-1"] }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockSaveProjectSidebarOrder).toHaveBeenCalledWith("user-1", {
			pinnedIds: ["project-2"],
			unpinnedIds: ["project-1"],
		});
		expect(data.projects).toEqual([
			expect.objectContaining({
				id: "project-2",
				sidebarPinned: true,
				sortOrder: 0,
			}),
		]);
	});

	it("rejects invalid group payloads before service calls", async () => {
		const response = await PATCH(
			makePatchEvent({ pinnedIds: ["project-1"], unpinnedIds: 12 }),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe(
			"pinnedIds and unpinnedIds must be arrays of project ids when provided",
		);
		expect(mockSaveProjectSidebarOrder).not.toHaveBeenCalled();
	});
});
