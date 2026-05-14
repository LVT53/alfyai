import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	SkillSessionError: class SkillSessionError extends Error {
		constructor(
			public code: string,
			message: string,
			public status = 400,
		) {
			super(message);
		}
	},
	endSkillSession: vi.fn(),
	serializePublicSkillSession: (session: any) => {
		if (!session) return null;
		const { skillInstructions: _skillInstructions, ...publicSession } = session;
		return publicSession;
	},
	startSkillSession: vi.fn(),
}));

import { DELETE, POST } from "./+server";
import { requireAuth } from "$lib/server/auth/hooks";
import { endSkillSession, startSkillSession } from "$lib/server/services/skills/sessions";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockStartSkillSession = startSkillSession as ReturnType<typeof vi.fn>;
const mockEndSkillSession = endSkillSession as ReturnType<typeof vi.fn>;

function makeEvent(method: string, body: unknown, user = { id: "user-1" }, id = "conv-1") {
	return {
		request: new Request(`http://localhost/api/conversations/${id}/skill-sessions`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}/skill-sessions`),
		route: { id: "/api/conversations/[id]/skill-sessions" },
	} as any;
}

describe("/api/conversations/[id]/skill-sessions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockStartSkillSession.mockResolvedValue({
			id: "session-1",
			conversationId: "conv-1",
			userId: "user-1",
			status: "active",
			skillOwnership: "system",
			skillDisplayName: "Meeting critic",
			skillInstructions: "SYSTEM_SENTINEL: never expose this instruction body",
		});
		mockEndSkillSession.mockResolvedValue({
			id: "session-1",
			conversationId: "conv-1",
			userId: "user-1",
			status: "ended",
			endReason: "dismissed",
			skillDisplayName: "Meeting critic",
		});
	});

	it("starts a skill session from the pending skill payload", async () => {
		const response = await POST(
			makeEvent("POST", {
				pendingSkill: {
					id: "skill-1",
					ownership: "system",
					displayName: "Meeting critic",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockStartSkillSession).toHaveBeenCalledWith("user-1", "conv-1", {
			id: "skill-1",
			ownership: "system",
			displayName: "Meeting critic",
		});
		expect(data.activeSkillSession).toMatchObject({
			id: "session-1",
			status: "active",
		});
		expect(data.activeSkillSession).not.toHaveProperty("skillInstructions");
		expect(JSON.stringify(data)).not.toContain("SYSTEM_SENTINEL");
	});

	it("ends the current skill session with a dismiss reason", async () => {
		const response = await DELETE(makeEvent("DELETE", { reason: "dismissed" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockEndSkillSession).toHaveBeenCalledWith("user-1", "conv-1", "dismissed");
		expect(data.activeSkillSession).toBeNull();
		expect(data.endedSkillSession).toMatchObject({
			id: "session-1",
			status: "ended",
			endReason: "dismissed",
		});
	});
});
