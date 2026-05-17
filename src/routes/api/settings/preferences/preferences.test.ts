import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

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
});
