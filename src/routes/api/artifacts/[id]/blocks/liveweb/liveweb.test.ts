import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	searchCanvasLiveWeb: vi.fn(),
	canvasWebFailureStatus: (reason: string) =>
		({
			not_found: 404,
			invalid_query: 400,
			rate_limited: 429,
		})[reason] ?? 422,
}));

import { searchCanvasLiveWeb } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockSearch = searchCanvasLiveWeb as ReturnType<typeof vi.fn>;

const DATA = {
	kind: "liveweb",
	query: "cork weather",
	sources: [],
	fetchedAt: 1,
};

function makeEvent(
	options: {
		id?: string;
		userId?: string | null;
		conversationId?: string | null;
		body?: string | null;
		headers?: Record<string, string>;
		signal?: AbortSignal;
	} = {},
) {
	const {
		id = "board-1",
		userId = "owner-user",
		conversationId = null,
		body = JSON.stringify({ query: "cork weather" }),
		headers = { "content-type": "application/json" },
		signal,
	} = options;
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	const url = `http://localhost/api/artifacts/${id}/blocks/liveweb${query}`;
	const request = new Request(url, {
		method: "POST",
		headers,
		body,
		...(signal ? { signal } : {}),
	});
	return {
		params: { id },
		url: new URL(url),
		request,
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

describe("POST /api/artifacts/[id]/blocks/liveweb", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user (ruling 39), and searches nothing", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockSearch).not.toHaveBeenCalled();
	});

	it("answers the snapshot a new live-web block starts from", async () => {
		mockSearch.mockResolvedValue({ ok: true, data: DATA });

		const response = await POST(makeEvent());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, data: DATA });
	});

	it("hands the service the reader, the board, the scope, the query from the body and the request's own signal", async () => {
		mockSearch.mockResolvedValue({ ok: true, data: DATA });
		const controller = new AbortController();

		await POST(
			makeEvent({
				id: "board-7",
				conversationId: "conv-9",
				body: JSON.stringify({
					query: "  what to pack  ",
					url: "https://evil.example",
					sources: [],
				}),
				signal: controller.signal,
			}),
		);

		expect(mockSearch).toHaveBeenCalledTimes(1);
		const params = mockSearch.mock.calls[0][0];
		expect(params).toEqual({
			userId: "owner-user",
			artifactId: "board-7",
			conversationId: "conv-9",
			// The route passes the query as written; the service decides what a valid one is.
			query: "  what to pack  ",
			signal: params.signal,
		});
		expect(params.signal).toBeInstanceOf(AbortSignal);
		// Nothing else of the body reaches the service: no address, no sources.
		expect(Object.keys(params).sort()).toEqual(
			["artifactId", "conversationId", "query", "signal", "userId"].sort(),
		);
	});

	it("refuses a body the size of a query without reading it, and one that only turns out large when read", async () => {
		const huge = JSON.stringify({ query: "x".repeat(8 * 1024) });
		const declared = await POST(
			makeEvent({
				body: huge,
				headers: {
					"content-type": "application/json",
					"content-length": String(huge.length),
				},
			}),
		);
		expect(declared.status).toBe(413);
		await expect(declared.json()).resolves.toEqual({
			ok: false,
			reason: "too_large",
		});

		const undeclared = await POST(makeEvent({ body: huge }));
		expect(undeclared.status).toBe(413);
		expect(mockSearch).not.toHaveBeenCalled();
	});

	it("says invalid_query for a body that is not JSON, not an object, or has no text query, and searches nothing", async () => {
		for (const body of ["not json", "[]", "null", "42", '"a string"', ""]) {
			const response = await POST(makeEvent({ body }));
			expect(response.status, body).toBe(400);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				reason: "invalid_query",
			});
		}
		expect(mockSearch).not.toHaveBeenCalled();
	});

	it("passes a body with no query through as no query, for the service to refuse by its own rules", async () => {
		mockSearch.mockResolvedValue({ ok: false, reason: "invalid_query" });
		const response = await POST(
			makeEvent({ body: JSON.stringify({ q: "x" }) }),
		);
		expect(mockSearch.mock.calls[0][0].query).toBeUndefined();
		expect(response.status).toBe(400);
	});

	it("answers each failure with its own status and reason, the same bytes for a board out of reach, and a wait for one asked too often", async () => {
		for (const [reason, status] of [
			["not_found", 404],
			["invalid_query", 400],
			["refresh_failed", 422],
			["no_results", 422],
		] as const) {
			mockSearch.mockResolvedValueOnce({ ok: false, reason });
			const response = await POST(makeEvent());
			expect(response.status, reason).toBe(status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
		}
		mockSearch.mockResolvedValue({ ok: false, reason: "not_found" });
		const missing = await POST(makeEvent({ id: "no-such-board" }));
		const foreign = await POST(makeEvent({ id: "someone-elses-board" }));
		expect(await missing.text()).toBe(await foreign.text());

		mockSearch.mockResolvedValue({
			ok: false,
			reason: "rate_limited",
			retryAfterSeconds: 9,
		});
		const tooOften = await POST(makeEvent());
		expect(tooOften.status).toBe(429);
		expect(tooOften.headers.get("retry-after")).toBe("9");
	});

	it("keeps the query out of everything it answers", async () => {
		mockSearch.mockResolvedValue({ ok: false, reason: "refresh_failed" });
		const response = await POST(
			makeEvent({ body: JSON.stringify({ query: "my private question" }) }),
		);
		const text = await response.text();
		expect(text).not.toContain("private");
		expect([...response.headers.values()].join(" ")).not.toContain("private");
	});
});
