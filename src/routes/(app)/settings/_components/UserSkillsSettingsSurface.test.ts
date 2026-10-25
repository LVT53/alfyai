import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserSkillsSettingsSurface from "./UserSkillsSettingsSurface.svelte";

vi.mock("$lib/client/api/skills", () => ({
	createUserSkill: vi.fn(),
	createUserSkillVariant: vi.fn(),
	deleteUserSkill: vi.fn(),
	deleteUserSkillVariant: vi.fn(),
	fetchSystemSkillSummaries: vi.fn(),
	fetchUserSkills: vi.fn(),
	fetchUserSkillVariants: vi.fn(),
	updateUserSkill: vi.fn(),
	updateUserSkillVariant: vi.fn(),
}));

import {
	createUserSkill,
	createUserSkillVariant,
	deleteUserSkill,
	deleteUserSkillVariant,
	fetchSystemSkillSummaries,
	fetchUserSkills,
	fetchUserSkillVariants,
	updateUserSkill,
	updateUserSkillVariant,
} from "$lib/client/api/skills";

const mockCreateUserSkill = createUserSkill as ReturnType<typeof vi.fn>;
const mockCreateUserSkillVariant = createUserSkillVariant as ReturnType<
	typeof vi.fn
>;
const mockDeleteUserSkill = deleteUserSkill as ReturnType<typeof vi.fn>;
const mockDeleteUserSkillVariant = deleteUserSkillVariant as ReturnType<
	typeof vi.fn
>;
const mockFetchSystemSkillSummaries = fetchSystemSkillSummaries as ReturnType<
	typeof vi.fn
>;
const mockFetchUserSkills = fetchUserSkills as ReturnType<typeof vi.fn>;
const mockFetchUserSkillVariants = fetchUserSkillVariants as ReturnType<
	typeof vi.fn
>;
const mockUpdateUserSkill = updateUserSkill as ReturnType<typeof vi.fn>;
const mockUpdateUserSkillVariant = updateUserSkillVariant as ReturnType<
	typeof vi.fn
