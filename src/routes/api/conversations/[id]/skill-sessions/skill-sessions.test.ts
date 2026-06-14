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
	serializePublicSkillSession: (session: Record<string, unknown> | null) => {
		if (!session) return null;
		const { skillInstructions: _skillInstructions, ...publicSession } = session;
		return publicSession;
	},
	startSkillSession: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	endSkillSession,
	startSkillSession,
} from "$lib/server/services/skills/sessions";
import { DELETE, POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockStartSkillSession = startSkillSession as ReturnType<typeof vi.fn>;
const mockEndSkillSession = endSkillSession as ReturnType<typeof vi.fn>;
type SkillSessionEvent = Parameters<typeof POST>[0];

function makeEvent(
	method: string,
	body: unknown,
	user = { id: "user-1" },
	id = "conv-1",
): SkillSessionEvent {
	return {
		request: new Request(
			`http://localhost/api/conversations/${id}/skill-sessions`,
			{
				method,
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}/skill-sessions`),
		route: { id: "/api/conversations/[id]/skill-sessions" },
	} as SkillSessionEvent;
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
					skillKind: "skill_pack",
					displayName: "Meeting critic",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockStartSkillSession).toHaveBeenCalledWith("user-1", "conv-1", {
			id: "skill-1",
			ownership: "system",
			skillKind: "skill_pack",
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
		expect(mockEndSkillSession).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"dismissed",
		);
		expect(data.activeSkillSession).toBeNull();
		expect(data.endedSkillSession).toMatchObject({
			id: "session-1",
			status: "ended",
			endReason: "dismissed",
		});
	});

	it("returns typed conflict responses from the session service", async () => {
		mockStartSkillSession.mockRejectedValue(
			new (
				await import("$lib/server/services/skills/sessions")
			).SkillSessionError(
				"active_skill_session_conflict",
				"Another skill session is already active.",
				409,
			),
		);

		const response = await POST(
			makeEvent("POST", {
				pendingSkill: {
					id: "skill-2",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toEqual({
			error: "Another skill session is already active.",
			code: "active_skill_session_conflict",
			errorKey: "skillSessions.errors.activeConflict",
		});
	});
});
