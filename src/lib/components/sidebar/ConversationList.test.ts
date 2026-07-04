import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { get, readable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversations } from "$lib/stores/conversations";
import { clearProjectStore, projects } from "$lib/stores/projects";
import {
	clearProjectFolderExpanded,
	currentConversationId,
	setProjectFolderExpanded,
	sidebarChatsExpanded,
	sidebarPinnedExpanded,
	sidebarProjectsExpanded,
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
		currentConversationId.set(null);
		clearProjectStore();
		sidebarProjectsExpanded.set(true);
		sidebarChatsExpanded.set(true);
		sidebarPinnedExpanded.set(true);
		for (const projectId of [
			"project-1",
			"project-first",
			"project-later",
			"project-third",
		]) {
			clearProjectFolderExpanded(projectId);
		}
	});

	it("renders global pinned conversations once with project labels and sidebar order", () => {
		const initialProjects: Project[] = [
			{
				id: "project-1",
				name: "House tasks",
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

	it("marks a completed Atlas badge seen when the conversation is opened", async () => {
		conversations.set([
			{
				id: "atlas-chat",
				title: "Atlas chat",
				projectId: null,
				updatedAt: 200,
				sidebarPinned: false,
				sidebarSortOrder: null,
				atlasBadge: {
					jobId: "atlas-job-1",
					status: "succeeded",
					label: "Completed Atlas report",
					completedAt: 1_789_000,
					updatedAt: 1_789_000,
				},
			},
		]);

		render(ConversationList);

		expect(screen.getByLabelText("Completed Atlas report")).toBeInTheDocument();
		await fireEvent.click(screen.getByTestId("conversation-item"));

		await waitFor(() =>
			expect(
				screen.queryByLabelText("Completed Atlas report"),
			).not.toBeInTheDocument(),
		);
		expect(get(currentConversationId)).toBe("atlas-chat");
	});

	it("reorders project folders as one persisted list with whole-row drag", async () => {
		const projectRows: Project[] = [
			{
				id: "project-first",
				name: "Project first",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "project-later",
				name: "Project later",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
			},
			{
				id: "project-third",
				name: "Project third",
				sortOrder: 2,
				createdAt: 3,
				updatedAt: 3,
			},
		];
		projects.set(projectRows);

		render(ConversationList, { initialProjects: projectRows });

		const projectIds = () =>
			screen
				.getAllByTestId("project-drop-target")
				.map((row) => row.dataset.projectId);

		expect(projectIds()).toEqual([
			"project-first",
			"project-later",
			"project-third",
		]);

		const getReorderRow = (id: string) =>
			screen
				.getAllByTestId("sidebar-reorder-row")
				.find((row) => row.dataset.reorderId === id);
		await fireEvent.dragStart(getReorderRow("project-first") as HTMLElement);
		await fireEvent.dragOver(getReorderRow("project-third") as HTMLElement);
		await fireEvent.drop(getReorderRow("project-third") as HTMLElement);

		expect(
			screen.queryByRole("button", { name: /Move Project first/i }),
		).not.toBeInTheDocument();
		expect(projectIds()).toEqual([
			"project-later",
			"project-first",
			"project-third",
		]);
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/projects/sidebar-order",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({
						ids: ["project-later", "project-first", "project-third"],
					}),
				}),
			),
		);
	});

	it("reorders an open project folder from its expanded drop area with an insert line", async () => {
		const projectRows: Project[] = [
			{
				id: "project-first",
				name: "Project first",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "project-later",
				name: "Project later",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
			},
			{
				id: "project-third",
				name: "Project third",
				sortOrder: 2,
				createdAt: 3,
				updatedAt: 3,
			},
		];
		projects.set(projectRows);
		conversations.set([
			{
				id: "inside-third",
				title: "Inside third",
				projectId: "project-third",
				updatedAt: 100,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);
		setProjectFolderExpanded("project-third", true);

		render(ConversationList, { initialProjects: projectRows });

		const projectIds = () =>
			screen
				.getAllByTestId("project-drop-target")
				.map((row) => row.dataset.projectId);
		const getReorderRow = (id: string) =>
			screen
				.getAllByTestId("sidebar-reorder-row")
				.find((row) => row.dataset.reorderId === id) as HTMLElement;
		const thirdFolderZone = screen
			.getAllByTestId("project-folder-drop-zone")
			.find(
				(zone) => zone.dataset.projectId === "project-third",
			) as HTMLElement;
		vi.spyOn(thirdFolderZone, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			width: 240,
			height: 120,
			top: 0,
			right: 240,
			bottom: 120,
			left: 0,
			toJSON: () => ({}),
		} as DOMRect);

		await fireEvent.dragStart(getReorderRow("project-first"));
		await fireEvent.dragOver(thirdFolderZone);

		await waitFor(() =>
			expect(
				screen.getByTestId("project-reorder-line-project-third-before"),
			).toHaveClass("project-reorder-insert-line-active"),
		);

		await fireEvent.drop(thirdFolderZone);

		expect(projectIds()).toEqual([
			"project-later",
			"project-first",
			"project-third",
		]);
		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/projects/sidebar-order",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({
						ids: ["project-later", "project-first", "project-third"],
					}),
				}),
			),
		);
	});

	it("unpins a pinned chat when dropped into the unorganized chat area", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "/api/conversations/pinned-chat") {
					const body = JSON.parse(String(init?.body ?? "{}")) as {
						projectId?: string | null;
						sidebarPinned?: boolean;
					};
					return new Response(
						JSON.stringify({
							id: "pinned-chat",
							title: "Pinned chat",
							projectId: body.projectId !== undefined ? body.projectId : null,
							updatedAt: 200,
							sidebarPinned: body.sidebarPinned ?? true,
							sidebarSortOrder: body.sidebarPinned === false ? null : 0,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({ conversations: [], projects: [] }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const initialProjects: Project[] = [
			{
				id: "project-1",
				name: "House tasks",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
		];
		projects.set(initialProjects);
		conversations.set([
			{
				id: "pinned-chat",
				title: "Pinned chat",
				projectId: "project-1",
				updatedAt: 200,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
		]);

		render(ConversationList, { initialProjects });

		const pinnedRow = screen
			.getAllByTestId("sidebar-reorder-row")
			.find((row) => row.dataset.reorderId === "pinned-chat");
		await fireEvent.dragStart(pinnedRow as HTMLElement);
		await fireEvent.dragOver(screen.getByTestId("unorganized-drop-target"));
		await fireEvent.drop(screen.getByTestId("unorganized-drop-target"));

		await waitFor(() =>
			expect(
				within(screen.getByTestId("unorganized-drop-target")).getByText(
					"Pinned chat",
				),
			).toBeInTheDocument(),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/pinned-chat",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ projectId: null }),
			}),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/conversations/pinned-chat",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ sidebarPinned: false }),
			}),
		);
	});
});

