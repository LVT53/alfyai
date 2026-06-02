import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ModelFormModal from "./ModelFormModal.svelte";

describe("ModelFormModal", () => {
	it("shows the selected model icon filename after the browser input is cleared", async () => {
		const onUploadIcon = vi.fn();

		const { getByLabelText, getByText } = render(ModelFormModal, {
			model: {
				id: "provider-1",
				name: "provider_slug",
				displayName: "Provider One",
				baseUrl: "https://api.example.com/v1",
				modelName: "provider/model",
				reasoningEffort: null,
				thinkingType: null,
				enabled: true,
				sortOrder: 0,
				maxModelContext: 132_000,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxMessageLength: null,
				maxTokens: null,
				iconAssetId: null,
				rateLimitFallbackEnabled: false,
				rateLimitFallbackBaseUrl: null,
				rateLimitFallbackModelName: null,
				rateLimitFallbackTimeoutMs: 10_000,
				createdAt: "",
				updatedAt: "",
			},
			onSave: vi.fn(),
			onClose: vi.fn(),
			onUploadIcon,
		});

		await fireEvent.change(getByLabelText("Upload icon"), {
			target: {
				files: [new File(["png"], "provider-icon.png", { type: "image/png" })],
			},
		});

		expect(getByText("Selected: provider-icon.png")).toBeInTheDocument();
		expect(onUploadIcon).toHaveBeenCalledWith(
			"provider-1",
			expect.objectContaining({ name: "provider-icon.png" }),
		);
	});

	it("keeps SVG icon uploads explicit and visible in the model form", async () => {
		const onUploadIcon = vi.fn();

		const { getByLabelText, getByText } = render(ModelFormModal, {
			model: {
				id: "provider-1",
				name: "provider_slug",
				displayName: "Provider One",
				baseUrl: "https://api.example.com/v1",
				modelName: "provider/model",
				reasoningEffort: null,
				thinkingType: null,
				enabled: true,
				sortOrder: 0,
				maxModelContext: 132_000,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxMessageLength: null,
				maxTokens: null,
				iconAssetId: null,
				rateLimitFallbackEnabled: false,
				rateLimitFallbackBaseUrl: null,
				rateLimitFallbackModelName: null,
				rateLimitFallbackTimeoutMs: 10_000,
				createdAt: "",
				updatedAt: "",
			},
			onSave: vi.fn(),
			onClose: vi.fn(),
			onUploadIcon,
		});

		await fireEvent.change(getByLabelText("Upload icon"), {
			target: {
				files: [
					new File(["<svg></svg>"], "provider-icon.svg", {
						type: "image/svg+xml",
					}),
				],
			},
		});

		expect(getByText("Selected: provider-icon.svg")).toBeInTheDocument();
		expect(onUploadIcon).toHaveBeenCalledWith(
			"provider-1",
			expect.objectContaining({ name: "provider-icon.svg" }),
		);
	});

	it("does not render retired Langflow routing controls for built-in models", () => {
		const onSave = vi.fn();

		const { getByRole, queryByLabelText } = render(ModelFormModal, {
			model: {
				id: "model1",
				name: "model1",
				displayName: "Model 1",
				baseUrl: "https://api.example.com/v1",
				modelName: "builtin-model",
				reasoningEffort: null,
				thinkingType: null,
				enabled: true,
				sortOrder: 0,
				maxModelContext: 132_000,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxMessageLength: null,
				maxTokens: null,
				iconAssetId: null,
				rateLimitFallbackEnabled: false,
				rateLimitFallbackBaseUrl: null,
				rateLimitFallbackModelName: null,
				rateLimitFallbackTimeoutMs: 10_000,
				createdAt: "",
				updatedAt: "",
				isBuiltIn: true,
			},
			onSave,
			onClose: vi.fn(),
		});

		expect(getByRole("dialog")).toBeInTheDocument();
		expect(queryByLabelText("Flow ID")).toBeNull();
		expect(queryByLabelText("Component ID")).toBeNull();
	});

	it("hides derived context budget fields and clears stale saved overrides", async () => {
		const onSave = vi.fn();

		const { getByRole, queryByLabelText } = render(ModelFormModal, {
			model: {
				id: "provider-1",
				name: "provider-1",
				displayName: "Provider One",
				baseUrl: "https://api.example.com/v1",
				modelName: "provider/model",
				reasoningEffort: null,
				thinkingType: null,
				enabled: true,
				sortOrder: 0,
				maxModelContext: 132_000,
				compactionUiThreshold: 105_600,
				targetConstructedContext: 118_800,
				maxMessageLength: null,
				maxTokens: null,
				iconAssetId: null,
				rateLimitFallbackEnabled: false,
				rateLimitFallbackBaseUrl: null,
				rateLimitFallbackModelName: null,
				rateLimitFallbackTimeoutMs: 10_000,
				createdAt: "",
				updatedAt: "",
			},
			onSave,
			onClose: vi.fn(),
		});

		expect(queryByLabelText("Compaction UI Threshold (tokens)")).toBeNull();
		expect(queryByLabelText("Target Constructed Context (tokens)")).toBeNull();

		await fireEvent.click(getByRole("button", { name: "Save Changes" }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				maxModelContext: 132_000,
				compactionUiThreshold: null,
				targetConstructedContext: null,
			}),
		);
	});
});
