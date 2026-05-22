import { describe, expect, it, vi } from "vitest";
import { saveProjectSidebarOrder, setProjectSidebarPinned } from "./projects";

describe("project sidebar API", () => {
	it("patches project pin state through the project detail endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "project-1",
						name: "Pinned project",
						color: null,
						sidebarPinned: true,
						sortOrder: 0,
						createdAt: 1,
						updatedAt: 1,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await setProjectSidebarPinned("project-1", true, fetchMock);

		expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sidebarPinned: true }),
		});
		expect(result.sidebarPinned).toBe(true);
		expect(result.sortOrder).toBe(0);
	});

	it("saves project sidebar order through the sidebar-order endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						projects: [
							{
								id: "project-2",
								name: "Pinned project",
								color: null,
								sidebarPinned: true,
								sortOrder: 0,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await saveProjectSidebarOrder(
			{ pinnedIds: ["project-2"], unpinnedIds: ["project-1"] },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith("/api/projects/sidebar-order", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				pinnedIds: ["project-2"],
				unpinnedIds: ["project-1"],
			}),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("project-2");
	});
});
