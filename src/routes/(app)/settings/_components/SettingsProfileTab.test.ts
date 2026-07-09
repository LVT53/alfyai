import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import type { ModelId } from "$lib/types";
import SettingsProfileTab from "./SettingsProfileTab.svelte";

vi.mock("chart.js/auto", () => {
	class Chart {
		static getChart = vi.fn(() => null);
		destroy = vi.fn();
	}
	return { Chart };
});

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
	fetchSystemSkillSummaries,
	fetchUserSkills,
	fetchUserSkillVariants,
} from "$lib/client/api/skills";

const mockFetchUserSkills = fetchUserSkills as ReturnType<typeof vi.fn>;
const mockFetchUserSkillVariants = fetchUserSkillVariants as ReturnType<
	typeof vi.fn
>;
const mockFetchSystemSkillSummaries = fetchSystemSkillSummaries as ReturnType<
	typeof vi.fn
>;

const baseProps = {
	userId: "user-1",
	userDisplayName: "User",
	userEmail: "user@example.com",
	avatarColors: ["#000000"] as string[],
	avatarCount: 1,
	selectedAvatar: 1,
	showAvatarPicker: false,
	onOpenPictureEditor: vi.fn(),
	onRemovePhoto: vi.fn(),
	onSelectAvatar: vi.fn(),
	name: "User",
	email: "user@example.com",
	onSaveProfile: vi.fn(),
	currentPassword: "",
	newPassword: "",
	confirmPassword: "",
	showCurrentPw: false,
	showNewPw: false,
	showConfirmPw: false,
	onSavePassword: vi.fn(),
	availableModels: [
		{ id: "model1" as ModelId, displayName: "Model 1" },
		{ id: "model2" as ModelId, displayName: "Model 2" },
	],
	selectedTheme: "system" as const,
	selectedTitleLanguage: "auto" as const,
	selectedUiLanguage: "en" as const,
	onChangeTheme: vi.fn(),
	onChangeTitleLanguage: vi.fn(),
	onChangeUiLanguage: vi.fn(),
	onOpenDownloadArchive: vi.fn(),
	onOpenClearMemory: vi.fn(),
	onOpenClearWorkspace: vi.fn(),
	onOpenDeleteModal: vi.fn(),
};

const renderTab = (overrides: Record<string, unknown> = {}) =>
	render(SettingsProfileTab, {
		...baseProps,
		selectedModel: null,
		effectiveModel: "model1",
		systemDefaultModel: "model1",
		onChangeModel: vi.fn(),
		skillsEnabled: true,
		...overrides,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchUserSkills.mockResolvedValue([]);
	mockFetchUserSkillVariants.mockResolvedValue([]);
	mockFetchSystemSkillSummaries.mockResolvedValue([]);
});

