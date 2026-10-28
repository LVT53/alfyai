import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { get, readable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import {
	deregisterDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import type { ConversationListItem } from "$lib/server/services/conversations";
import type { Project } from "$lib/server/services/projects";
import {
	conversations,
	deleteConversationsByIds,
} from "$lib/stores/conversations";
import { clearProjectStore, projects } from "$lib/stores/projects";
import { uiLanguage } from "$lib/stores/settings";
import { clearToasts, toasts } from "$lib/stores/toast";
import {
	clearProjectFolderExpanded,
	currentConversationId,
	projectFolderExpanded,
	setProjectFolderExpanded,
	sidebarChatsExpanded,
	sidebarOpen,
	sidebarPinnedExpanded,
	sidebarProjectsExpanded,
} from "$lib/stores/ui";
import ConversationList from "./ConversationList.svelte";

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
}));

// The real store, except that `deleteConversationsByIds` can be made to fail
// for one test: it calls through to the real one otherwise.
vi.mock("$lib/stores/conversations", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/stores/conversations")>();
	return {
		...actual,
		deleteConversationsByIds: vi.fn(actual.deleteConversationsByIds),
	};
});

vi.mock("$app/stores", () => ({
	page: readable({ url: new URL("http://localhost/") }),
}));

// The delete dialog (DialogShell) and the sections play Svelte transitions, and
// jsdom would never finish their outros: a closed dialog would stay in the page.
vi.mock("svelte/transition", () => ({
	fade: () => ({}),
	fly: () => ({}),
	scale: () => ({}),
	slide: () => ({}),
}));

if (typeof Element !== "undefined") {
	Element.prototype.animate = vi.fn().mockImplementation(() => {
		const animation = {
			finished: Promise.resolve(),
			cancel: vi.fn(),
			play: vi.fn(),
			onfinish: null as Animation["onfinish"],
		} as unknown as Animation;
		setTimeout(() => {
			animation.onfinish?.call(
				animation,
				new Event("finish") as AnimationPlaybackEvent,
			);
		}, 0);
		return animation;
	});
}

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
				hasInstructions: false,
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
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "project-later",
				name: "Project later",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 2,
			},
			{
				id: "project-third",
				name: "Project third",
				sortOrder: 2,
				hasInstructions: false,
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
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "project-later",
				name: "Project later",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 2,
			},
			{
				id: "project-third",
				name: "Project third",
				sortOrder: 2,
				hasInstructions: false,
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
				hasInstructions: false,
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

// Owner-reported bug: moving a chat into a (sub-)folder must never change
// that folder's own expanded/collapsed state. A collapsed folder receiving a
// drop must stay collapsed (the user has to open it themselves to see the
// chat land inside), and an already-expanded folder must stay expanded. This
// covers both move paths — drag-and-drop onto the folder's drop zone and the
// "Move to project" context-menu action — since only the drag path used to
// call `setProjectFolderExpanded(...)` after a successful move.
describe("ConversationList does not auto-expand folders on conversation move", () => {
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
		clearProjectFolderExpanded("project-1");
	});

	// A move's fetch call resolves on a microtask chain (mock Response ->
	// .json() -> store update -> the component's post-await line). `waitFor`
	// on "fetch was called" can return before that whole chain has drained, so
	// tests that assert a side effect did NOT happen need a real flush point
	// afterwards, not just the fetch-called signal.
	async function flushMicrotasks() {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	function seedOneProjectAndOneUnorganizedChat(): Project[] {
		const initialProjects: Project[] = [
			{
				id: "project-1",
				name: "House tasks",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		];
		projects.set(initialProjects);
		conversations.set([
			{
				id: "unorganized-chat",
				title: "Unorganized chat",
				updatedAt: 100,
				sidebarPinned: false,
				sidebarSortOrder: null,
			},
		]);
		return initialProjects;
	}

	it("leaves a collapsed project folder collapsed after a conversation is dropped into it", async () => {
		const initialProjects = seedOneProjectAndOneUnorganizedChat();
		// Folder starts collapsed: no setProjectFolderExpanded call for it.

		render(ConversationList, { initialProjects });

		const conversationRow = screen
			.getAllByTestId("conversation-item")
			.find(
				(row) => row.dataset.conversationId === "unorganized-chat",
			) as HTMLElement;
		const folderDropZone = screen
			.getAllByTestId("project-folder-drop-zone")
			.find((zone) => zone.dataset.projectId === "project-1") as HTMLElement;

		await fireEvent.dragStart(conversationRow);
		await fireEvent.dragOver(folderDropZone);
		await fireEvent.drop(folderDropZone);

		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/conversations/unorganized-chat",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({ projectId: "project-1" }),
				}),
			),
		);
		await flushMicrotasks();
		expect(get(projectFolderExpanded)["project-1"]).not.toBe(true);
		expect(
			screen.queryByTestId("project-conversations-project-1"),
		).not.toBeInTheDocument();
	});

	it("leaves an already-expanded project folder expanded after a conversation is dropped into it", async () => {
		const initialProjects = seedOneProjectAndOneUnorganizedChat();
		setProjectFolderExpanded("project-1", true);

		render(ConversationList, { initialProjects });

		const conversationRow = screen
			.getAllByTestId("conversation-item")
			.find(
				(row) => row.dataset.conversationId === "unorganized-chat",
			) as HTMLElement;
		const folderDropZone = screen
			.getAllByTestId("project-folder-drop-zone")
			.find((zone) => zone.dataset.projectId === "project-1") as HTMLElement;

		await fireEvent.dragStart(conversationRow);
		await fireEvent.dragOver(folderDropZone);
		await fireEvent.drop(folderDropZone);

		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/conversations/unorganized-chat",
				expect.objectContaining({ method: "PATCH" }),
			),
		);
		await flushMicrotasks();
		expect(get(projectFolderExpanded)["project-1"]).toBe(true);
		expect(
			screen.getByTestId("project-conversations-project-1"),
		).toBeInTheDocument();
	});

	it("leaves a collapsed project folder collapsed after moving a conversation via the Move to project menu", async () => {
		const initialProjects = seedOneProjectAndOneUnorganizedChat();

		render(ConversationList, { initialProjects });

		const conversationRow = screen
			.getAllByTestId("conversation-item")
			.find(
				(row) => row.dataset.conversationId === "unorganized-chat",
			) as HTMLElement;

		await fireEvent.click(
			within(conversationRow).getByRole("button", {
				name: "Conversation options",
			}),
		);
		await fireEvent.click(screen.getByText("Move to project"));
		const submenus = document.querySelectorAll(".conversation-menu");
		const submenu = submenus[submenus.length - 1] as HTMLElement;
		await fireEvent.click(within(submenu).getByText("House tasks"));

		await waitFor(() =>
			expect(fetch).toHaveBeenCalledWith(
				"/api/conversations/unorganized-chat",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({ projectId: "project-1" }),
				}),
			),
		);
		await flushMicrotasks();
		expect(get(projectFolderExpanded)["project-1"]).not.toBe(true);
		expect(
			screen.queryByTestId("project-conversations-project-1"),
		).not.toBeInTheDocument();
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
				hasInstructions: false,
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

