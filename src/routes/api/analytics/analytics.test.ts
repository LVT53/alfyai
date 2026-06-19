import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "$lib/types";

const mocks = vi.hoisted(() => ({
	getAnalyticsDashboardReadModel: vi.fn(),
}));

vi.mock("$lib/server/services/analytics", () => ({
	getAnalyticsDashboardReadModel: mocks.getAnalyticsDashboardReadModel,
}));

import { GET } from "./+server";

const analyticsResponse = {
	personal: {
		byModel: [],
		byProvider: [],
		totalMessages: 0,
		avgGenerationMs: 0,
		promptTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		totalCostUsd: 0,
		favoriteModel: null,
		chatCount: 0,
		monthly: [],
	},
	availableMonths: [],
};

function user(overrides: Partial<SessionUser> = {}): SessionUser {
	return {
		id: "user-1",
		email: "user@example.com",
		displayName: "User",
		role: "user",
		avatarId: null,
		profilePicture: null,
		titleLanguage: "auto",
		uiLanguage: "en",
		...overrides,
	};
}

function event(url: string, sessionUser: SessionUser | null = user()) {
	return {
		url: new URL(url),
		locals: { user: sessionUser },
	} as Parameters<typeof GET>[0];
}

describe("GET /api/analytics", () => {
	beforeEach(() => {
		mocks.getAnalyticsDashboardReadModel.mockReset();
		mocks.getAnalyticsDashboardReadModel.mockResolvedValue(analyticsResponse);
	});

	it("requires authentication", async () => {
		await expect(
			GET(event("http://localhost/api/analytics", null)),
		).rejects.toMatchObject({
			status: 302,
			location: "/login",
		});

		expect(mocks.getAnalyticsDashboardReadModel).not.toHaveBeenCalled();
	});

	it("parses dashboard parameters and passes the authenticated user to the service", async () => {
		const admin = user({ id: "admin-1", role: "admin" });
		const response = await GET(
			event(
				"http://localhost/api/analytics?mock=1&month=2026-05&systemMonth=2026-06&timeline=weekly",
				admin,
			),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(analyticsResponse);
		expect(mocks.getAnalyticsDashboardReadModel).toHaveBeenCalledWith({
			user: admin,
			mock: true,
			month: "2026-05",
			systemMonth: "2026-06",
			timeline: "weekly",
		});
	});

	it("passes null optional parameters and only treats mock=1 as mock data", async () => {
		const response = await GET(event("http://localhost/api/analytics?mock=true"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(analyticsResponse);
		expect(mocks.getAnalyticsDashboardReadModel).toHaveBeenCalledWith({
			user: expect.objectContaining({ id: "user-1", role: "user" }),
			mock: false,
			month: null,
			systemMonth: null,
			timeline: null,
		});
	});
});