describe("SettingsProfileTab grouped sections (ADR-0043 slice 18a)", () => {
	it("renders the 4 grouped section labels in order", () => {
		renderTab();

		const account = screen.getByText("Account");
		const preferences = screen.getByText("Preferences");
		const assistant = screen.getByText("Assistant");
		const dataPrivacy = screen.getByText("Data & privacy");

		// All present.
		expect(account).toBeInTheDocument();
		expect(preferences).toBeInTheDocument();
		expect(assistant).toBeInTheDocument();
		expect(dataPrivacy).toBeInTheDocument();

		// In order: Account < Preferences < Assistant < Data & privacy.
		expect(
			account.compareDocumentPosition(preferences) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			preferences.compareDocumentPosition(assistant) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			assistant.compareDocumentPosition(dataPrivacy) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("preserves EVERY existing field across the 4 sections (no field dropped)", () => {
		renderTab({
			profilePicture: "https://example.com/p.png",
			// Conversation style only renders when personality profiles exist
			// (same conditional as the original "Default style" selector).
			personalityProfiles: [
				{ id: "p1", name: "Concise", description: "Short" },
			],
		});

		// Account: avatar controls + display name + email + password fields + import.
		expect(screen.getByLabelText("Upload photo")).toBeInTheDocument();
		expect(screen.getByLabelText("Change color")).toBeInTheDocument();
		expect(screen.getByLabelText("Remove photo")).toBeInTheDocument();
		expect(
			screen.getByRole("textbox", { name: "Display Name" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("textbox", { name: "Email Address" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Current password")).toBeInTheDocument();
		expect(screen.getByLabelText("New password")).toBeInTheDocument();
		expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
		expect(screen.getByText("Data & Import")).toBeInTheDocument();

		// Preferences: default model + conversation style + theme + languages.
		expect(screen.getByText("Default model")).toBeInTheDocument();
		expect(screen.getByText("Conversation style")).toBeInTheDocument();
		expect(screen.getByText("Appearance")).toBeInTheDocument();
		expect(screen.getByText("Interface language")).toBeInTheDocument();

		// Assistant: Skills summary card present (18b: inline editor promoted to
		// a summary card that opens the full-screen manager).
		expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();

		// Data & privacy: privacy policy entry row + all 4 destructive/export actions.
		expect(screen.getByText("Privacy policy")).toBeInTheDocument();
		expect(screen.getByText("Download my data")).toBeInTheDocument();
		expect(screen.getByText("Clear memory and knowledge")).toBeInTheDocument();
		expect(screen.getByText("Clear workspace data")).toBeInTheDocument();
		expect(screen.getByText("Delete account")).toBeInTheDocument();
	});

	it("renames 'Default Style' to 'Conversation style' with a clarifying note (jargon cleared)", () => {
		renderTab({
			personalityProfiles: [{ id: "p1", name: "Concise", description: "" }],
		});

		expect(screen.getByText("Conversation style")).toBeInTheDocument();
		// "Default Style" is gone.
		expect(screen.queryByText("Default style")).not.toBeInTheDocument();
		expect(screen.queryByText("Default Style")).not.toBeInTheDocument();
		// A clarifying note is present.
		expect(
			screen.getByText(/How AlfyAI responds by default/),
		).toBeInTheDocument();
	});

	it("converts avatar CTAs to btn-icon-bare Lucide icon buttons", () => {
		renderTab({ profilePicture: "https://example.com/p.png" });

		const upload = screen.getByLabelText("Upload photo");
		const color = screen.getByLabelText("Change color");
		const remove = screen.getByLabelText("Remove photo");

		for (const btn of [upload, color, remove]) {
			expect(btn).toHaveClass("btn-icon-bare");
			// Lucide svg present.
			expect(btn.querySelector("svg")).toBeInTheDocument();
		}
	});

	it("fires avatar icon-button callbacks", async () => {
		const onOpenPictureEditor = vi.fn();
		const onRemovePhoto = vi.fn();
		renderTab({
			onOpenPictureEditor,
			onRemovePhoto,
			profilePicture: "https://example.com/p.png",
		});

		await fireEvent.click(screen.getByLabelText("Upload photo"));
		expect(onOpenPictureEditor).toHaveBeenCalledOnce();

		await fireEvent.click(screen.getByLabelText("Remove photo"));
		expect(onRemovePhoto).toHaveBeenCalledOnce();
	});

	it("converts data & privacy CTAs to btn-icon-bare Lucide icon buttons (Download/Trash2)", async () => {
		const onOpenDownloadArchive = vi.fn();
		const onOpenClearMemory = vi.fn();
		const onOpenClearWorkspace = vi.fn();
		const onOpenDeleteModal = vi.fn();
		renderTab({
			onOpenDownloadArchive,
			onOpenClearMemory,
			onOpenClearWorkspace,
			onOpenDeleteModal,
		});

		const download = screen.getByLabelText("Download my data");
		const clearMemory = screen.getByLabelText("Clear memory and knowledge");
		const clearWorkspace = screen.getByLabelText("Clear workspace data");
		const del = screen.getByLabelText("Delete account");

		// The three quiet actions are btn-icon-bare Lucide icon buttons.
		for (const btn of [download, clearMemory, clearWorkspace]) {
			expect(btn).toHaveClass("btn-icon-bare");
			expect(btn.querySelector("svg")).toBeInTheDocument();
		}
		// Delete is the destructive action: a Lucide icon, but NOT a quiet icon button
		// (it gets the solid red CTA treatment — asserted in its own test).
		expect(del.querySelector("svg")).toBeInTheDocument();

		await fireEvent.click(download);
		await fireEvent.click(clearMemory);
		await fireEvent.click(clearWorkspace);
		await fireEvent.click(del);

		expect(onOpenDownloadArchive).toHaveBeenCalledOnce();
		expect(onOpenClearMemory).toHaveBeenCalledOnce();
		expect(onOpenClearWorkspace).toHaveBeenCalledOnce();
		expect(onOpenDeleteModal).toHaveBeenCalledOnce();
	});

	it("distinguishes account deletion with a solid red destructive CTA", () => {
		renderTab();

		const del = screen.getByLabelText("Delete account");
		// Solid red destructive button (btn-danger), not a quiet icon button.
		expect(del).toHaveClass("btn-danger");
		expect(del).not.toHaveClass("btn-icon-bare");
		// Lucide trash icon present.
		expect(del.querySelector("svg")).toBeInTheDocument();
	});

	it("shows a Privacy policy entry row under Data & privacy that links straight to the public /privacy route (ADR 0044 Decision 5 — no in-app modal)", () => {
		renderTab();

		const row = screen.getByLabelText("Privacy policy");
		expect(row.tagName).toBe("A");
		expect(row).toHaveAttribute("href", "/privacy");
		expect(row).toHaveClass("btn-icon-bare");
		expect(row.querySelector("svg")).toBeInTheDocument();
	});

	it("removes the old standalone Preferences section title and standalone section cards", () => {
		renderTab();

		// The old standalone "Privacy and Data Controls" heading is gone (now grouped under Data & privacy).
		expect(
			screen.queryByRole("heading", { name: "Privacy and Data Controls" }),
		).not.toBeInTheDocument();
		// No legacy "Danger Zone".
		expect(screen.queryByText("Danger Zone")).not.toBeInTheDocument();
	});
});

describe("SettingsProfileTab model preference", () => {
	it("shows System default first with the resolved model and emits null for inheritance", async () => {
		const onChangeModel = vi.fn();

		render(SettingsProfileTab, {
			...baseProps,
			selectedModel: null,
			effectiveModel: "model2",
			systemDefaultModel: "model2",
			onChangeModel,
		});

		const buttons = screen.getAllByRole("button");
		const systemDefault = screen.getByRole("button", {
			name: /System default: Model 2/,
		});

		expect(buttons.indexOf(systemDefault)).toBeLessThan(
			buttons.indexOf(screen.getByRole("button", { name: "Model 1" })),
		);
		expect(screen.queryByRole("button", { name: "Model 2" })).toBeNull();

		await fireEvent.click(systemDefault);

		expect(onChangeModel).toHaveBeenCalledWith(null);
	});

	it("keeps the admin system default distinct from an explicit user override", async () => {
		const onChangeModel = vi.fn();

		render(SettingsProfileTab, {
			...baseProps,
			selectedModel: "model2",
			effectiveModel: "model2",
			systemDefaultModel: "model1",
			onChangeModel,
		});

		const systemDefault = screen.getByRole("button", {
			name: /System default: Model 1/,
		});

		expect(systemDefault).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Model 2" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Model 1" })).toBeNull();

		await fireEvent.click(systemDefault);

		expect(onChangeModel).toHaveBeenCalledWith(null);
	});

	it("renders many model choices in a shrink-safe responsive grid", () => {
		const availableModels: Array<{ id: ModelId; displayName: string }> = [
			{ id: "model1" as ModelId, displayName: "Model 1" },
			...Array.from({ length: 12 }, (_, index) => ({
				id: `provider:test-provider:model-${index}` as ModelId,
				displayName: `Provider Model With A Long Display Name ${index + 1}`,
			})),
		];

		const { container } = render(SettingsProfileTab, {
			...baseProps,
			availableModels,
			selectedModel: null,
			effectiveModel: "model1",
			systemDefaultModel: "model1",
			onChangeModel: vi.fn(),
		});

		const grid = container.querySelector<HTMLElement>(
			'[data-testid="settings-default-model-grid"]',
		);
		expect(grid).toBeInTheDocument();
		expect(grid).toHaveClass("model-preference-grid");

		if (!grid) throw new Error("Expected default model grid to render.");

		const buttons = within(grid).getAllByRole("button");
		expect(buttons).toHaveLength(availableModels.length);
		for (const button of buttons) {
			expect(button).toHaveClass("model-preference-pill");
			expect(
				button.querySelector(".model-preference-pill-label"),
			).toBeInTheDocument();
		}
	});
});

describe("SettingsProfileTab Skills summary card + manager (ADR-0043 slice 18b)", () => {
	it("shows a Skills SUMMARY CARD (not the inline editor) with a ChevronRight affordance", () => {
		renderTab();

		// The summary card is a single button labelled "Skills ...".
		const summary = screen.getByRole("button", { name: /Skills/ });
		expect(summary).toBeInTheDocument();

		// The inline editor (Skills title / Save skill form) is NOT rendered by default.
		expect(screen.queryByText("Private skills")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Save skill" }),
		).not.toBeInTheDocument();
	});

	it("the summary card carries a Lucide ChevronRight open affordance", () => {
		renderTab();

		const summary = screen.getByRole("button", { name: /Skills/ });
		expect(summary.querySelector("svg")).toBeInTheDocument();
	});

	it("clicking the summary card opens the full-screen manager (UserSkillsSettingsSurface re-homed)", async () => {
		renderTab();

		await fireEvent.click(screen.getByRole("button", { name: /Skills/ }));

		// The re-homed Skills surface (its title + new-skill CTAs) now renders in the manager.
		await waitFor(() =>
			expect(screen.getByText("Private skills")).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: "New skill" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "New variant" }),
		).toBeInTheDocument();
	});

	it("the manager has a back chevron (ChevronLeft) that returns to the Profile summary", async () => {
		renderTab();

		await fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
		await waitFor(() =>
			expect(screen.getByText("Private skills")).toBeInTheDocument(),
		);

		// Back button present.
		const back = screen.getByRole("button", { name: /Back/ });
		expect(back.querySelector("svg")).toBeInTheDocument();

		await fireEvent.click(back);

		// Manager gone; summary card back.
		expect(screen.queryByText("Private skills")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Skills/ })).toBeInTheDocument();
	});

	it("shows disabled message on the summary card when skills are disabled", () => {
		renderTab({ skillsEnabled: false });

		// When disabled, the summary reflects the disabled state (no open into editor).
		expect(
			screen.getByText("Skills are disabled by your workspace administrator."),
		).toBeInTheDocument();
		// No open affordance into a disabled manager.
		expect(
			screen.queryByRole("button", { name: /Skills/ }),
		).not.toBeInTheDocument();
	});

	it("derives the active/disabled counts from the skills data on the summary card", async () => {
		mockFetchUserSkills.mockResolvedValue([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Active skill",
				description: "",
				instructions: "",
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
			},
			{
				id: "skill-2",
				ownership: "user",
				displayName: "Disabled skill",
				description: "",
				instructions: "",
				activationExamples: [],
				enabled: false,
				durationPolicy: "next_message",
				questionPolicy: "none",
				notesPolicy: "none",
				sourceScope: "current_conversation",
				creationSource: "user_created",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		]);

		renderTab();

		// Summary card shows "1 active · 1 disabled".
		await waitFor(() =>
			expect(screen.getByText(/1 active/)).toBeInTheDocument(),
		);
		expect(screen.getByText(/1 disabled/)).toBeInTheDocument();
	});
});

describe("SettingsProfileTab Your Activity section (ADR-0043 slice 18c)", () => {
	const personalAnalyticsData: AnalyticsResponse = {
		availableMonths: ["2026-06"],
		personal: {
			byModel: [],
			byProvider: [],
			totalMessages: 42,
			avgGenerationMs: 1200,
			totalTokens: 1500,
			promptTokens: 1000,
			cachedInputTokens: 0,
			outputTokens: 500,
			reasoningTokens: 0,
			totalCostUsd: 3.14,
			favoriteModel: "model1",
			chatCount: 7,
		},
	};

	it("renders the 5th 'Your Activity' section label after Data & privacy", () => {
		renderTab({ personalAnalyticsData });

		const account = screen.getByText("Account");
		const dataPrivacy = screen.getByText("Data & privacy");
		const yourActivity = screen.getByText("Your Activity");

		expect(yourActivity).toBeInTheDocument();
		// In order: Data & privacy < Your Activity.
		expect(
			dataPrivacy.compareDocumentPosition(yourActivity) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// And the section is the last group (after Data & privacy, which is the 4th).
		expect(
			account.compareDocumentPosition(yourActivity) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders the personal analytics content inside Your Activity", () => {
		renderTab({ personalAnalyticsData });

		// Personal usage stats render (the re-homed personal Block A content).
		expect(screen.getByText("Messages sent")).toBeInTheDocument();
		expect(screen.getByText("Tokens used")).toBeInTheDocument();
		expect(screen.getByText("Conversations")).toBeInTheDocument();
	});

	it("still renders all 4 prior section labels alongside the new 5th section", () => {
		renderTab({ personalAnalyticsData });

		expect(screen.getByText("Account")).toBeInTheDocument();
		expect(screen.getByText("Preferences")).toBeInTheDocument();
		expect(screen.getByText("Assistant")).toBeInTheDocument();
		expect(screen.getByText("Data & privacy")).toBeInTheDocument();
		expect(screen.getByText("Your Activity")).toBeInTheDocument();
	});

	it("does NOT render system-level analytics in the Profile Your Activity section", () => {
		renderTab({ personalAnalyticsData });

		// System-only sections must stay out of the normal-user Profile section.
		expect(screen.queryByText("System Overview")).not.toBeInTheDocument();
		expect(screen.queryByText("Per-User Breakdown")).not.toBeInTheDocument();
		expect(screen.queryByText("Excluded Users")).not.toBeInTheDocument();
	});
});

describe("SettingsProfileTab memory toggle", () => {
	it("reflects the enabled state and toggles it off via the callback", async () => {
		const onChangeMemoryEnabled = vi.fn();
		render(SettingsProfileTab, {
			...baseProps,
			selectedModel: null,
			effectiveModel: "model1",
			systemDefaultModel: "model1",
			onChangeModel: vi.fn(),
			memoryEnabled: true,
			onChangeMemoryEnabled,
		});

		const toggle = screen.getByRole("switch", { name: "Memory" });
		expect(toggle).toHaveAttribute("aria-checked", "true");

		await fireEvent.click(toggle);
		expect(onChangeMemoryEnabled).toHaveBeenCalledWith(false);
	});

	it("renders the memory help copy and lives in a scroll-target card", () => {
		const { container } = render(SettingsProfileTab, {
			...baseProps,
			selectedModel: null,
			effectiveModel: "model1",
			systemDefaultModel: "model1",
			onChangeModel: vi.fn(),
			memoryEnabled: false,
		});

		expect(screen.getByText(/pause all learning/i)).toBeInTheDocument();
		expect(container.querySelector("#settings-memory-card")).not.toBeNull();
		expect(screen.getByRole("switch", { name: "Memory" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});
});
