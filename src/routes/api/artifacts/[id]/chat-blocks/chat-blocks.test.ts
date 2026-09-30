import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts", () => ({
	listCanvasChatBlocks: vi.fn(),
}));

import { listCanvasChatBlocks } from "$lib/server/services/artifacts";
import { GET } from "./+server";

const mockList = listCanvasChatBlocks as ReturnType<typeof vi.fn>;

function makeEvent(
	id = "board-1",
	userId: string | null = "owner-user",
	conversationId: string | null = null,
) {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}/chat-blocks${query}`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

const LISTING = {
	files: [
		{
			key: "file:f1",
			at: 1,
			origin: "produced",
			version: null,
			data: {
				kind: "file",
				fileId: "f1",
				name: "trip.pdf",
				mime: "application/pdf",
				bytes: 10,
				label: "PDF",
			},
		},
	],
	apps: [],
	maps: [],
	charts: [],
	photos: [],
	searches: [],
};

describe("GET /api/artifacts/[id]/chat-blocks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no authenticated user (ruling 39), and reads nothing", async () => {
		await expect(GET(makeEvent("board-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockList).not.toHaveBeenCalled();
	});

	it("answers not_found, never confirming existence, for a board out of scope", async () => {
		mockList.mockResolvedValue(null);

		const response = await GET(makeEvent());

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("answers the same bytes for a missing id and a foreign one", async () => {
		mockList.mockResolvedValue(null);
		const missing = await GET(makeEvent("no-such-board"));
		const foreign = await GET(makeEvent("someone-elses-board"));
		expect(await missing.text()).toBe(await foreign.text());
		expect(missing.status).toBe(foreign.status);
	});

	it("answers the listing, ok: true (ruling 49), scoped to the caller and the chat the read names", async () => {
		mockList.mockResolvedValue(LISTING);

		const response = await GET(makeEvent("board-1", "owner-user", "conv-1"));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, ...LISTING });
		expect(mockList).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "board-1",
			conversationId: "conv-1",
		});
	});

	it("asks with no conversation when the read names none", async () => {
		mockList.mockResolvedValue(LISTING);
		await GET(makeEvent());
		expect(mockList).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "board-1",
			conversationId: null,
		});
	});
});
