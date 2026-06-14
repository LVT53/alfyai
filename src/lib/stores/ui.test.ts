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
