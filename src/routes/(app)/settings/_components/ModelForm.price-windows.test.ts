import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/client/api/admin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/client/api/admin")>();
	return {
		...actual,
		fetchPriceWindows: vi.fn(),
		savePriceWindows: vi.fn(),
	};
});

import { fetchPriceWindows, savePriceWindows } from "$lib/client/api/admin";
import ModelForm from "./ModelForm.svelte";

const mockFetch = fetchPriceWindows as ReturnType<typeof vi.fn>;
const mockSave = savePriceWindows as ReturnType<typeof vi.fn>;

function modelFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "model-1",
		providerId: "provider-1",
		name: "deepseek-chat",
		displayName: "DeepSeek Chat",
		iconAssetId: null,
		fallbackProviderModelId: null,
		aliases: [],
		maxModelContext: 128_000,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
		capabilitiesJson: "{}",
		guideNoteEn: null,
		guideNoteHu: null,
		guideBadge: null,
		guideNoCost: false,
		estimatedTokensPerSecond: null,
		inputUsdMicrosPer1m: 1_000_000,
		cachedInputUsdMicrosPer1m: 100_000,
		cacheHitUsdMicrosPer1m: 100_000,
		cacheMissUsdMicrosPer1m: 0,
		outputUsdMicrosPer1m: 2_000_000,
		enabled: true,
		sortOrder: 0,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function openTimeSlotSection(container: HTMLElement) {
	const summaries = [...container.querySelectorAll("summary")];
	const summary = summaries.find((s) =>
		s.textContent?.includes("Time-slot pricing"),
	);
	const details = summary?.closest("details") as HTMLDetailsElement;
	details.open = true;
	fireEvent(details, new Event("toggle"));
	return details;
}

describe("ModelForm time-slot pricing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetch.mockResolvedValue([]);
		mockSave.mockResolvedValue([]);
	});

	it("does not render the section when creating a model", () => {
		const { queryByText } = render(ModelForm, {
			providerId: "provider-1",
			model: null,
			onSave: vi.fn(),
			onClose: vi.fn(),
		});
		expect(queryByText("Time-slot pricing (optional)")).toBeNull();
	});

	it("lazy-loads existing windows when the section is expanded", async () => {
		mockFetch.mockResolvedValue([
			{
				id: "w1",
				providerModelId: "model-1",
				label: "off-peak",
				daysOfWeek: "0123456",
				startMinute: 30,
				endMinute: 8 * 60,
				inputUsdMicrosPer1m: 500_000,
				cachedInputUsdMicrosPer1m: null,
				cacheHitUsdMicrosPer1m: null,
				cacheMissUsdMicrosPer1m: null,
				outputUsdMicrosPer1m: null,
				enabled: true,
				createdAt: "",
				updatedAt: "",
			},
		]);
		const { container, findByDisplayValue } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave: vi.fn(),
			onClose: vi.fn(),
		});

		openTimeSlotSection(container);

		await waitFor(() =>
			expect(mockFetch).toHaveBeenCalledWith("provider-1", "model-1"),
		);
		// 30 minutes -> 00:30, 480 -> 08:00, rate 500000 micros -> 0.5 dollars.
		expect(await findByDisplayValue("off-peak")).toBeTruthy();
		expect(await findByDisplayValue("00:30")).toBeTruthy();
		expect(await findByDisplayValue("08:00")).toBeTruthy();
		expect(await findByDisplayValue("0.5")).toBeTruthy();
	});

	it("adds a window and saves it as minute-of-day with mirrored cache-hit", async () => {
		const { container, getByRole, getByLabelText } = render(ModelForm, {
			providerId: "provider-1",
			model: modelFixture(),
			onSave: vi.fn(),
			onClose: vi.fn(),
		});

		openTimeSlotSection(container);
		await waitFor(() => expect(mockFetch).toHaveBeenCalled());

		await fireEvent.click(
			getByRole("button", { name: "Add time-slot window" }),
		);

		await fireEvent.input(getByLabelText("Label"), {
			target: { value: "off-peak" },
		});
		await fireEvent.input(getByLabelText("Start (UTC)"), {
			target: { value: "16:30" },
		});
		await fireEvent.input(getByLabelText("End (UTC)"), {
			target: { value: "00:30" },
		});
		await fireEvent.input(getByLabelText("Cached input override ($/1M)"), {
			target: { value: "0.25" },
		});

		await fireEvent.click(
			getByRole("button", { name: "Save time-slot pricing" }),
		);

		await waitFor(() => expect(mockSave).toHaveBeenCalled());
		const [providerId, modelId, windows] = mockSave.mock.calls[0];
		expect(providerId).toBe("provider-1");
		expect(modelId).toBe("model-1");
		expect(windows).toEqual([
			expect.objectContaining({
				label: "off-peak",
				daysOfWeek: "0123456",
				startMinute: 16 * 60 + 30,
				endMinute: 30,
				cachedInputUsdMicrosPer1m: 250_000,
				cacheHitUsdMicrosPer1m: 250_000,
				inputUsdMicrosPer1m: null,
				enabled: true,
			}),
		]);
	});
});
