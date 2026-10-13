import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const invalidateHomeSummary = vi.hoisted(() => vi.fn());
const updateSet = vi.hoisted(() => vi.fn());
const updateWhere = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("$lib/server/db", () => ({
	db: {
		update: vi.fn(() => ({
			set: updateSet.mockReturnValue({
				where: updateWhere,
			}),
		})),
	},
}));

vi.mock("$lib/server/services/home-summary", () => ({
	invalidateHomeSummary,
}));

vi.mock("$lib/server/db/schema", () => ({
	users: {
		id: "id",
	},
}));

vi.mock("$lib/server/config-store", () => ({
	getAvailableModelsWithProviders: vi.fn(async () => [
		{ id: "model1", displayName: "Model 1" },
		{ id: "model2", displayName: "Model 2" },
	]),
	getConfig: vi.fn(() => ({
		defaultNewUserModel: "model2",
		model1: { displayName: "Model 1" },
		model2: { displayName: "Model 2" },
		model2Enabled: true,
	})),
	normalizeModelSelection: vi.fn((model: string) => model),
	normalizeModelSelectionWithProviders: vi.fn(async (model: string) => model),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn(),
}));

import { PATCH } from "./+server";

function makeEvent(body: unknown) {
	return {
		request: new Request("http://localhost/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
	} as Parameters<typeof PATCH>[0];
}

describe("settings preferences route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("accepts null preferredModel as inherited System default", async () => {
		const response = await PATCH(makeEvent({ preferredModel: null }));

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				preferredModel: "model2",
				modelPreferenceMode: "system",
			}),
		);
	});

	it("stores explicit preferredModel choices with explicit mode", async () => {
		const response = await PATCH(makeEvent({ preferredModel: "model1" }));

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				preferredModel: "model1",
				modelPreferenceMode: "explicit",
			}),
		);
	});

	// The home screen's running-job labels are written in the UI language and
	// cached per user for 30 seconds: switching language drops the cache, so the
	// old language's labels are not shown for half a minute.
	it("drops the cached home summary when the UI language changes, and only then", async () => {
		await PATCH(makeEvent({ theme: "dark" }));
		expect(invalidateHomeSummary).not.toHaveBeenCalled();

		const response = await PATCH(makeEvent({ uiLanguage: "hu" }));

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenLastCalledWith(
			expect.objectContaining({ uiLanguage: "hu" }),
		);
		expect(invalidateHomeSummary).toHaveBeenCalledWith("user-1");
	});

	it("keeps the cached home summary when the language sent is refused", async () => {
		const response = await PATCH(makeEvent({ uiLanguage: "de" }));

		expect(response.status).toBe(400);
		expect(invalidateHomeSummary).not.toHaveBeenCalled();
	});
});
