import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { readable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversations } from "$lib/stores/conversations";
import { projects } from "$lib/stores/projects";
import {
	clearProjectFolderExpanded,
	setProjectFolderExpanded,
} from "$lib/stores/ui";
import type { ConversationListItem, Project } from "$lib/types";
import ConversationList from "./ConversationList.svelte";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
}));

vi.mock("$app/stores", () => ({
	page: readable({ url: new URL("http://localhost/") }),
}));

describe("ConversationList sidebar pinning", () => {
	beforeEach(() => {
		if (!vi.isMockFunction(window.alert)) {
			vi.spyOn(window, "alert").mockImplementation(() => {});
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ conversations: [], projects: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);
		conversations.set([]);
		projects.set([]);
		clearProjectFolderExpanded("project-1");
	});

	it("renders global pinned conversations once with project labels and sidebar order", () => {
		const initialProjects: Project[] = [
			{
				id: "project-1",
				name: "House tasks",
				sidebarPinned: false,
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
		];
		projects.set(initialProjects);
		const conversationRows: ConversationListItem[] = [
			{
				id: "pinned-later",
				title: "Pinned later",
				projectId: "project-1",
				updatedAt: 200,
				sidebarPinned: true,
				sidebarSortOrder: 2,
			},
			{
				id: "pinned-first",
				title: "Pinned first",
				updatedAt: 300,
				sidebarPinned: true,
				sidebarSortOrder: 1,
			},
			{
				id: "project-only",
				title: "Project only",
				projectId: "project-1",
				updatedAt: 100,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		];
		conversations.set(conversationRows);
		setProjectFolderExpanded("project-1", true);

		render(ConversationList, { initialProjects });

		const pinnedSection = screen.getByTestId("pinned-conversations-section");
		const pinnedItems =
			within(pinnedSection).getAllByTestId("conversation-item");
		expect(pinnedItems.map((item) => item.dataset.conversationId)).toEqual([
			"pinned-first",
			"pinned-later",
		]);
		expect(within(pinnedSection).getByText("House tasks")).toBeInTheDocument();
		expect(screen.getAllByText("Pinned later")).toHaveLength(1);
		expect(
			within(screen.getByTestId("project-conversations-project-1")).queryByText(
				"Pinned later",
			),
		).not.toBeInTheDocument();
		expect(
			within(screen.getByTestId("project-conversations-project-1")).getByText(
				"Project only",
			),
		).toBeInTheDocument();
	});

	it("sorts pinned projects before unpinned projects and reorders inside the pinned group", async () => {
		const projectRows: Project[] = [
			{
				id: "unpinned-project",
				name: "Unpinned project",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: false,
			},
			{
				id: "pinned-later",
				name: "Pinned later",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: true,
			},
			{
				id: "pinned-first",
				name: "Pinned first",
				sortOrder: 0,
				createdAt: 3,
				updatedAt: 3,
				sidebarPinned: true,
			},
		];
		projects.set(projectRows);

		render(ConversationList, { initialProjects: projectRows });

		const projectIds = () =>
			screen
				.getAllByTestId("project-drop-target")
				.map((row) => row.dataset.projectId);

		expect(projectIds()).toEqual([
			"pinned-first",
			"pinned-later",
			"unpinned-project",
		]);

		await fireEvent.click(
			screen.getByRole("button", { name: "Move Pinned first down" }),
		);

		expect(projectIds()).toEqual([
			"pinned-later",
			"pinned-first",
			"unpinned-project",
		]);
	});
});