// ── Multi-select ─────────────────────────────────────────────────────────────
//
// What a person does with a selection, through the rows and the bar as they
// really are: `ConversationItem` emits the picks, `SidebarSelectionBar` the
// actions, and the list owns the state and makes the bulk calls. The server is
// a `fetch` that answers `POST /api/conversations/batch`.

type BatchBody =
	| { action: "delete"; ids: string[] }
	| { action: "move"; ids: string[]; projectId: string | null }
	| { action: "pin"; ids: string[]; pinned: boolean };

type BatchAnswer =
	| { id: string; ok: true }
	| { id: string; ok: false; error: "failed" | "not_found" };

describe("ConversationList multi-select", () => {
	let batches: BatchBody[];
	// What happened, in order: "goto" for a navigation, "batch" for a batch request.
	let events: string[];
	let answer: (body: BatchBody) => Promise<BatchAnswer[]> | BatchAnswer[];

	function allOk(body: BatchBody): BatchAnswer[] {
		return body.ids.map((id) => ({ id, ok: true }));
	}

	function failing(...failedIds: string[]) {
		return (body: BatchBody): BatchAnswer[] =>
			body.ids.map((id) =>
				failedIds.includes(id)
					? { id, ok: false, error: "failed" }
					: { id, ok: true },
			);
	}

	// A request that stays open until the test lets it go.
	function hold() {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { gate, release };
	}

	function chat(
		id: string,
		overrides: Partial<ConversationListItem> = {},
	): ConversationListItem {
		return {
			id,
			title: `Chat ${id}`,
			projectId: null,
			updatedAt: 1000,
			sidebarPinned: false,
			sidebarSortOrder: null,
			...overrides,
		};
	}

	function pinned(id: string, order: number): ConversationListItem {
		return chat(id, { sidebarPinned: true, sidebarSortOrder: order });
	}

	function project(id: string, name: string, sortOrder = 0): Project {
		return {
			id,
			name,
			sortOrder,
			hasInstructions: false,
			createdAt: sortOrder + 1,
			updatedAt: sortOrder + 1,
		};
	}

	function seed(
		chats: ConversationListItem[],
		projectRows: Project[] = [],
		expandedFolders: string[] = [],
	) {
		projects.set(projectRows);
		conversations.set(chats);
		for (const id of expandedFolders) setProjectFolderExpanded(id, true);
		return render(ConversationList, { initialProjects: projectRows });
	}

	function row(id: string): HTMLElement {
		const found = screen
			.getAllByTestId("conversation-item")
			.find((item) => item.dataset.conversationId === id);
		if (!found) throw new Error(`no row for ${id}`);
		return found;
	}

	function hasRow(id: string): boolean {
		return screen
			.queryAllByTestId("conversation-item")
			.some((item) => item.dataset.conversationId === id);
	}

	// Cmd-click by default, which adds the chat to the selection or takes it out.
	function pick(id: string, init: MouseEventInit = { metaKey: true }) {
		return fireEvent.click(row(id), init);
	}

	function bar(): HTMLElement | null {
		return screen.queryByTestId("sidebar-selection-bar");
	}

	function countText(): string | undefined {
		return screen.getByTestId("selection-count").textContent?.trim();
	}

	function selectedIds(): (string | undefined)[] {
		return screen
			.getAllByTestId("conversation-item")
			.filter((item) => item.dataset.selected === "true")
			.map((item) => item.dataset.conversationId);
	}

	function toastMessages(): string[] {
		return get(toasts).map((entry) => entry.message);
	}

	async function confirmDelete() {
		await fireEvent.click(await screen.findByTestId("confirm-delete"));
	}

	beforeEach(() => {
		clearToasts();
		batches = [];
		events = [];
		answer = allOk;
		vi.mocked(goto).mockReset();
		vi.mocked(goto).mockImplementation(async () => {
			events.push("goto");
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) === "/api/conversations/batch") {
					const body = JSON.parse(String(init?.body)) as BatchBody;
					events.push("batch");
					batches.push(body);
					return new Response(JSON.stringify({ results: await answer(body) }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(
					JSON.stringify({ conversations: [], projects: [] }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}),
		);
		conversations.set([]);
		currentConversationId.set(null);
		clearProjectStore();
		sidebarOpen.set(true);
		sidebarProjectsExpanded.set(true);
		sidebarChatsExpanded.set(true);
		sidebarPinnedExpanded.set(true);
		for (const id of ["p1", "p2"]) clearProjectFolderExpanded(id);
	});

	afterEach(() => {
		clearToasts();
		sidebarOpen.set(true);
	});

	describe("starting, extending and ending a selection", () => {
		it("opens a selection on the first Cmd-click and counts every pick", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			expect(bar()).not.toBeInTheDocument();

			await pick("a");
			expect(countText()).toBe("1 selected");
			await pick("b");

			expect(
				screen.getByRole("toolbar", { name: "Selected chats" }),
			).toBeInTheDocument();
			expect(countText()).toBe("2 selected");
			expect(selectedIds()).toEqual(["a", "b"]);
		});

		it("starts from Select in a row's menu, and Escape ends it from the page body", async () => {
			seed([chat("a"), chat("b")]);
			await fireEvent.click(
				within(row("a")).getByLabelText("Conversation options"),
			);
			await fireEvent.click(screen.getByTestId("select-option"));

			expect(countText()).toBe("1 selected");
			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
			expect(row("a")).toHaveAttribute("aria-pressed", "true");

			await fireEvent.keyDown(document.body, { key: "Escape" });

			expect(bar()).not.toBeInTheDocument();
			expect(row("a")).not.toHaveAttribute("aria-pressed");
		});

		it("takes a plain click as a pick while selecting, and does not open the chat", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");

			await fireEvent.click(row("b"));

			expect(countText()).toBe("2 selected");
			expect(goto).not.toHaveBeenCalled();
			expect(get(currentConversationId)).toBeNull();
		});

		it("takes the Cmd-click that starts a selection as a pick, not as opening the chat", async () => {
			seed([chat("a")]);

			await pick("a");

			expect(countText()).toBe("1 selected");
			expect(goto).not.toHaveBeenCalled();
			expect(get(currentConversationId)).toBeNull();
		});

		it("selects from the open chat to the clicked row on a first Shift-click, in the order shown", async () => {
			seed([chat("a"), chat("b"), chat("c"), chat("d"), chat("e")]);
			currentConversationId.set("b");

			await pick("d", { shiftKey: true });

			expect(selectedIds()).toEqual(["b", "c", "d"]);
			expect(countText()).toBe("3 selected");
		});

		it("selects only the clicked chat on a first Shift-click when the open chat is not shown", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			currentConversationId.set("a-chat-in-a-collapsed-folder");

			await pick("c", { shiftKey: true });

			expect(selectedIds()).toEqual(["c"]);
		});

		it("extends from the last chat clicked, up or down, and keeps the earlier picks", async () => {
			seed([chat("a"), chat("b"), chat("c"), chat("d"), chat("e")]);

			await pick("d");
			await pick("b", { shiftKey: true });
			expect(selectedIds()).toEqual(["b", "c", "d"]);

			await pick("e", { metaKey: true });
			await pick("a", { shiftKey: true });
			expect(selectedIds()).toEqual(["a", "b", "c", "d", "e"]);
		});

		it("selects every shown row with Select all, and disables it once they all are selected", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			expect(screen.getByTestId("selection-select-all")).toBeEnabled();

			await fireEvent.click(screen.getByTestId("selection-select-all"));

			expect(countText()).toBe("3 selected");
			expect(screen.getByTestId("selection-select-all")).toBeDisabled();

			await pick("b");
			expect(screen.getByTestId("selection-select-all")).toBeEnabled();
		});

		it("takes only the rows on screen with Select all: a collapsed section's chats stay out", async () => {
			sidebarChatsExpanded.set(false);
			seed([pinned("pin", 0), chat("a"), chat("b")]);
			await pick("pin");

			await fireEvent.click(screen.getByTestId("selection-select-all"));
			expect(countText()).toBe("1 selected");

			await fireEvent.click(
				screen.getByRole("button", { name: "Expand Chats section" }),
			);
			expect(selectedIds()).toEqual(["pin"]);
			expect(screen.getByTestId("selection-select-all")).toBeEnabled();

			await fireEvent.click(screen.getByTestId("selection-select-all"));
			expect(countText()).toBe("3 selected");
		});

		it("collapsing a section takes its chats out of the selection", async () => {
			seed([pinned("pin", 0), chat("a"), chat("b")]);
			await pick("pin");
			await pick("a");
			await pick("b");
			expect(countText()).toBe("3 selected");

			await fireEvent.click(
				screen.getByRole("button", { name: "Collapse Chats section" }),
			);
			expect(countText()).toBe("1 selected");

			// Opening it again does not bring them back.
			await fireEvent.click(
				screen.getByRole("button", { name: "Expand Chats section" }),
			);
			expect(selectedIds()).toEqual(["pin"]);
		});

		it("collapsing a project folder takes its chats out of the selection, and so does collapsing Projects", async () => {
			seed(
				[
					chat("f1", { projectId: "p1" }),
					chat("g1", { projectId: "p2" }),
					chat("a"),
				],
				[project("p1", "Alpha"), project("p2", "Beta", 1)],
				["p1", "p2"],
			);
			await pick("f1");
			await pick("g1");
			await pick("a");
			expect(countText()).toBe("3 selected");

			await fireEvent.click(screen.getAllByTestId("project-drop-target")[0]);
			expect(countText()).toBe("2 selected");

			await fireEvent.click(
				screen.getByRole("button", { name: "Collapse Projects section" }),
			);
			expect(countText()).toBe("1 selected");
		});

		it("ends the selection when the section that holds all of it collapses", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			expect(countText()).toBe("1 selected");

			await fireEvent.click(
				screen.getByRole("button", { name: "Collapse Chats section" }),
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
		});

		it("lets project folders open and close while selecting, and keeps the selection", async () => {
			seed(
				[chat("f1", { projectId: "p1" }), chat("a")],
				[project("p1", "Alpha")],
			);
			await pick("a");
			const folder = screen.getByTestId("project-drop-target");

			await fireEvent.click(folder);
			expect(
				screen.getByTestId("project-conversations-p1"),
			).toBeInTheDocument();
			expect(get(projectFolderExpanded).p1).toBe(true);
			expect(countText()).toBe("1 selected");

			await fireEvent.click(folder);
			expect(get(projectFolderExpanded).p1).toBe(false);
			expect(countText()).toBe("1 selected");
			expect(goto).not.toHaveBeenCalled();
		});

		it("closing the drawer ends the selection", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			await pick("b");
			expect(countText()).toBe("2 selected");

			sidebarOpen.set(false);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(selectedIds()).toEqual([]);
		});

		it("ends the selection when its last chat is unticked", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			await pick("b");

			await pick("a");
			expect(countText()).toBe("1 selected");
			await pick("b");

			expect(bar()).not.toBeInTheDocument();
			expect(selectedIds()).toEqual([]);
		});

		it("lets the close button end the selection", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");

			await fireEvent.click(screen.getByTestId("selection-close"));

			expect(bar()).not.toBeInTheDocument();
			expect(selectedIds()).toEqual([]);
		});

		it("drops a selected chat that leaves the list, and ends the selection when the last one goes", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");

			conversations.update((items) => items.filter((item) => item.id !== "a"));
			await waitFor(() => expect(countText()).toBe("1 selected"));

			conversations.update((items) => items.filter((item) => item.id !== "b"));
			await waitFor(() => expect(bar()).not.toBeInTheDocument());
		});

		it("clears a drag that was under way when a selection starts", async () => {
			seed([chat("a"), chat("b")]);
			await fireEvent.dragStart(row("b"));
			expect(row("b")).toHaveClass("conversation-item-dragging");

			await pick("a");

			expect(row("b")).not.toHaveClass("conversation-item-dragging");
		});

		it("keeps the chat rows draggable while selecting, but not the reorder rows", async () => {
			seed(
				[pinned("pin", 0), chat("f1", { projectId: "p1" }), chat("a")],
				[project("p1", "Alpha")],
				["p1"],
			);

			await pick("a");

			// A selected row drags the selection, an unselected one itself.
			expect(row("a")).toHaveAttribute("draggable", "true");
			expect(row("f1")).toHaveAttribute("draggable", "true");
			for (const reorderRow of screen.getAllByTestId("sidebar-reorder-row")) {
				expect(reorderRow).toHaveAttribute("draggable", "false");
			}
		});

		it("puts no options button on a row while selecting", async () => {
			seed([chat("a"), chat("b")]);
			expect(screen.getAllByLabelText("Conversation options")).toHaveLength(2);

			await pick("a");

			expect(
				screen.queryByLabelText("Conversation options"),
			).not.toBeInTheDocument();
		});
	});

	describe("Escape", () => {
		it("leaves the selection alone while a dialog is open", async () => {
			seed([chat("a")]);
			await pick("a");
			const dialog = Symbol("a dialog that is open");
			registerDialog(dialog);
			try {
				await fireEvent.keyDown(document.body, { key: "Escape" });
				expect(bar()).toBeInTheDocument();
			} finally {
				deregisterDialog(dialog);
			}

			await fireEvent.keyDown(document.body, { key: "Escape" });
			expect(bar()).not.toBeInTheDocument();
		});

		it("leaves the selection alone when it is typed into a text field", async () => {
			seed([chat("a")]);
			await pick("a");
			const input = document.createElement("input");
			const textarea = document.createElement("textarea");
			const select = document.createElement("select");
			const editable = document.createElement("div");
			editable.setAttribute("contenteditable", "true");
			const inside = document.createElement("span");
			editable.appendChild(inside);
			document.body.append(input, textarea, select, editable);
			try {
				for (const field of [input, textarea, select, editable, inside]) {
					await fireEvent.keyDown(field, { key: "Escape" });
					expect(bar(), field.tagName).toBeInTheDocument();
				}
			} finally {
				input.remove();
				textarea.remove();
				select.remove();
				editable.remove();
			}
		});

		it("leaves a press that something else already handled", async () => {
			seed([chat("a")]);
			await pick("a");
			const handled = (event: KeyboardEvent) => event.preventDefault();
			window.addEventListener("keydown", handled, true);
			try {
				await fireEvent.keyDown(document.body, { key: "Escape" });
				expect(bar()).toBeInTheDocument();
			} finally {
				window.removeEventListener("keydown", handled, true);
			}
		});

		it("ignores every other key", async () => {
			seed([chat("a")]);
			await pick("a");

			await fireEvent.keyDown(document.body, { key: "Enter" });
			await fireEvent.keyDown(document.body, { key: "a" });

			expect(bar()).toBeInTheDocument();
		});

		it("does nothing when no selection is open", async () => {
			seed([chat("a")]);

			expect(await fireEvent.keyDown(document.body, { key: "Escape" })).toBe(
				true,
			);
		});

		it("closes only the Move menu while it is open, and the next Escape ends the selection", async () => {
			seed([chat("a"), chat("b")], [project("p1", "Alpha")]);
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-move"));
			expect(screen.getByRole("menu")).toBeInTheDocument();

			await fireEvent.keyDown(document.activeElement ?? document.body, {
				key: "Escape",
			});

			expect(screen.queryByRole("menu")).not.toBeInTheDocument();
			expect(bar()).toBeInTheDocument();

			await fireEvent.keyDown(document.body, { key: "Escape" });
			expect(bar()).not.toBeInTheDocument();
		});

		it("closes only the delete dialog while it is open, and keeps the selection", async () => {
			seed([chat("a")]);
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-delete"));
			const confirm = await screen.findByTestId("confirm-delete");

			await fireEvent.keyDown(confirm, { key: "Escape" });

			await waitFor(() =>
				expect(screen.queryByTestId("confirm-delete")).not.toBeInTheDocument(),
			);
			expect(bar()).toBeInTheDocument();
			expect(batches).toEqual([]);
		});
	});

	describe("while a bulk action runs", () => {
		it("toggles, Esc and close are ignored while a bulk action runs", async () => {
			// A project, so that the bar has its Move button too.
			seed([chat("a"), chat("b"), chat("c")], [project("p1", "Alpha")]);
			const { gate, release } = hold();
			answer = async (body) => {
				await gate;
				return allOk(body);
			};
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));
			await confirmDelete();
			await waitFor(() => expect(batches).toHaveLength(1));

			// Every button of the bar is disabled ...
			for (const id of [
				"selection-close",
				"selection-select-all",
				"selection-pin",
				"selection-move",
				"selection-delete",
			]) {
				expect(screen.getByTestId(id), id).toBeDisabled();
			}
			// ... and the list ignores what still reaches it: a row, Escape, and the
			// bar's buttons (jsdom, unlike a browser, delivers a click to a disabled one).
			await pick("c");
			expect(selectedIds()).toEqual(["a", "b"]);
			await fireEvent.click(row("a"));
			expect(selectedIds()).toEqual(["a", "b"]);
			await fireEvent.keyDown(document.body, { key: "Escape" });
			expect(bar()).toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("selection-close"));
			expect(bar()).toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("selection-select-all"));
			expect(countText()).toBe("2 selected");
			await fireEvent.click(screen.getByTestId("selection-delete"));
			expect(screen.queryByTestId("confirm-delete")).not.toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("selection-pin"));
			expect(goto).not.toHaveBeenCalled();

			// Then the answer applies to the selection as it was.
			release();
			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(hasRow("a")).toBe(false);
			expect(hasRow("b")).toBe(false);
			expect(hasRow("c")).toBe(true);
			expect(batches).toHaveLength(1);
		});

		it("does not bring back a selection the person ended while it ran", async () => {
			seed([chat("a"), chat("b")]);
			const { gate, release } = hold();
			answer = async (body) => {
				await gate;
				return failing("a", "b")(body);
			};
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));
			await confirmDelete();
			await waitFor(() => expect(batches).toHaveLength(1));

			// Closing the drawer is the one way to end it now.
			sidebarOpen.set(false);
			await waitFor(() => expect(bar()).not.toBeInTheDocument());

			release();
			await waitFor(() =>
				expect(toastMessages()).toEqual([
					"Couldn't delete 2 chats. Try again.",
				]),
			);
			expect(bar()).not.toBeInTheDocument();
			expect(selectedIds()).toEqual([]);
		});

		it("does not stay busy when the call itself throws, and says it failed", async () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			seed([chat("a"), chat("b")]);
			vi.mocked(deleteConversationsByIds).mockRejectedValueOnce(
				new Error("the store broke"),
			);
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() =>
				expect(toastMessages()).toEqual([
					"Couldn't delete 2 chats. Try again.",
				]),
			);
			expect(countText()).toBe("2 selected");
			expect(screen.getByTestId("selection-close")).toBeEnabled();
			expect(screen.getByTestId("selection-delete")).toBeEnabled();
		});
	});

	// A live region that is created together with its text is missed by most
	// screen readers, so the list keeps one in the page whether or not a selection
	// is open and the count is written into it; the bar's own count is only seen.
	describe("announcing the count", () => {
		function liveRegion(): HTMLElement {
			return screen.getByTestId("selection-live-region");
		}

		it("has a polite live region in the page before a selection starts, with nothing in it", () => {
			seed([chat("a"), chat("b")]);

			const region = liveRegion();
			expect(region).toHaveAttribute("aria-live", "polite");
			expect(region).toHaveAttribute("aria-atomic", "true");
			expect(region.textContent).toBe("");
			// Visually hidden: a screen reader reads it, nothing is drawn.
			expect(region).toHaveClass("sr-only");
			expect(bar()).not.toBeInTheDocument();
		});

		it("reads the count into the same region as the selection grows and shrinks", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			const region = liveRegion();

			await pick("a");
			expect(region).toHaveTextContent("1 selected");
			await pick("b");
			expect(region).toHaveTextContent("2 selected");
			await pick("c");
			await pick("a");
			expect(region).toHaveTextContent("2 selected");

			// The one node that was there from the start, not one made for the count.
			expect(liveRegion()).toBe(region);
		});

		it("reads the count of Select all", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");

			await fireEvent.click(screen.getByTestId("selection-select-all"));

			expect(liveRegion()).toHaveTextContent("3 selected");
		});

		it("empties when the selection ends, and stays in the page", async () => {
			seed([chat("a"), chat("b")]);
			const region = liveRegion();
			await pick("a");
			await pick("b");
			expect(region).toHaveTextContent("2 selected");

			await fireEvent.click(screen.getByTestId("selection-close"));

			expect(bar()).not.toBeInTheDocument();
			expect(liveRegion()).toBe(region);
			expect(region.textContent).toBe("");
		});

		it("keeps the visible count in the bar, without a live region of its own", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			await pick("b");

			expect(countText()).toBe("2 selected");
			expect(
				screen.getByTestId("selection-count").closest("[aria-live]"),
			).toBeNull();
		});

		it("speaks Hungarian in Hungarian", async () => {
			uiLanguage.set("hu");
			try {
				seed([chat("a"), chat("b")]);
				await pick("a");
				await pick("b");

				expect(liveRegion()).toHaveTextContent("2 kijelölve");
			} finally {
				uiLanguage.set("en");
			}
		});
	});

	// The bar is removed with the selection, and a button of it that holds the
	// focus takes the focus along to <body>: a keyboard user would start again from
	// the top of the page. The focus goes to the row the selection was anchored on
	// (the first row shown when that one is gone), and only when the keyboard had
	// it on the bar: a mouse press leaves a button focused too, and moving the
	// focus scrolls the list. Focus that was somewhere else, the composer for one,
	// stays there.
	describe("focus when the bar goes away", () => {
		// What the browser answers for `:focus-visible` on the focused element: yes
		// after a key press, no after a mouse press. jsdom answers from its own idea of
		// the last event and says no after any click, which every test here makes, so
		// the answer is set; the real browser's is pinned in the e2e spec.
		let focusVisible = true;
		let restoreMatches: () => void = () => {};
		beforeEach(() => {
			focusVisible = true;
			const matches = Element.prototype.matches;
			const spy = vi
				.spyOn(Element.prototype, "matches")
				.mockImplementation(function (this: Element, selector: string) {
					return selector === ":focus-visible"
						? focusVisible
						: matches.call(this, selector);
				});
			restoreMatches = () => spy.mockRestore();
		});
		afterEach(() => {
			restoreMatches();
		});

		it("puts focus on the anchor row when Cancel selection, which held it, ends the selection", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("c");
			const close = screen.getByTestId("selection-close");
			close.focus();
			expect(close).toHaveFocus();

			await fireEvent.click(close);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			await waitFor(() => expect(row("c")).toHaveFocus());
			expect(document.activeElement).toHaveAttribute(
				"data-testid",
				"conversation-item",
			);
		});

		it("goes to the first row shown when the anchor row is no longer shown", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("c");
			// The anchor, "c", is deleted in another tab; "a" stays selected.
			conversations.update((items) => items.filter((item) => item.id !== "c"));
			await waitFor(() => expect(countText()).toBe("1 selected"));
			const close = screen.getByTestId("selection-close");
			close.focus();

			await fireEvent.click(close);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			await waitFor(() => expect(row("a")).toHaveFocus());
		});

		it("puts focus on a row when Escape ends the selection from a button of the bar", async () => {
			seed([chat("a"), chat("b")]);
			await pick("b");
			const pin = screen.getByTestId("selection-pin");
			pin.focus();

			await fireEvent.keyDown(pin, { key: "Escape" });

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			await waitFor(() => expect(row("b")).toHaveFocus());
		});

		it("puts focus on a row after a bulk pin that started from the bar succeeds", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");
			const pin = screen.getByTestId("selection-pin");
			pin.focus();

			await fireEvent.click(pin);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "pin", ids: ["a", "b"], pinned: true },
			]);
			// "b", the anchor, is in the Pinned section now: the same chat in a new row.
			await waitFor(() => expect(row("b")).toHaveFocus());
			expect(document.activeElement).toHaveAttribute(
				"data-testid",
				"conversation-item",
			);
		});

		it("puts focus on the first row shown after a bulk move that took the anchor out of sight", async () => {
			seed([chat("a"), chat("b"), chat("c")], [project("p1", "Alpha")]);
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-move"));
			await fireEvent.click(
				(await screen.findAllByTestId("selection-move-option"))[0],
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "move", ids: ["a"], projectId: "p1" },
			]);
			// "a" is in a folder that is closed: the first row on screen is "b".
			expect(hasRow("a")).toBe(false);
			await waitFor(() => expect(row("b")).toHaveFocus());
		});

		it("puts focus on the first row left after a bulk delete confirmed from the bar", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");
			const del = screen.getByTestId("selection-delete");
			del.focus();
			await fireEvent.click(del);

			await confirmDelete();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			// The anchor, "b", is deleted with "a": "c" is what is left.
			await waitFor(() => expect(row("c")).toHaveFocus());
		});

		it("leaves the focus where it was when the selection ends from somewhere else", async () => {
			seed([chat("a"), chat("b")]);
			const elsewhere = document.createElement("button");
			document.body.append(elsewhere);
			try {
				await pick("a");
				elsewhere.focus();

				await fireEvent.keyDown(elsewhere, { key: "Escape" });

				await waitFor(() => expect(bar()).not.toBeInTheDocument());
				expect(elsewhere).toHaveFocus();
			} finally {
				elsewhere.remove();
			}
		});

		it("does not take the focus from the composer when a chat deleted elsewhere ends the selection", async () => {
			seed([chat("a"), chat("b")]);
			const composer = document.createElement("textarea");
			document.body.append(composer);
			try {
				await pick("a");
				composer.focus();

				conversations.set([chat("b")]);

				await waitFor(() => expect(bar()).not.toBeInTheDocument());
				expect(composer).toHaveFocus();
			} finally {
				composer.remove();
			}
		});

		it("puts focus on the row that started the selection from its menu", async () => {
			seed([chat("a"), chat("b")]);
			await fireEvent.click(
				within(row("b")).getByLabelText("Conversation options"),
			);
			const select = screen.getByTestId("select-option");
			select.focus();

			await fireEvent.click(select);

			await waitFor(() => expect(countText()).toBe("1 selected"));
			await waitFor(() => expect(row("b")).toHaveFocus());
		});

		// Moving the focus to a row scrolls the list to it. That is what a keyboard
		// user needs (the ring is in view), and what a mouse user must not get: a
		// press leaves the button it landed on focused, but not shown as keyboard
		// focus (`:focus-visible`), and the list would jump to the first row, away
		// from the bottom where the chats just deleted were.
		describe("when the person used the mouse", () => {
			beforeEach(() => {
				focusVisible = false;
			});

			// Every row `focus()` was called on: what scrolls.
			function rowsFocused(focusSpy: { mock: { contexts: unknown[] } }) {
				return focusSpy.mock.contexts.filter(
					(element) =>
						element instanceof HTMLElement &&
						element.dataset.testid === "conversation-item",
				);
			}

			it("does not move the focus to a row when Cancel selection ends the selection", async () => {
				seed([chat("a"), chat("b"), chat("c")]);
				await pick("a");
				await pick("c");
				const close = screen.getByTestId("selection-close");
				close.focus();
				const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
				try {
					await fireEvent.click(close);

					await waitFor(() => expect(bar()).not.toBeInTheDocument());
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(rowsFocused(focusSpy)).toEqual([]);
					expect(document.activeElement).not.toHaveAttribute(
						"data-testid",
						"conversation-item",
					);
				} finally {
					focusSpy.mockRestore();
				}
			});

			it("does not move the focus to a row after a bulk pin", async () => {
				seed([chat("a"), chat("b"), chat("c")]);
				await pick("a");
				await pick("b");
				const pin = screen.getByTestId("selection-pin");
				pin.focus();
				const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
				try {
					await fireEvent.click(pin);

					await waitFor(() => expect(bar()).not.toBeInTheDocument());
					expect(batches).toEqual([
						{ action: "pin", ids: ["a", "b"], pinned: true },
					]);
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(rowsFocused(focusSpy)).toEqual([]);
				} finally {
					focusSpy.mockRestore();
				}
			});

			it("does not move the focus to a row after a bulk delete confirmed with the mouse", async () => {
				seed([chat("a"), chat("b"), chat("c")]);
				await pick("a");
				await pick("b");
				const del = screen.getByTestId("selection-delete");
				del.focus();
				await fireEvent.click(del);
				const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
				try {
					await confirmDelete();

					await waitFor(() => expect(bar()).not.toBeInTheDocument());
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(rowsFocused(focusSpy)).toEqual([]);
				} finally {
					focusSpy.mockRestore();
				}
			});

			it("does not move the focus to a row after Select in a row's menu", async () => {
				seed([chat("a"), chat("b")]);
				await fireEvent.click(
					within(row("b")).getByLabelText("Conversation options"),
				);
				const select = screen.getByTestId("select-option");
				select.focus();
				const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
				try {
					await fireEvent.click(select);

					await waitFor(() => expect(countText()).toBe("1 selected"));
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(rowsFocused(focusSpy)).toEqual([]);
				} finally {
					focusSpy.mockRestore();
				}
			});
		});

		it("leaves focus the person moved elsewhere during a slow bulk call where they put it", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			const { gate, release } = hold();
			answer = async (body) => {
				await gate;
				return allOk(body);
			};
			await pick("a");
			await pick("b");
			const pin = screen.getByTestId("selection-pin");
			pin.focus();
			await fireEvent.click(pin);
			await waitFor(() => expect(batches).toHaveLength(1));
			// The call is slow, and the person goes to the composer meanwhile.
			const composer = document.createElement("textarea");
			document.body.append(composer);
			try {
				composer.focus();

				release();
				await waitFor(() => expect(bar()).not.toBeInTheDocument());
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(composer).toHaveFocus();
			} finally {
				composer.remove();
			}
		});

		it("still puts focus on a row when the focus fell to <body> during a slow bulk call", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			const { gate, release } = hold();
			answer = async (body) => {
				await gate;
				return allOk(body);
			};
			await pick("a");
			await pick("b");
			const pin = screen.getByTestId("selection-pin");
			pin.focus();
			await fireEvent.click(pin);
			await waitFor(() => expect(batches).toHaveLength(1));
			// A browser drops the focus of a button that is switched off.
			(document.activeElement as HTMLElement | null)?.blur();
			expect(document.body).toHaveFocus();

			release();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			await waitFor(() => expect(row("b")).toHaveFocus());
		});
	});

	describe("bulk delete", () => {
		it("asks first, naming the count, and sends nothing until the person confirms", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");

			await fireEvent.click(screen.getByTestId("selection-delete"));

			const dialog = await screen.findByRole("dialog");
			expect(within(dialog).getByText("Delete 2 chats?")).toBeInTheDocument();
			expect(
				within(dialog).getByText(
					"Their messages, files, reports, and the Documents and pictures made in them are deleted too. This can't be undone.",
				),
			).toBeInTheDocument();
			expect(batches).toEqual([]);
			expect(hasRow("a")).toBe(true);
		});

		it("opens with the focus on Cancel, so that one more Enter does not delete the chats", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			await pick("b");

			await fireEvent.click(screen.getByTestId("selection-delete"));

			const dialog = await screen.findByRole("dialog");
			const cancel = within(dialog).getByRole("button", { name: "Cancel" });
			await waitFor(() => expect(cancel).toHaveFocus());
			// The dialog's own move of the focus runs a tick after it opens: the
			// settled dialog is the one to look at.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(cancel).toHaveFocus();
			expect(within(dialog).getByTestId("confirm-delete")).not.toHaveFocus();
			expect(batches).toEqual([]);
		});

		it("deletes the selection in one batch after the confirm, and ends the selection", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([{ action: "delete", ids: ["a", "b"] }]);
			expect(hasRow("a")).toBe(false);
			expect(hasRow("b")).toBe(false);
			expect(hasRow("c")).toBe(true);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(toastMessages()).toEqual([]);
		});

		it("keeps the selection and sends nothing when the dialog is cancelled", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await fireEvent.click(
				within(await screen.findByRole("dialog")).getByRole("button", {
					name: "Cancel",
				}),
			);

			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			expect(countText()).toBe("2 selected");
			expect(batches).toEqual([]);
			expect(screen.getByTestId("selection-delete")).toBeEnabled();
		});

		it("names one chat in the singular", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");

			await fireEvent.click(screen.getByTestId("selection-delete"));

			expect(await screen.findByText("Delete 1 chat?")).toBeInTheDocument();
		});

		it("keeps the count in the dialog true when a chat leaves the list meanwhile", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));
			expect(await screen.findByText("Delete 2 chats?")).toBeInTheDocument();

			conversations.update((items) => items.filter((item) => item.id !== "a"));

			expect(await screen.findByText("Delete 1 chat?")).toBeInTheDocument();
		});

		it("closes the dialog when the selection under it ends", async () => {
			seed([chat("a"), chat("b")]);
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-delete"));
			await screen.findByRole("dialog");

			conversations.set([chat("b")]);

			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			expect(bar()).not.toBeInTheDocument();
		});

		it("leaves a chat that failed selected, with the bar and a toast that counts", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			answer = failing("b");
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() => expect(hasRow("a")).toBe(false));
			expect(hasRow("b")).toBe(true);
			expect(selectedIds()).toEqual(["b"]);
			expect(countText()).toBe("1 selected");
			expect(screen.getByTestId("selection-delete")).toBeEnabled();
			expect(get(toasts)).toMatchObject([
				{ type: "error", message: "Couldn't delete 1 chat. Try again." },
			]);
		});

		it("counts a chat the server no longer has as gone, not as a failure", async () => {
			seed([chat("a"), chat("b")]);
			answer = (body) =>
				body.ids.map((id) =>
					id === "b" ? { id, ok: false, error: "not_found" } : { id, ok: true },
				);
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(hasRow("a")).toBe(false);
			expect(hasRow("b")).toBe(false);
			expect(toastMessages()).toEqual([]);
		});

		it("deleting the open chat goes home first, then sends the batch", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			currentConversationId.set("a");
			const { gate, release } = hold();
			answer = async (body) => {
				await gate;
				return allOk(body);
			};
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			// The request is still open, and the page has already gone home.
			await waitFor(() => expect(batches).toHaveLength(1));
			expect(events).toEqual(["goto", "batch"]);
			expect(goto).toHaveBeenCalledTimes(1);
			expect(goto).toHaveBeenCalledWith("/");
			expect(get(currentConversationId)).toBeNull();

			release();
			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(hasRow("a")).toBe(false);
			expect(toastMessages()).toEqual([]);
		});

		it("stays on the page when the open chat is not among the deleted", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			currentConversationId.set("c");
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(goto).not.toHaveBeenCalled();
			expect(get(currentConversationId)).toBe("c");
		});

		it("does not leave the page for a delete that was cancelled", async () => {
			seed([chat("a"), chat("b")]);
			currentConversationId.set("a");
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await fireEvent.click(
				within(await screen.findByRole("dialog")).getByRole("button", {
					name: "Cancel",
				}),
			);

			expect(goto).not.toHaveBeenCalled();
			expect(get(currentConversationId)).toBe("a");
		});

		it("keeps the open chat, selected, when its delete fails after the page went home", async () => {
			seed([chat("a"), chat("b")]);
			currentConversationId.set("a");
			answer = failing("a");
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() => expect(hasRow("b")).toBe(false));
			expect(hasRow("a")).toBe(true);
			expect(selectedIds()).toEqual(["a"]);
			expect(goto).toHaveBeenCalledWith("/");
			expect(toastMessages()).toEqual(["Couldn't delete 1 chat. Try again."]);
		});

		it("hands the whole selection to the store in one call, which chunks it", async () => {
			const many = Array.from({ length: 3 }, (_, index) => chat(`c${index}`));
			seed(many);
			await fireEvent.click(row("c0"), { metaKey: true });
			await fireEvent.click(screen.getByTestId("selection-select-all"));
			await fireEvent.click(screen.getByTestId("selection-delete"));

			await confirmDelete();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([{ action: "delete", ids: ["c0", "c1", "c2"] }]);
		});
	});

	describe("bulk pin", () => {
		it("pins the unpinned chats of a mixed selection, in the order shown, and leaves the pinned one", async () => {
			seed([pinned("pin", 0), chat("a"), chat("b"), chat("c")]);
			// Clicked in the order b, pin, a; shown as pin, a, b.
			await pick("b");
			await pick("pin");
			await pick("a");
			expect(
				screen.queryByRole("button", { name: "Unpin from sidebar" }),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: "Pin to sidebar" }),
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "pin", ids: ["a", "b"], pinned: true },
			]);
			const pinnedRows = within(
				screen.getByTestId("pinned-conversations-section"),
			).getAllByTestId("conversation-item");
			expect(pinnedRows.map((item) => item.dataset.conversationId)).toEqual([
				"a",
				"b",
				"pin",
			]);
		});

		it("unpins when every selected chat is pinned, naming the button for it", async () => {
			seed([pinned("p2", 1), pinned("p1", 0), chat("a")]);
			await pick("p2");
			await pick("p1");

			await fireEvent.click(
				screen.getByRole("button", { name: "Unpin from sidebar" }),
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			// In the order shown: Pinned lists p1 before p2.
			expect(batches).toEqual([
				{ action: "pin", ids: ["p1", "p2"], pinned: false },
			]);
		});

		it("says how many chats it could not pin, and keeps them selected", async () => {
			seed([chat("a"), chat("b")]);
			answer = failing("b");
			await pick("a");
			await pick("b");

			await fireEvent.click(
				screen.getByRole("button", { name: "Pin to sidebar" }),
			);

			await waitFor(() =>
				expect(toastMessages()).toEqual([
					"Couldn't update the pin on 1 chat. Try again.",
				]),
			);
			expect(selectedIds()).toEqual(["b"]);
			expect(countText()).toBe("1 selected");
		});

		// Pin shows its result before the server answers, and a Pinned section that
		// is collapsed hides the chats it just took in: the selection must not lose
		// them there, or the one that fails would come back unselected.
		it("keeps a chat that failed selected when the pin moved it out of sight meanwhile", async () => {
			sidebarPinnedExpanded.set(false);
			seed([chat("a"), chat("b")]);
			const { gate, release } = hold();
			answer = async (body) => {
				await gate;
				return failing("b")(body);
			};
			await pick("a");
			await pick("b");

			await fireEvent.click(
				screen.getByRole("button", { name: "Pin to sidebar" }),
			);
			await waitFor(() => expect(batches).toHaveLength(1));
			release();

			await waitFor(() =>
				expect(toastMessages()).toEqual([
					"Couldn't update the pin on 1 chat. Try again.",
				]),
			);
			await waitFor(() => expect(selectedIds()).toEqual(["b"]));
			expect(countText()).toBe("1 selected");
		});
	});

	describe("bulk move", () => {
		const folders = [project("p1", "Alpha"), project("p2", "Beta", 1)];

		it("moves the selection into the chosen project, skipping chats already there, in the order shown", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a"), chat("b")], folders, [
				"p1",
			]);
			// Clicked in the order b, f1, a; shown as f1, a, b.
			await pick("b");
			await pick("f1");
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-move"));

			await fireEvent.click(
				screen
					.getAllByTestId("selection-move-option")
					.find((option) => option.dataset.projectId === "p1") as HTMLElement,
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "move", ids: ["a", "b"], projectId: "p1" },
			]);
		});

		it("lists the projects in the Move menu", async () => {
			seed([chat("a")], folders);
			await pick("a");

			await fireEvent.click(screen.getByTestId("selection-move"));

			expect(
				screen
					.getAllByTestId("selection-move-option")
					.map((option) => option.textContent?.trim()),
			).toEqual(["Alpha", "Beta"]);
		});

		it("takes the chats that are in a project out of it with Remove from project, and no others", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a"), chat("b")], folders, [
				"p1",
			]);
			await pick("a");
			await pick("f1");
			await fireEvent.click(screen.getByTestId("selection-move"));

			await fireEvent.click(
				screen.getByTestId("selection-remove-from-project"),
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "move", ids: ["f1"], projectId: null },
			]);
		});

		it("offers Remove from project only while a selected chat is in a project", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a")], folders, ["p1"]);
			await pick("a");
			await fireEvent.click(screen.getByTestId("selection-move"));
			expect(
				screen.queryByTestId("selection-remove-from-project"),
			).not.toBeInTheDocument();
			await fireEvent.keyDown(document.activeElement ?? document.body, {
				key: "Escape",
			});

			await pick("f1");
			await fireEvent.click(screen.getByTestId("selection-move"));

			expect(
				screen.getByTestId("selection-remove-from-project"),
			).toBeInTheDocument();
		});

		it("sends nothing, and ends the selection, when every selected chat is already in the project", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a")], folders, ["p1"]);
			await pick("f1");
			await fireEvent.click(screen.getByTestId("selection-move"));

			await fireEvent.click(
				screen
					.getAllByTestId("selection-move-option")
					.find((option) => option.dataset.projectId === "p1") as HTMLElement,
			);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([]);
			expect(toastMessages()).toEqual([]);
		});

		it("says how many chats it could not move, and keeps them selected", async () => {
			seed([chat("a"), chat("b")], folders);
			answer = failing("b");
			await pick("a");
			await pick("b");
			await fireEvent.click(screen.getByTestId("selection-move"));

			await fireEvent.click(screen.getAllByTestId("selection-move-option")[0]);

			await waitFor(() =>
				expect(toastMessages()).toEqual(["Couldn't move 1 chat. Try again."]),
			);
			expect(selectedIds()).toEqual(["b"]);
			expect(countText()).toBe("1 selected");
		});

		it("puts no Move button on the bar when there is no project and no chat in one", async () => {
			seed([chat("a")]);
			await pick("a");

			expect(bar()).toBeInTheDocument();
			expect(screen.queryByTestId("selection-move")).not.toBeInTheDocument();
		});
	});
	describe("dragging a selection", () => {
		const folders = [project("p1", "Alpha"), project("p2", "Beta", 1)];

		function folderZone(projectId: string): HTMLElement {
			const zone = screen
				.getAllByTestId("project-folder-drop-zone")
				.find((element) => element.dataset.projectId === projectId);
			if (!zone) throw new Error(`no drop zone for ${projectId}`);
			return zone;
		}

		function bin(): HTMLElement | null {
			return screen.queryByTestId("sidebar-drop-bin");
		}

		// Requests that are not a batch: what a one-chat move or delete sends.
		function singleRequests(): string[] {
			return vi
				.mocked(fetch)
				.mock.calls.map(
					([input, init]) => `${init?.method ?? "GET"} ${String(input)}`,
				)
				.filter(
					(line) => line.startsWith("PATCH") || line.startsWith("DELETE"),
				);
		}

		async function dropOn(target: HTMLElement) {
			await fireEvent.dragOver(target);
			await fireEvent.drop(target);
		}

		it("drags every selected chat when the drag starts on a selected row, and names how many", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("c");

			await fireEvent.dragStart(row("c"));

			expect(row("a")).toHaveClass("conversation-item-dragging");
			expect(row("c")).toHaveClass("conversation-item-dragging");
			expect(row("b")).not.toHaveClass("conversation-item-dragging");
			expect(screen.getByTestId("sidebar-drag-preview")).toHaveTextContent(
				"2 chats",
			);
		});

		it("names the drag in Hungarian with the app's word for a chat", async () => {
			uiLanguage.set("hu");
			try {
				seed([chat("a"), chat("b"), chat("c")]);
				await pick("a");
				await pick("b");
				await pick("c");

				await fireEvent.dragStart(row("b"));

				expect(screen.getByTestId("sidebar-drag-preview")).toHaveTextContent(
					"3 beszélgetés",
				);
			} finally {
				uiLanguage.set("en");
			}
		});

		it("moves the whole selection into a folder in one batch, ends the selection and says so", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a"), chat("b")], folders, [
				"p1",
			]);
			await pick("b");
			await pick("a");
			await pick("f1");

			await fireEvent.dragStart(row("a"));
			await fireEvent.dragOver(folderZone("p2"));
			expect(folderZone("p2")).toHaveClass("project-drop-zone-active");
			await fireEvent.drop(folderZone("p2"));

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "move", ids: ["f1", "a", "b"], projectId: "p2" },
			]);
			expect(singleRequests()).toEqual([]);
			expect(screen.getByTestId("selection-live-region")).toHaveTextContent(
				"Moved 3 chats to Beta",
			);
		});

		it("skips the chats already in the folder it is dropped on", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a")], folders, ["p1"]);
			await pick("a");
			await pick("f1");

			await fireEvent.dragStart(row("a"));
			await dropOn(folderZone("p1"));

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "move", ids: ["a"], projectId: "p1" },
			]);
		});

		it("never opens or closes a collapsed folder it drops the selection into", async () => {
			seed([chat("a"), chat("b")], folders);
			await pick("a");
			await pick("b");

			await fireEvent.dragStart(row("a"));
			await dropOn(folderZone("p1"));

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(get(projectFolderExpanded).p1 ?? false).toBe(false);
		});

		it("takes the selected chats out of their projects when dropped on Chats", async () => {
			seed([chat("f1", { projectId: "p1" }), chat("a")], folders, ["p1"]);
			await pick("f1");
			await pick("a");

			await fireEvent.dragStart(row("f1"));
			await fireEvent.dragOver(screen.getByTestId("unorganized-drop-target"));
			expect(screen.getByTestId("unorganized-drop-target")).toHaveClass(
				"unorganized-drop-zone-active",
			);
			await fireEvent.drop(screen.getByTestId("unorganized-drop-target"));

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "move", ids: ["f1"], projectId: null },
			]);
		});

		it("pins the selection when dropped on Pinned", async () => {
			seed([pinned("pin", 0), chat("a"), chat("b")]);
			await pick("a");
			await pick("b");

			await fireEvent.dragStart(row("a"));
			const pinnedSection = screen.getByTestId("pinned-conversations-section");
			await fireEvent.dragOver(pinnedSection);
			expect(pinnedSection).toHaveClass("pinned-drop-zone-active");
			await fireEvent.drop(pinnedSection);

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([
				{ action: "pin", ids: ["a", "b"], pinned: true },
			]);
		});

		it("drags only an unselected row, as before, and keeps the selection", async () => {
			seed([chat("a"), chat("b"), chat("c")], folders);
			await pick("a");
			await pick("b");

			await fireEvent.dragStart(row("c"));
			expect(row("a")).not.toHaveClass("conversation-item-dragging");
			await dropOn(folderZone("p1"));

			await waitFor(() =>
				expect(singleRequests()).toEqual(["PATCH /api/conversations/c"]),
			);
			expect(batches).toEqual([]);
			expect(countText()).toBe("2 selected");
		});

		it("shows the bin only while a drag is under way", async () => {
			seed([chat("a"), chat("b")]);
			expect(bin()).not.toBeInTheDocument();

			await fireEvent.dragStart(row("a"));
			expect(bin()).toBeInTheDocument();
			expect(bin()).toHaveAttribute("aria-label", "Drop to delete");

			await fireEvent.dragEnd(row("a"));
			await waitFor(() => expect(bin()).not.toBeInTheDocument());
		});

		it("asks before deleting a selection dropped on the bin, and Cancel keeps everything", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("b");
			await pick("c");

			await fireEvent.dragStart(row("b"));
			await dropOn(bin() as HTMLElement);
			await fireEvent.dragEnd(row("b"));

			const dialog = await screen.findByRole("dialog");
			expect(within(dialog).getByText("Delete 3 chats?")).toBeInTheDocument();
			expect(batches).toEqual([]);

			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Cancel" }),
			);

			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			expect(batches).toEqual([]);
			expect(countText()).toBe("3 selected");
			expect(hasRow("a") && hasRow("b") && hasRow("c")).toBe(true);
		});

		it("deletes a selection dropped on the bin in one batch once confirmed", async () => {
			seed([chat("a"), chat("b"), chat("c")]);
			await pick("a");
			await pick("c");

			await fireEvent.dragStart(row("a"));
			await dropOn(bin() as HTMLElement);
			await confirmDelete();

			await waitFor(() => expect(bar()).not.toBeInTheDocument());
			expect(batches).toEqual([{ action: "delete", ids: ["a", "c"] }]);
			expect(hasRow("b")).toBe(true);
		});

		it("asks with the row menu's own dialog before deleting one chat dropped on the bin", async () => {
			seed([chat("a"), chat("b")]);

			await fireEvent.dragStart(row("a"));
			await dropOn(bin() as HTMLElement);

			const dialog = await screen.findByRole("dialog");
			expect(
				within(dialog).getByText("Delete this conversation?"),
			).toBeInTheDocument();
			expect(singleRequests()).toEqual([]);

			await confirmDelete();

			await waitFor(() =>
				expect(singleRequests()).toEqual(["DELETE /api/conversations/a"]),
			);
			expect(batches).toEqual([]);
		});

		it("keeps the chat when the one-chat bin dialog is cancelled", async () => {
			seed([chat("a"), chat("b")]);

			await fireEvent.dragStart(row("a"));
			await dropOn(bin() as HTMLElement);
			const dialog = await screen.findByRole("dialog");
			await fireEvent.click(
				within(dialog).getByRole("button", { name: "Cancel" }),
			);

			await waitFor(() =>
				expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
			);
			expect(singleRequests()).toEqual([]);
			expect(hasRow("a")).toBe(true);
		});
	});
});
