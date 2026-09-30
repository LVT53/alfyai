import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	refreshCanvasLiveWeb: vi.fn(),
	canvasWebFailureStatus: (reason: string) =>
		({
			not_found: 404,
			invalid_query: 400,
			rate_limited: 429,
		})[reason] ?? 422,
}));

import { refreshCanvasLiveWeb } from "$lib/server/services/artifacts";
import { POST } from "./+server";

const mockRefresh = refreshCanvasLiveWeb as ReturnType<typeof vi.fn>;

const DATA = {
	kind: "liveweb",
	query: "weather in Salzburg",
	sources: [],
	fetchedAt: 1,
};

/**
 * A request whose every part but its abort signal explodes when touched: the
 * route must take the block's id from the ADDRESS and nothing from the client's
 * body, headers or cookies-by-header. (The user comes from `locals`.)
 */
function makeEvent(
	options: {
		id?: string;
		nodeId?: string;
		userId?: string | null;
		conversationId?: string | null;
		signal?: AbortSignal;
	} = {},
) {
	const {
		id = "board-1",
		nodeId = "web-1",
		userId = "owner-user",
		conversationId = null,
		signal = new AbortController().signal,
	} = options;
	const request = new Proxy(
		{ signal },
		{
			get(target, key) {
				if (key === "signal") return target.signal;
				if (key === "then") return undefined;
				throw new Error(`the route read request.${String(key)}`);
			},
		},
	);
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id, nodeId },
		url: new URL(
			`http://localhost/api/artifacts/${id}/blocks/${nodeId}/refresh${query}`,
		),
		request,
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

describe("POST /api/artifacts/[id]/blocks/[nodeId]/refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user (ruling 39), and searches nothing", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockRefresh).not.toHaveBeenCalled();
	});

	it("answers the block's new snapshot", async () => {
		mockRefresh.mockResolvedValue({ ok: true, nodeId: "web-1", data: DATA });

		const response = await POST(makeEvent());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			nodeId: "web-1",
			data: DATA,
		});
	});

	it("hands the service the reader, the board, the block and the scope from the ADDRESS, and the request's own signal — never anything the client sent", async () => {
		mockRefresh.mockResolvedValue({ ok: true, nodeId: "web 1", data: DATA });
		const controller = new AbortController();

		await POST(
			makeEvent({
				id: "board-7",
				nodeId: "web 1",
				conversationId: "conv-9",
				signal: controller.signal,
			}),
		);

		expect(mockRefresh).toHaveBeenCalledTimes(1);
		expect(mockRefresh).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "board-7",
			nodeId: "web 1",
			conversationId: "conv-9",
			signal: controller.signal,
		});
	});

	it("never reads the request's body, headers or form: reading any of them throws here, and the route does not", async () => {
		mockRefresh.mockResolvedValue({ ok: true, nodeId: "web-1", data: DATA });
		await expect(POST(makeEvent())).resolves.toBeInstanceOf(Response);
	});

	it("does not so much as mention a request body in its source", () => {
		const source = readFileSync(
			path.join(import.meta.dirname, "+server.ts"),
			"utf8",
		);
		for (const forbidden of [
			".json(",
			".text(",
			".formData(",
			".arrayBuffer(",
			".blob(",
			".body",
			"request.headers",
		]) {
			expect(source, forbidden).not.toContain(forbidden);
		}
	});

	it("answers each failure with its own status and reason, and the same bytes for a board out of reach whatever the reason for it", async () => {
		const cases: [string, number][] = [
			["not_found", 404],
			["not_refreshable", 422],
			["refresh_failed", 422],
			["no_results", 422],
		];
		for (const [reason, status] of cases) {
			mockRefresh.mockResolvedValueOnce({ ok: false, reason });
			const response = await POST(makeEvent());
			expect(response.status, reason).toBe(status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
		}
		mockRefresh.mockResolvedValue({ ok: false, reason: "not_found" });
		const missing = await POST(makeEvent({ id: "no-such-board" }));
		const foreign = await POST(makeEvent({ id: "someone-elses-board" }));
		expect(await missing.text()).toBe(await foreign.text());
	});

	it("tells a reader who searched too often how long to wait, in the header and in seconds", async () => {
		mockRefresh.mockResolvedValue({
			ok: false,
			reason: "rate_limited",
			retryAfterSeconds: 17,
		});

		const response = await POST(makeEvent());

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("17");
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "rate_limited",
		});
	});

	it("says nothing else about a failure: no provider message, no query", async () => {
		mockRefresh.mockResolvedValue({
			ok: false,
			reason: "refresh_failed",
			detail: "401 sk-live-123 weather in Salzburg",
		});
		const text = await (await POST(makeEvent())).text();
		expect(text).not.toMatch(/sk-live|Salzburg|401/);
	});
});
