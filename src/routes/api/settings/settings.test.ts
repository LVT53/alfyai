import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTRUCTIONS_MAX_CHARS } from "$lib/shared/instructions";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const userRow = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
}));

const selectWhere = vi.hoisted(() =>
	vi.fn(async () => [userRow.row] as unknown[]),
);
const updateSet = vi.hoisted(() => vi.fn());
const updateWhere = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({ where: selectWhere })),
		})),
		update: vi.fn(() => ({
			set: updateSet.mockReturnValue({ where: updateWhere }),
		})),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	users: { id: "id" },
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({ defaultNewUserModel: "model1" })),
	getAvailableModelsWithProviders: vi.fn(async () => [
		{ id: "model1", displayName: "Model 1" },
	]),
}));

vi.mock("$lib/server/services/model-preferences", () => ({
	resolveUserModelPreference: vi.fn(async () => ({
		preference: "model1",
		effectiveModel: "model1",
		systemDefaultModel: "model1",
	})),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn(),
}));

import { GET } from "./+server";
import { PATCH } from "./preferences/+server";

function makeGetEvent() {
	return {
		request: new Request("http://localhost/api/settings"),
		locals: { user: { id: "user-1" } },
	} as unknown as Parameters<typeof GET>[0];
}

function makePatchEvent(body: unknown) {
	return {
		request: new Request("http://localhost/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
	} as Parameters<typeof PATCH>[0];
}

const CLEARED_ROW = {
	id: "user-1",
	email: "user@example.com",
	name: "User",
	role: "user",
	preferredModel: "model1",
	modelPreferenceMode: null,
	theme: "system",
	titleLanguage: "auto",
	uiLanguage: "en",
	preferredPersonalityId: null,
	sidebarProjectsExpanded: true,
	sidebarChatsExpanded: true,
	memoryEnabled: true,
	profilePicture: null,
	personalInstructions: null,
};

describe("GET /api/settings personal instructions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		userRow.row = { ...CLEARED_ROW };
	});

	it("returns null when nothing is set", async () => {
		const response = await GET(makeGetEvent());
		const body = (await response.json()) as {
			preferences: { personalInstructions: string | null };
		};

		expect(response.status).toBe(200);
		expect(body.preferences.personalInstructions).toBeNull();
	});

	it("returns the stored value", async () => {
		userRow.row = { ...CLEARED_ROW, personalInstructions: "Be terse." };

		const response = await GET(makeGetEvent());
		const body = (await response.json()) as {
			preferences: { personalInstructions: string | null };
		};

		expect(body.preferences.personalInstructions).toBe("Be terse.");
	});
});

describe("PATCH /api/settings/preferences personalInstructions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		userRow.row = { ...CLEARED_ROW };
	});

	it("persists exactly 2,000 characters", async () => {
		const text = "a".repeat(INSTRUCTIONS_MAX_CHARS);
		const response = await PATCH(
			makePatchEvent({ personalInstructions: text }),
		);

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ personalInstructions: text }),
		);
	});

	it("persists exactly 2,000 Hungarian accented characters", async () => {
		const text = "ő".repeat(INSTRUCTIONS_MAX_CHARS);
		const response = await PATCH(
			makePatchEvent({ personalInstructions: text }),
		);

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ personalInstructions: text }),
		);
	});

	it("rejects 2,001 characters with a 400 and writes nothing", async () => {
		const response = await PATCH(
			makePatchEvent({
				personalInstructions: "a".repeat(INSTRUCTIONS_MAX_CHARS + 1),
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "Instructions are too long",
		});
		expect(updateSet).not.toHaveBeenCalled();
	});

	it("measures emoji in code points, not UTF-16 units", async () => {
		// 1,001 emoji is 2,002 UTF-16 units but only 1,001 code points.
		const accepted = await PATCH(
			makePatchEvent({ personalInstructions: "👍".repeat(1001) }),
		);
		expect(accepted.status).toBe(200);

		vi.clearAllMocks();
		const rejected = await PATCH(
			makePatchEvent({
				personalInstructions: "👍".repeat(INSTRUCTIONS_MAX_CHARS + 1),
			}),
		);
		expect(rejected.status).toBe(400);
		expect(updateSet).not.toHaveBeenCalled();
	});

	it("turns an empty string into an explicit clear", async () => {
		const response = await PATCH(makePatchEvent({ personalInstructions: "" }));

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ personalInstructions: null }),
		);
	});

	it("turns whitespace-only text into an explicit clear", async () => {
		const response = await PATCH(
			makePatchEvent({ personalInstructions: "   \n\t " }),
		);

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ personalInstructions: null }),
		);
	});

	it("rejects a non-string value", async () => {
		const response = await PATCH(makePatchEvent({ personalInstructions: 42 }));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "Invalid personalInstructions",
		});
		expect(updateSet).not.toHaveBeenCalled();
	});

	it("leaves the column untouched when the field is absent", async () => {
		const response = await PATCH(makePatchEvent({ theme: "dark" }));

		expect(response.status).toBe(200);
		expect(updateSet).toHaveBeenCalledWith(
			expect.not.objectContaining({ personalInstructions: expect.anything() }),
		);
	});
});