>;

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
		vi.stubGlobal(
			"confirm",
			vi.fn(() => true),
		);
		mockFetchUserSkillVariants.mockResolvedValue([]);
		mockFetchSystemSkillSummaries.mockResolvedValue([]);
	});

	it("shows loading and empty states, then validates required fields", async () => {
		mockFetchUserSkills.mockResolvedValue([]);

		render(UserSkillsSettingsSurface, { skillsEnabled: true });

		expect(screen.getByText("Loading skills...")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByText("No private skills yet.")).toBeInTheDocument(),
		);

		await fireEvent.click(screen.getByRole("button", { name: "Save skill" }));

		expect(screen.getByText("Display name is required.")).toBeInTheDocument();
		expect(mockCreateUserSkill).not.toHaveBeenCalled();
	});

	it("opens the skill the address names, the one a chat draft was saved as", async () => {
		mockFetchUserSkills.mockResolvedValue([existingSkill]);
		window.history.replaceState(
			{},
			"",
			"/settings?section=skills&skill=skill-1",
		);
		try {
			render(UserSkillsSettingsSurface);

			await waitFor(() =>
				expect(screen.getByLabelText("Display name")).toHaveValue(
					"Meeting critic",
				),
			);
			expect(screen.getByLabelText("Instructions")).toHaveValue(
				"Review notes.",
			);
		} finally {
			window.history.replaceState({}, "", "/");
		}
	});

	it("starts on a blank skill when the named skill is not one of the person's", async () => {
		mockFetchUserSkills.mockResolvedValue([existingSkill]);
		window.history.replaceState(
			{},
			"",
			"/settings?section=skills&skill=someone-else",
		);
		try {
			render(UserSkillsSettingsSurface);

			await waitFor(() =>
				expect(screen.getByText("Meeting critic")).toBeInTheDocument(),
			);
			expect(screen.getByLabelText("Display name")).toHaveValue("");
		} finally {
			window.history.replaceState({}, "", "/");
		}
	});

	it("hides skill creation controls when skills are disabled", () => {
		render(UserSkillsSettingsSurface, { skillsEnabled: false });

		expect(
			screen.getByText("Skills are disabled by your workspace administrator."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "New skill" })).toBeNull();
		expect(screen.queryByRole("button", { name: "New variant" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save skill" })).toBeNull();
		expect(mockFetchUserSkills).not.toHaveBeenCalled();
		expect(mockFetchUserSkillVariants).not.toHaveBeenCalled();
		expect(mockFetchSystemSkillSummaries).not.toHaveBeenCalled();
	});

	it("switches skill type without discarding unsaved draft fields", async () => {
		mockFetchUserSkills.mockResolvedValue([]);
		mockFetchSystemSkillSummaries.mockResolvedValue([
			{
				id: "system:research",
				ownership: "system",
				skillKind: "skill_pack",
				displayName: "Research Pack",
				description: "Grounds answers.",
				activationExamples: [],
				enabled: true,
				published: true,
				durationPolicy: "session",
				questionPolicy: "ask_when_needed",
				notesPolicy: "create_private_notes",
				sourceScope: "selected_sources_only",
				creationSource: "system_seed",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);

		render(UserSkillsSettingsSurface, { skillsEnabled: true });
		await waitFor(() =>
			expect(screen.getByText("No private skills yet.")).toBeInTheDocument(),
		);

		await fireEvent.input(screen.getByLabelText("Display name"), {
			target: { value: "Quarterly ratio helper" },
		});
		await fireEvent.input(screen.getByLabelText("Instructions"), {
			target: { value: "Use the current worksheet layout." },
		});
		await fireEvent.input(screen.getByLabelText("Activation examples"), {
			target: { value: "update daily ratios" },
		});

		const userSkillButton = screen.getByRole("button", { name: "User Skill" });
		const variantButton = screen.getByRole("button", { name: "Skill Variant" });
		expect(userSkillButton).toHaveAttribute("aria-pressed", "true");
		expect(variantButton).toHaveAttribute("aria-pressed", "false");

		await fireEvent.click(variantButton);

		expect(variantButton).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByLabelText("Display name")).toHaveValue(
			"Quarterly ratio helper",
		);
		expect(screen.getByLabelText("Variant overlay guidance")).toHaveValue(
			"Use the current worksheet layout.",
		);
		expect(screen.getByLabelText("Activation examples")).toHaveValue(
			"update daily ratios",
		);

		await fireEvent.click(userSkillButton);

		expect(userSkillButton).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByLabelText("Display name")).toHaveValue(
			"Quarterly ratio helper",
		);
		expect(screen.getByLabelText("Instructions")).toHaveValue(
			"Use the current worksheet layout.",
		);
		expect(screen.getByLabelText("Activation examples")).toHaveValue(
			"update daily ratios",
		);
	});

	it("warns on duplicate names but still creates, updates, disables, and deletes", async () => {
		mockFetchUserSkills.mockResolvedValue([existingSkill]);
		mockCreateUserSkill.mockResolvedValue({
			...existingSkill,
			id: "skill-2",
			displayName: "Meeting critic",
		});
		mockUpdateUserSkill.mockResolvedValue({
			...existingSkill,
			enabled: false,
			version: 2,
		});
		mockDeleteUserSkill.mockResolvedValue(undefined);

		render(UserSkillsSettingsSurface, { skillsEnabled: true });
		await waitFor(() =>
			expect(screen.getByText("Meeting critic")).toBeInTheDocument(),
		);

		await fireEvent.input(screen.getByLabelText("Display name"), {
			target: { value: "Meeting critic" },
		});
		await fireEvent.input(screen.getByLabelText("Instructions"), {
			target: { value: "Review notes with stricter criteria." },
		});

		expect(
			screen.getByText("A skill with this display name already exists."),
		).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
		expect(mockCreateUserSkill).toHaveBeenCalledWith(
			expect.objectContaining({
				displayName: "Meeting critic",
				instructions: "Review notes with stricter criteria.",
			}),
		);

		await fireEvent.click(
			screen.getAllByRole("button", { name: "Edit Meeting critic" })[0],
		);
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Disable Meeting critic" })[0],
		);
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Delete Meeting critic" })[0],
		);

		expect(mockUpdateUserSkill).toHaveBeenCalledWith("skill-2", {
			enabled: false,
		});
		expect(mockDeleteUserSkill).toHaveBeenCalledWith("skill-2");
	});

	it("creates, edits, disables, and deletes a Skill Variant from an available pack", async () => {
		mockFetchUserSkills.mockResolvedValue([]);
		mockFetchUserSkillVariants.mockResolvedValue([]);
		mockFetchSystemSkillSummaries.mockResolvedValue([
			{
				id: "system:research",
				ownership: "system",
				skillKind: "skill_pack",
				displayName: "Research Pack",
				description: "Grounds answers.",
				activationExamples: [],
				enabled: true,
				published: true,
				durationPolicy: "session",
				questionPolicy: "ask_when_needed",
				notesPolicy: "create_private_notes",
				sourceScope: "selected_sources_only",
				creationSource: "system_seed",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		const savedVariant = {
			id: "variant-1",
			ownership: "user",
			skillKind: "skill_variant",
			baseSkillId: "system:research",
			baseSkillVersion: 1,
			baseSkillDisplayName: "Research Pack",
			baseSkillAvailable: true,
			baseSkillAvailabilityReason: "available",
			displayName: "Research Pack, terse",
			description: "Board style.",
			instructions: "Use terse bullets.",
			activationExamples: [],
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
		mockCreateUserSkillVariant.mockResolvedValue(savedVariant);
		mockUpdateUserSkillVariant.mockResolvedValue({
			...savedVariant,
			enabled: false,
			version: 2,
		});
		mockDeleteUserSkillVariant.mockResolvedValue(undefined);

		render(UserSkillsSettingsSurface, { skillsEnabled: true });
		await waitFor(() =>
			expect(screen.getByText("No private skills yet.")).toBeInTheDocument(),
		);

		await fireEvent.click(screen.getByRole("button", { name: "New variant" }));
		await fireEvent.change(screen.getByLabelText("Skill Pack"), {
			target: { value: "system:research" },
		});
		await fireEvent.input(screen.getByLabelText("Display name"), {
			target: { value: "Research Pack, terse" },
		});
		await fireEvent.input(screen.getByLabelText("Variant overlay guidance"), {
			target: { value: "Use terse bullets." },
		});
		expect(
			screen.getByText(/Policy controls are inherited/),
		).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
		expect(mockCreateUserSkillVariant).toHaveBeenCalledWith(
			expect.objectContaining({
				baseSkillId: "system:research",
				displayName: "Research Pack, terse",
				instructions: "Use terse bullets.",
			}),
		);
		expect(mockCreateUserSkill).not.toHaveBeenCalled();

		await waitFor(() =>
			expect(screen.getByText("Based on Research Pack")).toBeInTheDocument(),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Edit Research Pack, terse" }),
		);
		expect(screen.getByLabelText("Variant overlay guidance")).toHaveValue(
			"Use terse bullets.",
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Disable Research Pack, terse" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Delete Research Pack, terse" }),
		);

		expect(mockUpdateUserSkillVariant).toHaveBeenCalledWith("variant-1", {
			enabled: false,
		});
		expect(mockDeleteUserSkillVariant).toHaveBeenCalledWith("variant-1");
	});
});
