import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ProjectItem from "./ProjectItem.svelte";

const project = {
	id: "project-1",
	name: "House tasks",
	sortOrder: 0,
	createdAt: 1,
	updatedAt: 1,
};

describe("ProjectItem", () => {
	it("offers creating a new chat inside the project menu", async () => {
		const onCreateConversation = vi.fn();
		render(ProjectItem, {
			project,
			menuOpen: true,
			onCreateConversation,
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Create chat in House tasks" }),
		);

		expect(onCreateConversation).toHaveBeenCalledWith({ id: "project-1" });
	});
});
