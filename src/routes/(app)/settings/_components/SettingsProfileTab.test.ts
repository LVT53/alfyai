import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ModelId } from "$lib/types";
import SettingsProfileTab from "./SettingsProfileTab.svelte";

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

describe("SettingsProfileTab model preference", () => {
	it("shows approved Privacy and Data Controls labels and action callbacks", async () => {
		const onOpenDownloadArchive = vi.fn();
		const onOpenClearMemory = vi.fn();
		const onOpenClearWorkspace = vi.fn();
		const onOpenDeleteModal = vi.fn();

		render(SettingsProfileTab, {
			...baseProps,
			selectedModel: null,
			effectiveModel: "model1",
			systemDefaultModel: "model1",
			onChangeModel: vi.fn(),
			onOpenDownloadArchive,
			onOpenClearMemory,
			onOpenClearWorkspace,
			onOpenDeleteModal,
		});

		expect(
			screen.getByRole("heading", { name: "Privacy and Data Controls" }),
		).toBeInTheDocument();
		const changePasswordHeading = screen.getByRole("heading", {
			name: "Change Password",
		});
		const privacyHeading = screen.getByRole("heading", {
			name: "Privacy and Data Controls",
		});
		const preferencesHeading = screen.getByRole("heading", {
			name: "Preferences",
		});
		const dataImportHeading = screen.getByRole("heading", {
			name: "Data & Import",
		});
		const skillsHeading = screen.getByRole("heading", {
			name: "Private skills",
		});
		expect(
			changePasswordHeading.compareDocumentPosition(privacyHeading) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			preferencesHeading.compareDocumentPosition(privacyHeading) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			dataImportHeading.compareDocumentPosition(privacyHeading) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			skillsHeading.compareDocumentPosition(privacyHeading) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.queryByText("Danger Zone")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Reset Account" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Reset Memory" }),
		).not.toBeInTheDocument();

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
