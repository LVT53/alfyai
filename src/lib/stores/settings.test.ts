import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The zone the browser reports is the machine's; a test sets its own.
const browserZone = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("$lib/shared/time-zone", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/shared/time-zone")>()),
	detectBrowserTimeZone: () => browserZone.value,
}));

import {
	initSettings,
	type ModelId,
	selectedModel,
	selectedReasoningDepth,
	setModelPreferenceAndSync,
	setSelectedModel,
	setSelectedModelAndSync,
	setSelectedReasoningDepth,
	syncDetectedTimeZone,
} from "./settings";

describe("settings store", () => {
	let localStorageMock: Record<string, string> = {};

	beforeEach(() => {
		// Reset store to default
		selectedModel.set("model1");
		selectedReasoningDepth.set("thorough");
		localStorageMock = {};
		vi.restoreAllMocks();
		vi.stubGlobal("fetch", vi.fn());

		// Mock localStorage
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => localStorageMock[key] || null),
			setItem: vi.fn((key: string, value: string) => {
				localStorageMock[key] = value;
			}),
			removeItem: vi.fn((key: string) => {
				delete localStorageMock[key];
			}),
			clear: vi.fn(() => {
				localStorageMock = {};
			}),
		});

		// Mock window
		vi.stubGlobal("window", {
			...window,
			localStorage,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("selectedModel", () => {
		it("should have default value of model1", () => {
			const model = get(selectedModel);
			expect(model).toBe("model1");
		});
	});

	describe("initSettings", () => {
		it("should load selected model from localStorage", () => {
			localStorageMock.selectedModel = "model2";
			initSettings();
			expect(get(selectedModel)).toBe("model2");
		});

		it("should prioritize server preferences over localStorage", () => {
			localStorageMock.selectedModel = "model2";

			initSettings({ model: "model1" });

			expect(get(selectedModel)).toBe("model1");
			expect(localStorageMock.selectedModel).toBe("model1");
		});

		it("should load the thinking toggle from localStorage", () => {
			localStorageMock.reasoningDepth = "quick";

			initSettings();

			expect(get(selectedReasoningDepth)).toBe("quick");
		});

		it("should migrate the legacy 'off' ladder value to quick", () => {
			localStorageMock.reasoningDepth = "off";

			initSettings();

			expect(get(selectedReasoningDepth)).toBe("quick");
		});

		it("should migrate legacy 'auto' and 'max' ladder values to thorough", () => {
			localStorageMock.reasoningDepth = "auto";
			initSettings();
			expect(get(selectedReasoningDepth)).toBe("thorough");

			localStorageMock.reasoningDepth = "max";
			initSettings();
			expect(get(selectedReasoningDepth)).toBe("thorough");
		});

		it("should migrate legacy thinking mode to the thinking toggle", () => {
			localStorageMock.thinkingMode = "off";

			initSettings();

			expect(get(selectedReasoningDepth)).toBe("quick");
		});

		it("should default legacy thinking mode 'on'/'auto' to thorough", () => {
			localStorageMock.thinkingMode = "on";

			initSettings();

			expect(get(selectedReasoningDepth)).toBe("thorough");
		});
	});

	describe("setSelectedModel", () => {
		it("should update store to model2", () => {
			setSelectedModel("model2");
			expect(get(selectedModel)).toBe("model2");
		});

		it("should persist selected model to localStorage", () => {
			setSelectedModel("model2");
			expect(localStorage.setItem).toHaveBeenCalledWith(
				"selectedModel",
				"model2",
			);
			expect(localStorageMock.selectedModel).toBe("model2");
		});
	});

	describe("setSelectedReasoningDepth", () => {
		it("should update and persist the thinking toggle", () => {
			setSelectedReasoningDepth("quick");

			expect(get(selectedReasoningDepth)).toBe("quick");
			expect(localStorage.setItem).toHaveBeenCalledWith(
				"reasoningDepth",
				"quick",
			);
			expect(localStorageMock.reasoningDepth).toBe("quick");
		});
	});

	describe("sync helpers", () => {
		it("should sync selected model through the preferences API", async () => {
			vi.mocked(fetch).mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true })),
			);

			await setSelectedModelAndSync("model2");

			expect(get(selectedModel)).toBe("model2");
			expect(fetch).toHaveBeenCalledWith(
				"/api/settings/preferences",
				expect.objectContaining({
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ preferredModel: "model2" satisfies ModelId }),
				}),
			);
		});

		it("should keep the local selected model if syncing fails", async () => {
			vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));

			await setSelectedModelAndSync("model2");

			expect(get(selectedModel)).toBe("model2");
		});

		it("should sync an inherited system default while applying the effective model locally", async () => {
			vi.mocked(fetch).mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true })),
			);

			await setModelPreferenceAndSync(null, "model2");

			expect(get(selectedModel)).toBe("model2");
			expect(fetch).toHaveBeenCalledWith(
				"/api/settings/preferences",
				expect.objectContaining({
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ preferredModel: null }),
				}),
			);
		});
	});
	describe("syncDetectedTimeZone", () => {
		const zonePatch = (zone: string) =>
			expect.objectContaining({
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ timeZone: zone }),
			});

		beforeEach(() => {
			browserZone.value = null;
		});

		it("saves the browser's zone without a prompt when the server holds none, and remembers it", async () => {
			browserZone.value = "Europe/Budapest";
			vi.mocked(fetch).mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true })),
			);

			await syncDetectedTimeZone(null);

			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledWith(
				"/api/settings/preferences",
				zonePatch("Europe/Budapest"),
			);
			expect(localStorageMock.detectedTimeZone).toBe("Europe/Budapest");
		});

		it("writes nothing when the server already holds that zone, and still remembers what the browser saw", async () => {
			browserZone.value = "Europe/Budapest";

			await syncDetectedTimeZone("Europe/Budapest");

			expect(fetch).not.toHaveBeenCalled();
			expect(localStorageMock.detectedTimeZone).toBe("Europe/Budapest");
		});

		it("follows a browser that has moved since it last looked", async () => {
			localStorageMock.detectedTimeZone = "Europe/Budapest";
			browserZone.value = "Europe/London";
			vi.mocked(fetch).mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true })),
			);

			await syncDetectedTimeZone("Europe/Budapest");

			expect(fetch).toHaveBeenCalledWith(
				"/api/settings/preferences",
				zonePatch("Europe/London"),
			);
			expect(localStorageMock.detectedTimeZone).toBe("Europe/London");
		});

		it("leaves a zone the person chose alone while the browser still sees what it saw", async () => {
			localStorageMock.detectedTimeZone = "Europe/Budapest";
			browserZone.value = "Europe/Budapest";

			await syncDetectedTimeZone("Asia/Tokyo");

			expect(fetch).not.toHaveBeenCalled();
		});

		it("leaves a stored zone alone for a browser that has never looked here", async () => {
			browserZone.value = "Europe/Budapest";

			await syncDetectedTimeZone("Asia/Tokyo");

			expect(fetch).not.toHaveBeenCalled();
			expect(localStorageMock.detectedTimeZone).toBe("Europe/Budapest");
		});

		it("does not remember the zone when the save fails, so the next load tries again, and never throws", async () => {
			browserZone.value = "Europe/Budapest";
			vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));

			await expect(syncDetectedTimeZone(null)).resolves.toBeUndefined();

			expect(localStorageMock.detectedTimeZone).toBeUndefined();
		});

		it("does nothing when the browser has no zone to offer", async () => {
			browserZone.value = null;

			await syncDetectedTimeZone(null);

			expect(fetch).not.toHaveBeenCalled();
			expect(localStorageMock.detectedTimeZone).toBeUndefined();
		});
	});
});
