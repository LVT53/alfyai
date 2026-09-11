import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsResponse } from "$lib/client/api/settings";
import type { ModelId } from "$lib/model-types";
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
	onOpenPictureEditor: vi.fn(),
	onRemovePhoto: vi.fn(),
	name: "User",
	email: "user@example.com",
	currentPassword: "",
	newPassword: "",
	confirmPassword: "",
	showCurrentPw: false,
	showNewPw: false,
	showConfirmPw: false,
	onSaveAccount: vi.fn(),
	onDiscardAccount: vi.fn(),
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

const cardTitle = { selector: "h2.settings-card-title" };

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchUserSkills.mockResolvedValue([]);
	mockFetchUserSkillVariants.mockResolvedValue([]);
	mockFetchSystemSkillSummaries.mockResolvedValue([]);
});

describe("SettingsProfileTab — the six cards", () => {
	it("renders the cards in the reading order the phone shows", () => {
		renderTab({
			personalAnalyticsData: null,
		});

		const order = [
			"Your account",
			"Preferences",
			"Assistant behaviour",
			"Data & privacy",
			"Your Activity",
			"Things that cannot be undone",
		].map((title) => screen.getByText(title, cardTitle));

		for (const title of order) {
			expect(title).toBeInTheDocument();
		}

		for (let index = 1; index < order.length; index += 1) {
			expect(
				order[index - 1].compareDocumentPosition(order[index]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
				`${order[index - 1].textContent} should precede ${order[index].textContent}`,
			).toBeTruthy();
		}
	});

	it("keeps EVERY feature the old five-section tab carried (no field dropped)", () => {
		renderTab({
			profilePicture: "https://example.com/p.png",
			personalityProfiles: [
				{ id: "p1", name: "Concise", description: "Short" },
			],
		});

		// Identity card: avatar controls, name, email, all three password boxes.
		expect(screen.getByLabelText("Upload photo")).toBeInTheDocument();
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

		// Preferences: model, style, appearance, both languages.
		expect(screen.getByText("Default model")).toBeInTheDocument();
		expect(screen.getByText("Conversation style")).toBeInTheDocument();
		expect(screen.getByText("Appearance")).toBeInTheDocument();
		expect(screen.getByText("Interface language")).toBeInTheDocument();
		expect(screen.getByText("Title language")).toBeInTheDocument();

		// Assistant: memory switch, skills, memory profile.
		expect(screen.getByRole("switch", { name: "Memory" })).toBeInTheDocument();
		expect(screen.getByTestId("skills-summary-card")).toBeInTheDocument();
		expect(screen.getByText("Memory profile")).toBeInTheDocument();

		// Data & privacy: policy, import (folded in from its own card), archive.
		expect(screen.getByText("Privacy policy")).toBeInTheDocument();
		expect(screen.getAllByText("Import from ChatGPT").length).toBeGreaterThan(
			0,
		);
		expect(screen.getByText("Download my data")).toBeInTheDocument();

		// Things that cannot be undone: all three, each with its consequence.
		expect(screen.getByText("Clear memory and knowledge")).toBeInTheDocument();
		expect(screen.getByText("Clear workspace data")).toBeInTheDocument();
		expect(screen.getByText("Delete account")).toBeInTheDocument();
	});

	it("drops the five desktop sub-tab pills and the group labels they scrolled to", () => {
		renderTab();

		// The old sticky anchor nav is gone.
		expect(
			screen.queryByRole("navigation", { name: "Profile sections" }),
		).not.toBeInTheDocument();
		// So are the five standalone group headings it pointed at.
		expect(
			screen.queryByText("Account", { selector: "p.settings-group-label" }),
		).not.toBeInTheDocument();
	});

	it("puts the three irreversible actions in their own bordered card, last", () => {
		renderTab();

		const danger = screen.getByTestId("profile-danger-card");
		expect(danger).toHaveClass("settings-card-danger");

		for (const action of [
			"Clear memory and knowledge",
			"Clear workspace data",
			"Delete account",
		]) {
			expect(
				within(danger).getByRole("button", { name: action }),
			).toBeInTheDocument();
		}

		// Download my data is NOT in it — it is not irreversible.
		expect(
			within(danger).queryByRole("button", { name: "Download my data" }),
		).not.toBeInTheDocument();
	});

	it("fires every destructive and export callback", async () => {
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

		await fireEvent.click(
			screen.getByRole("button", { name: "Download my data" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Clear memory and knowledge" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Clear workspace data" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Delete account" }),
		);

		expect(onOpenDownloadArchive).toHaveBeenCalledOnce();
		expect(onOpenClearMemory).toHaveBeenCalledOnce();
		expect(onOpenClearWorkspace).toHaveBeenCalledOnce();
		expect(onOpenDeleteModal).toHaveBeenCalledOnce();
	});

	it("fires the avatar callbacks", async () => {
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

	it("still links the privacy policy straight to the public /privacy route (ADR 0044 Decision 5)", () => {
		renderTab();

		const link = screen.getByLabelText("Privacy policy");
		expect(link.tagName).toBe("A");
		expect(link).toHaveAttribute("href", "/privacy");
	});

	it("surfaces a privacy action's outcome", () => {
		renderTab({
			privacyControlsError: "Wrong password",
			privacyControlsMessage: "Archive downloaded.",
		});

		expect(screen.getByText("Wrong password")).toBeInTheDocument();
		expect(screen.getByText("Archive downloaded.")).toBeInTheDocument();
	});
});

describe("SettingsProfileTab — one identity card, one Save", () => {
	it("carries a single Save with a Discard beside it", () => {
		renderTab();

		expect(screen.getByTestId("account-save")).toBeInTheDocument();
		expect(screen.getByTestId("account-discard")).toBeInTheDocument();
		// The two old Save buttons are gone.
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Change Password" }),
		).toBeNull();
	});

	it("says out loud that the password boxes are optional", () => {
		renderTab();

		expect(
			screen.getByText(/Leave the password boxes empty/),
		).toBeInTheDocument();
		expect(screen.getByText("Change password — optional")).toBeInTheDocument();
	});

	it("calls the one Save and the one Discard", async () => {
		const onSaveAccount = vi.fn();
		const onDiscardAccount = vi.fn();
		renderTab({ onSaveAccount, onDiscardAccount, accountDirty: true });

		await fireEvent.click(screen.getByTestId("account-save"));
		expect(onSaveAccount).toHaveBeenCalledOnce();

		await fireEvent.click(screen.getByTestId("account-discard"));
		expect(onDiscardAccount).toHaveBeenCalledOnce();
	});

	it("leaves Discard inert until something is actually dirty", () => {
		renderTab({ accountDirty: false });
		expect(screen.getByTestId("account-discard")).toBeDisabled();
	});

	it("shows when the card last went clean, and nothing when it never has", () => {
		const { unmount } = renderTab({ savedAtLabel: "12:02" });
		expect(screen.getByTestId("account-saved-at")).toHaveTextContent(
			"Saved 12:02",
		);
		unmount();

		renderTab();
		expect(screen.queryByTestId("account-saved-at")).toBeNull();
	});

	it("disables Save while it is in flight and says so", () => {
		renderTab({ accountSaving: true });

		const save = screen.getByTestId("account-save");
		expect(save).toBeDisabled();
		expect(save).toHaveTextContent("Saving...");
	});
});

describe("SettingsProfileTab — the default model select", () => {
	it("shows what System default resolves to and emits null for inheritance", async () => {
		const onChangeModel = vi.fn();
		renderTab({
			selectedModel: null,
			effectiveModel: "model2",
			systemDefaultModel: "model2",
			onChangeModel,
		});

		const select = screen.getByTestId(
			"settings-default-model-select",
		) as HTMLSelectElement;
		expect(select.value).toBe("");
		expect(select.options[0].textContent?.trim()).toBe(
			"System default: Model 2",
		);
		// The system default is not repeated as an explicit option.
		expect([...select.options].map((option) => option.value)).toEqual([
			"",
			"model1",
		]);

		await fireEvent.change(select, { target: { value: "model1" } });
		expect(onChangeModel).toHaveBeenCalledWith("model1");

		await fireEvent.change(select, { target: { value: "" } });
		expect(onChangeModel).toHaveBeenLastCalledWith(null);
	});

	it("keeps the admin system default distinct from an explicit user override", () => {
		renderTab({
			selectedModel: "model2",
			effectiveModel: "model2",
			systemDefaultModel: "model1",
		});

		const select = screen.getByTestId(
			"settings-default-model-select",
		) as HTMLSelectElement;
		expect(select.value).toBe("model2");
		expect(select.options[0].textContent?.trim()).toBe(
			"System default: Model 1",
		);
	});

	it("replaces the 44px-per-model pill grid with one select, however many models there are", () => {
		const availableModels: Array<{ id: ModelId; displayName: string }> = [
			{ id: "model1" as ModelId, displayName: "Model 1" },
			...Array.from({ length: 12 }, (_, index) => ({
				id: `provider:test-provider:model-${index}` as ModelId,
				displayName: `Provider Model With A Long Display Name ${index + 1}`,
			})),
		];

		const { container } = renderTab({ availableModels });

		expect(
			container.querySelector('[data-testid="settings-default-model-grid"]'),
		).toBeNull();
		const select = screen.getByTestId(
			"settings-default-model-select",
		) as HTMLSelectElement;
		expect(select.options).toHaveLength(availableModels.length);
		expect(screen.getByText("12 other models available")).toBeInTheDocument();
	});
});

describe("SettingsProfileTab — preference rows", () => {
	it("drives appearance, interface language and title language from segmented controls", async () => {
		const onChangeTheme = vi.fn();
		const onChangeUiLanguage = vi.fn();
		const onChangeTitleLanguage = vi.fn();
		renderTab({ onChangeTheme, onChangeUiLanguage, onChangeTitleLanguage });

		const appearance = screen.getByRole("group", { name: "Appearance" });
		const system = within(appearance).getByRole("button", { name: "System" });
		expect(system).toHaveAttribute("aria-pressed", "true");
		await fireEvent.click(
			within(appearance).getByRole("button", { name: "Dark" }),
		);
		expect(onChangeTheme).toHaveBeenCalledWith("dark");

		const uiLang = screen.getByRole("group", { name: "Interface language" });
		await fireEvent.click(
			within(uiLang).getByRole("button", { name: "Magyar" }),
		);
		expect(onChangeUiLanguage).toHaveBeenCalledWith("hu");

		const titleLang = screen.getByRole("group", { name: "Title language" });
		await fireEvent.click(
			within(titleLang).getByRole("button", { name: "English" }),
		);
		expect(onChangeTitleLanguage).toHaveBeenCalledWith("en");
	});

	it("offers conversation style as a select, and only when profiles exist", async () => {
		const onChangePersonality = vi.fn();
		const { unmount } = renderTab();
		expect(
			screen.queryByTestId("settings-conversation-style-select"),
		).toBeNull();
		unmount();

		renderTab({
			personalityProfiles: [{ id: "p1", name: "Concise", description: "" }],
			onChangePersonality,
		});
		const select = screen.getByTestId("settings-conversation-style-select");
		await fireEvent.change(select, { target: { value: "p1" } });
		expect(onChangePersonality).toHaveBeenCalledWith("p1");

		await fireEvent.change(select, { target: { value: "" } });
		expect(onChangePersonality).toHaveBeenLastCalledWith(null);
	});
});

describe("SettingsProfileTab — assistant behaviour", () => {
	it("reflects the memory state, names it in words and toggles it", async () => {
		const onChangeMemoryEnabled = vi.fn();
		const { unmount } = renderTab({
			memoryEnabled: true,
			onChangeMemoryEnabled,
		});

		const toggle = screen.getByRole("switch", { name: "Memory" });
		expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(screen.getByText("On")).toBeInTheDocument();

		await fireEvent.click(toggle);
		expect(onChangeMemoryEnabled).toHaveBeenCalledWith(false);
		unmount();

		renderTab({ memoryEnabled: false });
		expect(screen.getByRole("switch", { name: "Memory" })).toHaveAttribute(
			"aria-checked",
			"false",
		);
		expect(screen.getByText("Off")).toBeInTheDocument();
		expect(screen.getByText(/pause all learning/i)).toBeInTheDocument();
	});

	it("links the memory profile to the Knowledge Base", () => {
		renderTab();

		const link = screen.getByLabelText("Open Knowledge Base");
		expect(link.tagName).toBe("A");
		expect(link).toHaveAttribute("href", "/knowledge");
	});

	it("opens the re-homed Skills manager and comes back", async () => {
		renderTab();

		expect(screen.queryByText("Private skills")).not.toBeInTheDocument();
		await fireEvent.click(screen.getByTestId("skills-summary-card"));

		await waitFor(() =>
			expect(screen.getByText("Private skills")).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: "New skill" }),
		).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(screen.queryByText("Private skills")).not.toBeInTheDocument();
		expect(screen.getByTestId("skills-summary-card")).toBeInTheDocument();
	});

	it("derives the active/disabled counts from the skills data", async () => {
		const skill = (id: string, enabled: boolean) => ({
			id,
			ownership: "user",
			displayName: id,
			description: "",
			instructions: "",
			activationExamples: [],
			enabled,
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
			creationSource: "user_created",
			version: 1,
			createdAt: 1,
			updatedAt: 1,
		});
		mockFetchUserSkills.mockResolvedValue([
			skill("skill-1", true),
			skill("skill-2", false),
		]);

		renderTab();

		await waitFor(() =>
			expect(screen.getByText("1 active")).toBeInTheDocument(),
		);
		expect(screen.getByText("1 disabled")).toBeInTheDocument();
	});

	it("says skills are off and offers no manager when the workspace disabled them", () => {
		renderTab({ skillsEnabled: false });

		expect(
			screen.getByText("Skills are disabled by your workspace administrator."),
		).toBeInTheDocument();
		expect(screen.queryByTestId("skills-summary-card")).toBeNull();
	});
});

describe("SettingsProfileTab — Your Activity summary and full view", () => {
	const personalAnalyticsData: AnalyticsResponse = {
		availableMonths: ["2026-06"],
		personal: {
			byModel: [],
			byProvider: [],
			totalMessages: 4812,
			avgGenerationMs: 1200,
			totalTokens: 18_400_000,
			promptTokens: 1000,
			cachedInputTokens: 0,
			outputTokens: 12_800_000,
			reasoningTokens: 5_600_000,
			totalCostUsd: 3.14,
			favoriteModel: "model1",
			chatCount: 312,
		},
	};

	it("summarises the usage instead of printing the whole analytics surface", () => {
		renderTab({
			personalAnalyticsData,
			modelNames: { model1: "Flash-Next" },
		});

		expect(screen.getByText("18.4M")).toBeInTheDocument();
		expect(screen.getByText("Tokens, all time")).toBeInTheDocument();
		expect(
			screen.getByText("12.8M completion · 5.6M reasoning"),
		).toBeInTheDocument();
		expect(screen.getByText("4,812")).toBeInTheDocument();
		expect(screen.getByText("312")).toBeInTheDocument();
		expect(screen.getByText("Flash-Next")).toBeInTheDocument();

		// The full analytics surface is NOT inline any more.
		expect(screen.queryByText("Messages sent")).not.toBeInTheDocument();
	});

	it("opens the full view from the summary and comes back", async () => {
		renderTab({ personalAnalyticsData });

		await fireEvent.click(screen.getByTestId("activity-open"));
		expect(screen.getByTestId("activity-fullview")).toBeInTheDocument();
		expect(screen.getByText("Messages sent")).toBeInTheDocument();
		expect(screen.getByText("Tokens used")).toBeInTheDocument();
		expect(screen.getByText("Conversations")).toBeInTheDocument();

		await fireEvent.click(
			screen.getByRole("button", { name: "Back to Profile" }),
		);
		expect(screen.queryByTestId("activity-fullview")).toBeNull();
		expect(screen.getByText("18.4M")).toBeInTheDocument();
	});

	it("does NOT render system-level analytics anywhere in the tab", async () => {
		renderTab({ personalAnalyticsData });

		await fireEvent.click(screen.getByTestId("activity-open"));

		expect(screen.queryByText("System Overview")).not.toBeInTheDocument();
		expect(screen.queryByText("Per-User Breakdown")).not.toBeInTheDocument();
		expect(screen.queryByText("Excluded Users")).not.toBeInTheDocument();
	});

	it("says so plainly when there is nothing to summarise", () => {
		renderTab({ personalAnalyticsData: null });
		expect(screen.getByText("Nothing recorded yet.")).toBeInTheDocument();
	});

	it("tells a failed load apart from an empty account, and offers the retry", async () => {
		const onRetryPersonalAnalytics = vi.fn();
		renderTab({
			personalAnalyticsData: null,
			personalAnalyticsError: "Failed to load analytics",
			onRetryPersonalAnalytics,
		});

		expect(screen.getByTestId("activity-error")).toHaveTextContent(
			"Failed to load analytics",
		);
		expect(screen.queryByText("Nothing recorded yet.")).toBeNull();

		await fireEvent.click(screen.getByTestId("activity-retry"));
		expect(onRetryPersonalAnalytics).toHaveBeenCalled();
	});

	it("shows loading, not an error, while the first load is still in flight", () => {
		renderTab({
			personalAnalyticsData: null,
			personalAnalyticsLoading: true,
		});
		expect(screen.queryByTestId("activity-error")).toBeNull();
		expect(screen.queryByText("Nothing recorded yet.")).toBeNull();
	});
});

describe("SettingsProfileTab — the phone jump-list", () => {
	function stubMatchMedia(matches: boolean) {
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				matches,
				media: query,
				onchange: null,
				addListener: () => undefined,
				removeListener: () => undefined,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
				dispatchEvent: () => false,
			})),
		);
	}

	function spyOnScrollIntoView() {
		const original = HTMLElement.prototype.scrollIntoView;
		if (!original) {
			Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
				configurable: true,
				value: vi.fn(),
			});
		}
		const spy = vi
			.spyOn(HTMLElement.prototype, "scrollIntoView")
			.mockImplementation(() => undefined);
		return {
			spy,
			restore() {
				spy.mockRestore();
				if (!original) {
					Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
				}
			},
		};
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const expected = [
		{ label: "Account", id: "settings-section-account" },
		{ label: "Preferences", id: "settings-section-preferences" },
		{ label: "Assistant", id: "settings-section-assistant" },
		{ label: "Data & privacy", id: "settings-section-data-privacy" },
	];

	it("is four chips — one per card, never a filter over hidden content", () => {
		renderTab();

		const nav = screen.getByRole("navigation", { name: "Jump to a section" });
		const chips = within(nav).getAllByRole("link");
		expect(chips).toHaveLength(expected.length);

		expected.forEach(({ label, id }, index) => {
			expect(chips[index]).toHaveTextContent(label);
			expect(chips[index]).toHaveAttribute("href", `#${id}`);
			expect(document.getElementById(id)).not.toBeNull();
		});
	});

	it("smooth-scrolls to the card, and jumps instantly under reduced motion", async () => {
		const first = spyOnScrollIntoView();
		renderTab();
		const nav = screen.getByRole("navigation", { name: "Jump to a section" });
		await fireEvent.click(within(nav).getByRole("link", { name: "Assistant" }));
		expect(first.spy).toHaveBeenCalledWith(
			expect.objectContaining({ behavior: "smooth" }),
		);
		first.restore();

		stubMatchMedia(true);
		const second = spyOnScrollIntoView();
		renderTab();
		const navs = screen.getAllByRole("navigation", {
			name: "Jump to a section",
		});
		await fireEvent.click(
			within(navs[navs.length - 1]).getByRole("link", { name: "Assistant" }),
		);
		expect(second.spy).toHaveBeenCalledWith(
			expect.objectContaining({ behavior: "auto" }),
		);
		second.restore();
	});
});
