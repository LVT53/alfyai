import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ProjectItem from "./ProjectItem.svelte";
import ProjectItemWrapper from "./ProjectItemWrapper.test.svelte";

const project = {
	id: "project-1",
	name: "House tasks",
	sortOrder: 0,
	createdAt: 1,
	updatedAt: 1,
};

describe("ProjectItem", () => {
	it("offers pinning as the first project menu action", async () => {
		const onTogglePin = vi.fn();
		render(ProjectItem, {
			project,
			menuOpen: true,
			onTogglePin,
		});

		const menuActions = screen
			.getAllByRole("menuitem")
			.map((button) => button.textContent?.trim());
		expect(menuActions[0]).toBe("Pin to sidebar");

		await fireEvent.click(
			screen.getByRole("menuitem", { name: "Pin to sidebar" }),
		);

		expect(onTogglePin).toHaveBeenCalledWith({ id: "project-1", pinned: true });
	});

	it("opens the project menu on right-click without toggling the folder", async () => {
		const onToggle = vi.fn();
		const onTogglePin = vi.fn();
		const pinnedProject = { ...project, sidebarPinned: true };
		render(ProjectItemWrapper, {
			project: pinnedProject,
			onToggle,
			onTogglePin,
		});

		await fireEvent.contextMenu(screen.getByTestId("project-drop-target"), {
			clientX: 36,
			clientY: 52,
		});

		expect(onToggle).not.toHaveBeenCalled();
		await fireEvent.click(
			screen.getByRole("menuitem", { name: "Unpin from sidebar" }),
		);

		expect(onTogglePin).toHaveBeenCalledWith({
			id: "project-1",
			pinned: false,
		});
	});

	it("marks pinned project rows with a persistent indicator", () => {
		render(ProjectItem, {
			project: { ...project, sidebarPinned: true },
		});

		expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
	});

	it("offers creating a new chat inside the project menu", async () => {
		const onCreateConversation = vi.fn();
		render(ProjectItem, {
			project,
			menuOpen: true,
			onCreateConversation,
		});

		await fireEvent.click(
			screen.getByRole("menuitem", { name: "Create chat in House tasks" }),
		);

		expect(onCreateConversation).toHaveBeenCalledWith({ id: "project-1" });
	});

	it("shows the project-row new chat action outside the overflow menu", () => {
		render(ProjectItem, {
			project,
			onCreateConversation: vi.fn(),
		});

		expect(
			screen.getByRole("button", { name: "Create chat in House tasks" }),
		).toBeInTheDocument();
	});

	it("shows immediate busy state while a project chat is being created", async () => {
		const onCreateConversation = vi.fn();
		render(ProjectItem, {
			project,
			creatingConversation: true,
			onCreateConversation,
		});

		const action = screen.getByRole("button", {
			name: "Create chat in House tasks",
		});
		expect(action).toBeDisabled();
		expect(action).toHaveAttribute("aria-busy", "true");

		await fireEvent.click(action);

		expect(onCreateConversation).not.toHaveBeenCalled();
	});
});
