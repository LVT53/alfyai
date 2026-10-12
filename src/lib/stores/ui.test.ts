import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/environment", () => ({
	browser: true,
}));

async function loadUiStore() {
	vi.resetModules();
	return import("./ui");
}

describe("ui store project folder persistence", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("loads persisted project folder expanded state from localStorage", async () => {
		localStorage.setItem(
			"projectFolderExpanded",
			JSON.stringify({
				"project-1": true,
				"project-2": false,
				malformed: "yes",
			}),
		);

		const { projectFolderExpanded } = await loadUiStore();

		expect(get(projectFolderExpanded)).toEqual({
			"project-1": true,
			"project-2": false,
		});
	});

	it("persists project folder expanded changes to localStorage", async () => {
		const {
			clearProjectFolderExpanded,
			projectFolderExpanded,
			setProjectFolderExpanded,
		} = await loadUiStore();

		setProjectFolderExpanded("project-1", true);
		setProjectFolderExpanded("project-2", false);

		expect(get(projectFolderExpanded)).toEqual({
			"project-1": true,
			"project-2": false,
		});
		expect(
			JSON.parse(localStorage.getItem("projectFolderExpanded") ?? "{}"),
		).toEqual({
			"project-1": true,
			"project-2": false,
		});

		clearProjectFolderExpanded("project-1");

		expect(
			JSON.parse(localStorage.getItem("projectFolderExpanded") ?? "{}"),
		).toEqual({
			"project-2": false,
		});
	});
});

describe("ui store: the document comments rail preference", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("is shown until someone hides it", async () => {
		const { documentCommentsRailHidden } = await loadUiStore();
		expect(get(documentCommentsRailHidden)).toBe(false);
	});

	it("remembers a hidden rail on this device", async () => {
		localStorage.setItem("documentCommentsRailHidden", "true");
		const { documentCommentsRailHidden } = await loadUiStore();
		expect(get(documentCommentsRailHidden)).toBe(true);
	});

	it("persists each change", async () => {
		const { documentCommentsRailHidden } = await loadUiStore();
		documentCommentsRailHidden.set(true);
		expect(localStorage.getItem("documentCommentsRailHidden")).toBe("true");
		documentCommentsRailHidden.set(false);
		expect(localStorage.getItem("documentCommentsRailHidden")).toBe("false");
	});

	it("falls back to shown when the stored value is not a boolean", async () => {
		localStorage.setItem("documentCommentsRailHidden", "maybe");
		const { documentCommentsRailHidden } = await loadUiStore();
		expect(get(documentCommentsRailHidden)).toBe(false);
	});
});

describe("the sidebar folded for a docked panel", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("is not the reader's choice: nothing is stored and the preference is left alone", async () => {
		localStorage.setItem("sidebarCollapsed", "false");
		const { setSidebarFoldNeeded, sidebarCollapsed, sidebarFoldedForPanel } =
			await loadUiStore();

		setSidebarFoldNeeded(true);
		expect(get(sidebarFoldedForPanel)).toBe(true);
		expect(get(sidebarCollapsed)).toBe(false);
		expect(localStorage.getItem("sidebarCollapsed")).toBe("false");

		setSidebarFoldNeeded(false);
		expect(get(sidebarFoldedForPanel)).toBe(false);
		expect(get(sidebarCollapsed)).toBe(false);
	});

	it("opens on the reader's press and stays open until the panel no longer needs the room", async () => {
		const {
			setSidebarFoldNeeded,
			sidebarCollapsed,
			sidebarFoldedForPanel,
			toggleSidebarCollapsed,
		} = await loadUiStore();
		sidebarCollapsed.set(false);

		setSidebarFoldNeeded(true);
		toggleSidebarCollapsed();
		expect(get(sidebarFoldedForPanel)).toBe(false);
		// The page keeps saying the panel needs the room (a resize, a new item): the reader's press stands.
		setSidebarFoldNeeded(true);
		expect(get(sidebarFoldedForPanel)).toBe(false);
		// The panel goes: the next one folds it again.
		setSidebarFoldNeeded(false);
		setSidebarFoldNeeded(true);
		expect(get(sidebarFoldedForPanel)).toBe(true);
	});

	it("opens on the press of a sidebar the reader collapsed, and the panel does not fold it back (FB-9)", async () => {
		const {
			setSidebarFoldNeeded,
			sidebarCollapsed,
			sidebarFoldedForPanel,
			toggleSidebarCollapsed,
		} = await loadUiStore();
		sidebarCollapsed.set(true);

		// A docked panel that would squeeze the chat beside an open sidebar.
		setSidebarFoldNeeded(true);
		toggleSidebarCollapsed();
		expect(get(sidebarCollapsed)).toBe(false);
		expect(get(sidebarFoldedForPanel)).toBe(false);
		// The page keeps saying the panel needs the room: the press stands.
		setSidebarFoldNeeded(true);
		expect(get(sidebarFoldedForPanel)).toBe(false);
		// The panel goes: the sidebar stays as the reader pressed it.
		setSidebarFoldNeeded(false);
		expect(get(sidebarCollapsed)).toBe(false);
		expect(get(sidebarFoldedForPanel)).toBe(false);
		// The next panel that needs the room folds it to its rail again.
		setSidebarFoldNeeded(true);
		expect(get(sidebarFoldedForPanel)).toBe(true);
	});

	it("does not carry a press over to a panel that comes later", async () => {
		const {
			setSidebarFoldNeeded,
			sidebarCollapsed,
			sidebarFoldedForPanel,
			toggleSidebarCollapsed,
		} = await loadUiStore();
		sidebarCollapsed.set(true);

		// No panel: the press is only the reader's preference.
		setSidebarFoldNeeded(false);
		toggleSidebarCollapsed();
		expect(get(sidebarCollapsed)).toBe(false);
		// A panel that needs the room opens afterwards: the sidebar folds for it.
		setSidebarFoldNeeded(true);
		expect(get(sidebarFoldedForPanel)).toBe(true);
	});

	it("toggles the reader's preference when nothing is folded", async () => {
		const { sidebarCollapsed, toggleSidebarCollapsed } = await loadUiStore();
		sidebarCollapsed.set(true);
		toggleSidebarCollapsed();
		expect(get(sidebarCollapsed)).toBe(false);
		toggleSidebarCollapsed();
		expect(get(sidebarCollapsed)).toBe(true);
	});
});
