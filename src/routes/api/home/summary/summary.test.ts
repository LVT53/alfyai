import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/home-summary", () => ({
	getHomeSummary: vi.fn(),
	dismissMemoryReviewNotice: vi.fn(),
}));

import {
	dismissMemoryReviewNotice,
	getHomeSummary,
} from "$lib/server/services/home-summary";
import { GET, POST } from "./+server";

const mockGet = vi.mocked(getHomeSummary);
const mockDismissMemoryReview = vi.mocked(dismissMemoryReviewNotice);

function makeEvent(
	body: unknown,
	user: { id: string } | null = { id: "user-1" },
	raw?: string,
) {
	return {
		locals: { user: user ? { ...user, role: "user" } : null },
		params: {},
		request: new Request("http://localhost/api/home/summary", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: raw ?? JSON.stringify(body),
		}),
		url: new URL("http://localhost/api/home/summary"),
		route: { id: "/api/home/summary" },
	} as Parameters<typeof POST>[0];
}

function makeGetEvent(user: { id: string } | null = { id: "user-1" }) {
	return {
		locals: { user: user ? { ...user, role: "user" } : null },
		params: {},
		request: new Request("http://localhost/api/home/summary"),
		url: new URL("http://localhost/api/home/summary"),
		route: { id: "/api/home/summary" },
	} as Parameters<typeof GET>[0];
}

const EMPTY = {
	weekly: [],
	weeklyTotal: 0,
	recent: [],
	running: null,
	projects: [],
	memoryReviewCount: 0,
	memoryReviewNoticeDismissed: false,
	generatedAt: 0,
};

describe("GET /api/home/summary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGet.mockResolvedValue(EMPTY);
	});

	it("reads only the session user's summary", async () => {
		await GET(makeGetEvent({ id: "user-7" }));
		expect(mockGet).toHaveBeenCalledWith({ userId: "user-7" });
	});

	it("forbids any shared cache from holding the payload", async () => {
		const response = await GET(makeGetEvent());
		// It names the user's own conversations, so `no-store` is the point.
		expect(response.headers.get("cache-control")).toContain("private");
		expect(response.headers.get("cache-control")).toContain("no-store");
	});
});

describe("POST /api/home/summary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDismissMemoryReview.mockResolvedValue(undefined);
	});

	it("dismisses the memory review notice for the SESSION user, never a body field", async () => {
		const response = await POST(
			makeEvent(
				{ action: "dismissMemoryReviewNotice", userId: "someone-else" },
				{ id: "user-1" },
			),
		);
		expect(response.status).toBe(200);
		expect(mockDismissMemoryReview).toHaveBeenCalledWith("user-1");
	});

	// Everything else the endpoint used to accept was the suggestion rail's
	// shown/dismissed/used event, and it is gone with the rail. A body that is
	// not the one action must not fall through to a write of any kind.
	it.each([
		[{ candidateKey: "atlas:job-1", event: "used" }],
		[{}],
		[{ action: 42 }],
		[null],
	])("refuses a body that is not the one action", async (body) => {
		const response = await POST(makeEvent(body, { id: "user-1" }));
		expect(response.status).toBe(400);
		expect(mockDismissMemoryReview).not.toHaveBeenCalled();
	});

	it("survives a body that is not JSON at all", async () => {
		const response = await POST(makeEvent(null, { id: "user-1" }, "not json"));
		expect(response.status).toBe(400);
		expect(mockDismissMemoryReview).not.toHaveBeenCalled();
	});
});
