// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { saveProjectSidebarOrder } from "./projects";

describe("project sidebar API", () => {
	it("saves project sidebar order through the sidebar-order endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						projects: [
							{
								id: "project-2",
								name: "Ordered project",
								color: null,
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
			{ ids: ["project-2", "project-1"] },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledWith("/api/projects/sidebar-order", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				ids: ["project-2", "project-1"],
			}),
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("project-2");
	});
});