describe("ConversationList section headers (ADR-0043 Slice 16)", () => {
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
		currentConversationId.set(null);
		clearProjectStore();
		sidebarProjectsExpanded.set(true);
		sidebarChatsExpanded.set(true);
		sidebarPinnedExpanded.set(true);
	});

	it("renders a collapsible Pinned section header with a collapse control when pinned chats exist", () => {
		conversations.set([
			{
				id: "pinned-1",
				title: "Pinned chat",
				updatedAt: 100,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
		]);

		render(ConversationList);

		expect(
			screen.getByRole("button", { name: "Collapse Pinned section" }),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("pinned-conversations-section"),
		).toBeInTheDocument();
	});

	it("collapses the Pinned section when its header is toggled", async () => {
		conversations.set([
			{
				id: "pinned-1",
				title: "Pinned chat",
				updatedAt: 100,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
		]);

		render(ConversationList);

		await fireEvent.click(
			screen.getByRole("button", { name: "Collapse Pinned section" }),
		);

		expect(get(sidebarPinnedExpanded)).toBe(false);
		expect(
			screen.getByRole("button", { name: "Expand Pinned section" }),
		).toBeInTheDocument();
	});

	it("always renders the Chats section header even when there are no conversations", () => {
		conversations.set([]);

		render(ConversationList);

		// Chats header must remain visible (empty-state lives inside it).
		expect(
			screen.getByRole("button", { name: "Collapse Chats section" }),
		).toBeInTheDocument();
		expect(screen.getByText("No conversations yet")).toBeInTheDocument();
	});

	it("shows a chat-count badge on a project row equal to its non-pinned conversations", () => {
		const initialProjects: Project[] = [
			{
				id: "project-1",
				name: "House tasks",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
		];
		projects.set(initialProjects);
		conversations.set([
			{
				id: "a",
				title: "Chat A",
				projectId: "project-1",
				updatedAt: 1,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
			{
				id: "b",
				title: "Chat B",
				projectId: "project-1",
				updatedAt: 2,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
			{
				id: "c",
				title: "Pinned C",
				projectId: "project-1",
				updatedAt: 3,
				sidebarPinned: true,
				sidebarSortOrder: 0,
			},
		]);

		render(ConversationList, { initialProjects });

		expect(
			screen.getByTestId("project-chat-count-project-1"),
		).toHaveTextContent("2");
	});
});
