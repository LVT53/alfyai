import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$lib/server/auth/hooks";
import type { PendingSkillSelection } from "$lib/types";
import {
	endSkillSession,
	serializePublicSkillSession,
	SkillSessionError,
	startSkillSession,
} from "$lib/server/services/skills/sessions";

function parsePendingSkill(value: unknown): PendingSkillSelection | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.id !== "string" ||
		(candidate.ownership !== "user" && candidate.ownership !== "system") ||
		typeof candidate.displayName !== "string"
	) {
		return null;
	}
	return {
		id: candidate.id,
		ownership: candidate.ownership,
		displayName: candidate.displayName,
	};
}

function skillSessionErrorResponse(error: unknown) {
	if (error instanceof SkillSessionError) {
		return json({ error: error.message, code: error.code }, { status: error.status });
	}
	console.error("[SKILL_SESSIONS] Request failed:", error);
	return json({ error: "Failed to update skill session" }, { status: 500 });
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const body = await event.request.json().catch(() => null);
	const pendingSkill = parsePendingSkill((body as Record<string, unknown> | null)?.pendingSkill);
	if (!pendingSkill) {
		return json({ error: "pendingSkill is required" }, { status: 400 });
	}

	try {
		const activeSkillSession = await startSkillSession(user.id, event.params.id, pendingSkill);
		return json({ activeSkillSession: serializePublicSkillSession(activeSkillSession) });
	} catch (error) {
		return skillSessionErrorResponse(error);
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const body = await event.request.json().catch(() => ({}));
	const reason = (body as Record<string, unknown> | null)?.reason === "dismissed" ? "dismissed" : "ended";

	try {
		const endedSkillSession = await endSkillSession(user.id, event.params.id, reason);
		return json({
			activeSkillSession: null,
			endedSkillSession: serializePublicSkillSession(endedSkillSession),
		});
	} catch (error) {
		return skillSessionErrorResponse(error);
	}
};
