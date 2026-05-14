import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserSkillsSettingsSurface from "./UserSkillsSettingsSurface.svelte";

vi.mock("$lib/client/api/skills", () => ({
	createUserSkill: vi.fn(),
	deleteUserSkill: vi.fn(),
	fetchUserSkills: vi.fn(),
	updateUserSkill: vi.fn(),
}));

import {
	createUserSkill,
	deleteUserSkill,
	fetchUserSkills,
	updateUserSkill,
} from "$lib/client/api/skills";

const mockCreateUserSkill = createUserSkill as ReturnType<typeof vi.fn>;
const mockDeleteUserSkill = deleteUserSkill as ReturnType<typeof vi.fn>;
const mockFetchUserSkills = fetchUserSkills as ReturnType<typeof vi.fn>;
const mockUpdateUserSkill = updateUserSkill as ReturnType<typeof vi.fn>;

const existingSkill = {
	id: "skill-1",
	ownership: "user",
	displayName: "Meeting critic",
	description: "Reviews meeting notes.",
	instructions: "Review notes.",
	activationExamples: ["review these notes"],
	enabled: true,
	durationPolicy: "next_message",
	questionPolicy: "none",
	notesPolicy: "none",
	sourceScope: "current_conversation",
	creationSource: "user_created",
	version: 1,
	createdAt: 1,
	updatedAt: 1,
};

describe("UserSkillsSettingsSurface", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("confirm", vi.fn(() => true));
	});

	it("shows loading and empty states, then validates required fields", async () => {
		mockFetchUserSkills.mockResolvedValue([]);

		render(UserSkillsSettingsSurface, { skillsEnabled: true });

		expect(screen.getByText("Loading skills...")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByText("No private skills yet.")).toBeInTheDocument());

		await fireEvent.click(screen.getByRole("button", { name: "Save skill" }));

		expect(screen.getByText("Display name is required.")).toBeInTheDocument();
		expect(mockCreateUserSkill).not.toHaveBeenCalled();
	});

	it("warns on duplicate names but still creates, updates, disables, and deletes", async () => {
		mockFetchUserSkills.mockResolvedValue([existingSkill]);
		mockCreateUserSkill.mockResolvedValue({
			...existingSkill,
			id: "skill-2",
			displayName: "Meeting critic",
		});
		mockUpdateUserSkill.mockResolvedValue({ ...existingSkill, enabled: false, version: 2 });
		mockDeleteUserSkill.mockResolvedValue(undefined);

		render(UserSkillsSettingsSurface, { skillsEnabled: true });
		await waitFor(() => expect(screen.getByText("Meeting critic")).toBeInTheDocument());

		await fireEvent.input(screen.getByLabelText("Display name"), {
			target: { value: "Meeting critic" },
		});
		await fireEvent.input(screen.getByLabelText("Instructions"), {
			target: { value: "Review notes with stricter criteria." },
		});

		expect(screen.getByText("A skill with this display name already exists.")).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
		expect(mockCreateUserSkill).toHaveBeenCalledWith(
			expect.objectContaining({
				displayName: "Meeting critic",
				instructions: "Review notes with stricter criteria.",
			}),
		);

		await fireEvent.click(screen.getAllByRole("button", { name: "Edit Meeting critic" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "Disable Meeting critic" })[0]);
		await fireEvent.click(screen.getAllByRole("button", { name: "Delete Meeting critic" })[0]);

		expect(mockUpdateUserSkill).toHaveBeenCalledWith("skill-2", { enabled: false });
		expect(mockDeleteUserSkill).toHaveBeenCalledWith("skill-2");
	});
});
