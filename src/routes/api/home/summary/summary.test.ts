import { beforeEach, describe, expect, it, vi } from "vitest";

// The write is mocked; the key validator is not — it is part of what this
// endpoint's contract is, so the tests below exercise the real one.
vi.mock("$lib/server/services/home-suggestions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/server/services/home-suggestions")
	>()),
	recordHomeSuggestionEvent: vi.fn(),
}));

vi.mock("$lib/server/services/home-summary", () => ({
	getHomeSummary: vi.fn(),
	invalidateHomeSummary: vi.fn(),
}));

import { _resetHomeSuggestionEventRateLimitForTests } from "$lib/server/services/home-suggestion-rate-limit";
import { recordHomeSuggestionEvent } from "$lib/server/services/home-suggestions";
import {
	getHomeSummary,
	invalidateHomeSummary,
} from "$lib/server/services/home-summary";
import { GET, POST } from "./+server";

const mockRecord = vi.mocked(recordHomeSuggestionEvent);
const mockGet = vi.mocked(getHomeSummary);
const mockInvalidate = vi.mocked(invalidateHomeSummary);

function makeEvent(
	body: unknown,
	user: { id: string } | null = { id: "user-1" },
) {
	return {
		locals: { user: user ? { ...user, role: "user" } : null },
		params: {},
		request: new Request("http://localhost/api/home/summary", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
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
	suggestions: [],
	generatedAt: 0,
};

describe("GET /api/home/summary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetHomeSuggestionEventRateLimitForTests();
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
		_resetHomeSuggestionEventRateLimitForTests();
		mockRecord.mockResolvedValue(undefined);
	});

	it("records the event against the SESSION user, never a body field", async () => {
		const response = await POST(
			makeEvent(
				{ candidateKey: "atlas:job-1", event: "used", userId: "someone-else" },
				{ id: "user-1" },
			),
		);

		expect(response.status).toBe(200);
		expect(mockRecord).toHaveBeenCalledWith({
			userId: "user-1",
			candidateKey: "atlas:job-1",
			event: "used",
		});
	});

	it("drops the cached summary so an acted-on chip cannot come back", async () => {
		await POST(makeEvent({ candidateKey: "atlas:job-1", event: "dismissed" }));
		expect(mockInvalidate).toHaveBeenCalledWith("user-1");
	});

	it("rejects an event kind that is not one of the three", async () => {
		const response = await POST(
			makeEvent({ candidateKey: "atlas:job-1", event: "deleted" }),
		);
		expect(response.status).toBe(400);
		expect(mockRecord).not.toHaveBeenCalled();
	});

	it("rejects a missing or blank candidate key", async () => {
		expect((await POST(makeEvent({ event: "used" }))).status).toBe(400);
		expect(
			(await POST(makeEvent({ candidateKey: "   ", event: "used" }))).status,
		).toBe(400);
		expect(mockRecord).not.toHaveBeenCalled();
	});

	it("stores this engine's own keys and nothing else", async () => {
		// Not a check that the object still exists — a deleted job's key must
		// stay storable — but the row must be a key, not a note somebody
		// decided to keep in a table with a seven-day retention.
		for (const candidateKey of [
			"x".repeat(201),
			`atlas:${"x".repeat(200)}`,
			"note: remember to buy milk",
			"invented:job-1",
			"atlas:",
			"just-a-word",
		]) {
			const response = await POST(makeEvent({ candidateKey, event: "used" }));
			expect(response.status).toBe(400);
		}
		expect(mockRecord).not.toHaveBeenCalled();
	});

	it("accepts a key whose object has since been deleted", async () => {
		const response = await POST(
			makeEvent({
				candidateKey: "conversation:11111111-2222-3333-4444-555555555555",
				event: "dismissed",
			}),
		);
		expect(response.status).toBe(200);
		expect(mockRecord).toHaveBeenCalled();
	});

	it("survives a body that is not JSON at all", async () => {
		const event = {
			locals: { user: { id: "user-1", role: "user" } },
			params: {},
			request: new Request("http://localhost/api/home/summary", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json",
			}),
			url: new URL("http://localhost/api/home/summary"),
			route: { id: "/api/home/summary" },
		} as Parameters<typeof POST>[0];

		expect((await POST(event)).status).toBe(400);
		expect(mockRecord).not.toHaveBeenCalled();
	});

	it("stops one account writing seven-day rows without limit", async () => {
		let lastStatus = 0;
		for (let index = 0; index < 40; index += 1) {
			const response = await POST(
				makeEvent({ candidateKey: `atlas:key-${index}`, event: "used" }),
			);
			lastStatus = response.status;
		}
		expect(lastStatus).toBe(429);
		// The cap bites well before forty rows, and the writes that were
		// refused never reached the table.
		expect(mockRecord.mock.calls.length).toBeLessThan(40);
	});

	it("throttles one account without touching another", async () => {
		for (let index = 0; index < 40; index += 1) {
			await POST(
				makeEvent(
					{ candidateKey: `atlas:key-${index}`, event: "used" },
					{ id: "a" },
				),
			);
		}
		const other = await POST(
			makeEvent({ candidateKey: "atlas:key-1", event: "used" }, { id: "b" }),
		);
		expect(other.status).toBe(200);
	});
});
