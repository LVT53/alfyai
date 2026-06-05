import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SettingsProfileTab from "./SettingsProfileTab.svelte";

const baseProps = {
	userId: "user-1",
	userDisplayName: "User",
	userEmail: "user@example.com",
	avatarColors: ["#000000"],
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
		{ id: "model1", displayName: "Model 1" },
		{ id: "model2", displayName: "Model 2" },
	],
	selectedTheme: "system",
	selectedTitleLanguage: "auto",
	selectedUiLanguage: "en",
	onChangeTheme: vi.fn(),
	onChangeTitleLanguage: vi.fn(),
	onChangeUiLanguage: vi.fn(),
	onOpenResetModal: vi.fn(),
	onOpenDeleteModal: vi.fn(),
	onForgetEverything: vi.fn(),
} as const;

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
		const availableModels = [
			{ id: "model1", displayName: "Model 1" },
			...Array.from({ length: 12 }, (_, index) => ({
				id: `provider:test-provider:model-${index}` as const,
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
