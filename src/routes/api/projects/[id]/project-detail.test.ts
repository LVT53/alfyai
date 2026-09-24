import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/projects", () => ({
	deleteProject: vi.fn(),
	updateProject: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { updateProject } from "$lib/server/services/projects";
import { PATCH } from "./+server";
import type { RequestEvent } from "./$types";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockUpdateProject = updateProject as ReturnType<typeof vi.fn>;

function makePatchEvent(body: unknown, id = "project-1"): RequestEvent {
	return {
		request: new Request(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
		params: { id },
		url: new URL(`http://localhost/api/projects/${id}`),
		route: { id: "/api/projects/[id]" },
	} as unknown as RequestEvent;
}

describe("PATCH /api/projects/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockUpdateProject.mockResolvedValue({
			id: "project-1",
			name: "Renamed",
			color: null,
			sortOrder: 0,
			createdAt: 1,
			updatedAt: 2,
		});
	});

	it("still renames projects through the existing name branch", async () => {
		const response = await PATCH(makePatchEvent({ name: " Renamed " }));

		expect(response.status).toBe(200);
		expect(mockUpdateProject).toHaveBeenCalledWith("user-1", "project-1", {
			name: "Renamed",
		});
	});

	it("does not accept project pin payloads", async () => {
		const response = await PATCH(makePatchEvent({ sidebarPinned: true }));
		const data = await response.json();

		expect(response.status).toBe(400);
		// The message widened with the contract (Slice D): PATCH now accepts
		// `instructions`, so a payload with neither field is "nothing to
		// update" rather than "a name is missing".
		expect(data.error).toBe("Nothing to update");
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});
});
