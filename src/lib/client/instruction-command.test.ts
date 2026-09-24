import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/client/api/settings", () => ({
	fetchUserSettings: vi.fn(),
	updateUserPreferences: vi.fn(),
}));

vi.mock("$lib/client/api/projects", () => ({
	fetchProject: vi.fn(),
	saveProjectInstructions: vi.fn(),
}));

import { ApiError } from "$lib/client/api/http";
import {
	fetchProject,
	saveProjectInstructions,
} from "$lib/client/api/projects";
import {
	fetchUserSettings,
	updateUserPreferences,
} from "$lib/client/api/settings";
import {
	loadInstructionDialogSeed,
	saveInstructionScope,
} from "./instruction-command";

const mockFetchUserSettings = fetchUserSettings as ReturnType<typeof vi.fn>;
const mockFetchProject = fetchProject as ReturnType<typeof vi.fn>;
const mockSaveProjectInstructions = saveProjectInstructions as ReturnType<
	typeof vi.fn
>;
const mockUpdateUserPreferences = updateUserPreferences as ReturnType<
	typeof vi.fn
>;

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchUserSettings.mockResolvedValue({
		preferences: { personalInstructions: "Be brief." },
	});
	mockFetchProject.mockResolvedValue({
		id: "project-1",
		name: "Trains",
		instructions: "Only suggest trains.",
	});
});

describe("loadInstructionDialogSeed", () => {
	// Outside a project there is nothing to switch to, and the dialog draws no
	// switch for a single scope — so the project read must not even happen.
	it("offers the personal scope alone outside a project", async () => {
		const seed = await loadInstructionDialogSeed(null);

		expect(seed.scope).toEqual({ kind: "personal" });
		expect(seed.scopes).toEqual([{ kind: "personal" }]);
		expect(seed.initialText).toEqual({ personal: "Be brief." });
		expect(mockFetchProject).not.toHaveBeenCalled();
	});

	// The scope on screen is the project's, and the name rides along: a
	// `ScopeToken` for a project without one renders an icon and no text.
	it("opens on the project scope, named, with the other scope already loaded", async () => {
		const seed = await loadInstructionDialogSeed("project-1");

		expect(seed.scope).toEqual({
			kind: "project",
			projectId: "project-1",
			name: "Trains",
		});
		expect(seed.scopes.map((scope) => scope.kind)).toEqual([
			"project",
			"personal",
		]);
		expect(seed.initialText).toEqual({
			"project:project-1": "Only suggest trains.",
			personal: "Be brief.",
		});
	});

	it("starts an unset scope at empty text rather than undefined", async () => {
		mockFetchUserSettings.mockResolvedValue({
			preferences: { personalInstructions: null },
		});
		mockFetchProject.mockResolvedValue({
			id: "project-1",
			name: "Trains",
			instructions: null,
		});

		const seed = await loadInstructionDialogSeed("project-1");

		expect(seed.initialText).toEqual({
			"project:project-1": "",
			personal: "",
		});
	});

	// Opening an empty editor over saved text would let Save write the appended
	// line over it, so a failed read must reach the caller instead of being
	// papered over with blanks.
	it("propagates a failed read instead of opening on blanks", async () => {
		mockFetchProject.mockRejectedValue(new Error("offline"));

		await expect(loadInstructionDialogSeed("project-1")).rejects.toThrow(
			"offline",
		);
	});
});

describe("saveInstructionScope", () => {
	it("writes the personal scope through the preferences route", async () => {
		const result = await saveInstructionScope(
			{ kind: "personal" },
			"Be brief.",
		);

		expect(result).toEqual({ ok: true });
		expect(mockUpdateUserPreferences).toHaveBeenCalledWith({
			personalInstructions: "Be brief.",
		});
		expect(mockSaveProjectInstructions).not.toHaveBeenCalled();
	});

	it("writes the project scope through the project route", async () => {
		const result = await saveInstructionScope(
			{ kind: "project", projectId: "project-1", name: "Trains" },
			"Only suggest trains.",
		);

		expect(result).toEqual({ ok: true });
		expect(mockSaveProjectInstructions).toHaveBeenCalledWith(
			"project-1",
			"Only suggest trains.",
		);
		expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
	});

	it("reports a generic failure without closing the dialog's own message", async () => {
		mockUpdateUserPreferences.mockRejectedValue(new Error("500"));

		const result = await saveInstructionScope({ kind: "personal" }, "hi");

		expect(result).toEqual({ ok: false, missing: false });
	});

	// The one failure a surface names itself: the project was deleted while the
	// dialog was open, so "could not save the instructions" would be misdirection.
	it("marks a 404 as a missing project", async () => {
		mockSaveProjectInstructions.mockRejectedValue(
			new ApiError("Project not found", { status: 404 }),
		);

		const result = await saveInstructionScope(
			{ kind: "project", projectId: "project-1" },
			"hi",
		);

		expect(result).toEqual({ ok: false, missing: true });
	});
});
