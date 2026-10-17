import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/announcement-campaigns", () => ({
	getEligibleFeatureNoteForUser: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getEligibleFeatureNoteForUser } from "$lib/server/services/announcement-campaigns";
import {
	registerActiveChatStream,
	unregisterActiveChatStream,
} from "$lib/server/services/chat-turn/active-streams";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetEligibleFeatureNoteForUser =
	getEligibleFeatureNoteForUser as ReturnType<typeof vi.fn>;

const NOTE = {
	id: "note-1",
	name: "Two-factor authentication",
	snapshotId: "note-1-snapshot",
	title: {
		en: "Two-factor authentication",
		hu: "Kétfaktoros hitelesítés",
	},
	body: {
		en: "Add a second step to signing in.",
		hu: "Adj egy második lépést a belépéshez.",
	},
	actionLabel: { en: "", hu: "" },
	actionDestination: null,
	publishedAt: new Date("2026-10-17T10:00:00.000Z"),
};

function makeEvent() {
	return {
		request: new Request("http://localhost/api/campaigns/feature-note"),
		locals: { user: { id: "viewer-user", role: "user" } },
		params: {},
		url: new URL("http://localhost/api/campaigns/feature-note"),
		route: { id: "/api/campaigns/feature-note" },
	};
}

type RouteEvent = Parameters<typeof GET>[0];

describe("GET /api/campaigns/feature-note", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns the current reader's eligible note", async () => {
		mockGetEligibleFeatureNoteForUser.mockResolvedValue(NOTE);

		const response = await GET(makeEvent() as unknown as RouteEvent);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			note: {
				id: "note-1",
				name: "Two-factor authentication",
				snapshotId: "note-1-snapshot",
				title: {
					en: "Two-factor authentication",
					hu: "Kétfaktoros hitelesítés",
				},
				actionDestination: null,
			},
		});
		expect(mockGetEligibleFeatureNoteForUser).toHaveBeenCalledWith(
			"viewer-user",
		);
	});

	it("returns no note when the service finds none", async () => {
		mockGetEligibleFeatureNoteForUser.mockResolvedValue(null);

		const response = await GET(makeEvent() as unknown as RouteEvent);

		expect(await response.json()).toEqual({ note: null });
	});

	// An announcement never interrupts a turn: the note is offered on the next
	// landing arrival once the answer is done.
	it("offers nothing while the account has a turn running", async () => {
		mockGetEligibleFeatureNoteForUser.mockResolvedValue(NOTE);
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "feature-note-route-stream",
			userId: "viewer-user",
			controller,
			conversationId: "conversation-1",
		});

		try {
			const during = await GET(makeEvent() as unknown as RouteEvent);
			expect(await during.json()).toEqual({ note: null });
			expect(mockGetEligibleFeatureNoteForUser).not.toHaveBeenCalled();
		} finally {
			unregisterActiveChatStream("feature-note-route-stream", controller);
		}

		const after = await GET(makeEvent() as unknown as RouteEvent);
		expect(await after.json()).toMatchObject({ note: { id: "note-1" } });
	});

	it("refuses an unauthenticated request", async () => {
		mockRequireAuth.mockImplementation(() => {
			throw new Error("Unauthorized");
		});

		await expect(GET(makeEvent() as unknown as RouteEvent)).rejects.toThrow(
			"Unauthorized",
		);
		expect(mockGetEligibleFeatureNoteForUser).not.toHaveBeenCalled();
	});
});
