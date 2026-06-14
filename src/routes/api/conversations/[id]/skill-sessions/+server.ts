import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	endSkillSession,
	SkillSessionError,
	serializePublicSkillSession,
	startSkillSession,
} from "$lib/server/services/skills/sessions";
import type { PendingSkillSelection } from "$lib/types";
import type { RequestHandler } from "./$types";

function parsePendingSkill(value: unknown): PendingSkillSelection | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	const skillKind =
		candidate.skillKind === "user_skill" ||
		candidate.skillKind === "skill_pack" ||
		candidate.skillKind === "skill_variant"
			? candidate.skillKind
			: undefined;
	if (
		typeof candidate.id !== "string" ||
		(candidate.ownership !== "user" && candidate.ownership !== "system") ||
		typeof candidate.displayName !== "string" ||
		("skillKind" in candidate && !skillKind)
	) {
		return null;
	}
	return {
		id: candidate.id,
		ownership: candidate.ownership,
		...(skillKind ? { skillKind } : {}),
		displayName: candidate.displayName,
	};
}

function skillSessionErrorResponse(error: unknown) {
	if (error instanceof SkillSessionError) {
		return json(
			{
				error: error.message,
				code: error.code,
				errorKey:
					error.code === "active_skill_session_conflict"
						? "skillSessions.errors.activeConflict"
						: undefined,
			},
			{ status: error.status },
		);
	}
	console.error("[SKILL_SESSIONS] Request failed:", error);
	return json({ error: "Failed to update skill session" }, { status: 500 });
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const body = await event.request.json().catch(() => null);
	const pendingSkill = parsePendingSkill(
		(body as Record<string, unknown> | null)?.pendingSkill,
	);
	if (!pendingSkill) {
		return json({ error: "pendingSkill is required" }, { status: 400 });
	}

	try {
		const activeSkillSession = await startSkillSession(
			user.id,
			event.params.id,
			pendingSkill,
		);
		return json({
			activeSkillSession: serializePublicSkillSession(activeSkillSession),
		});
	} catch (error) {
		return skillSessionErrorResponse(error);
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const body = await event.request.json().catch(() => ({}));
	const reason =
		(body as Record<string, unknown> | null)?.reason === "dismissed"
			? "dismissed"
			: "ended";

	try {
		const endedSkillSession = await endSkillSession(
			user.id,
			event.params.id,
			reason,
		);
		return json({
			activeSkillSession: null,
			endedSkillSession: serializePublicSkillSession(endedSkillSession),
		});
	} catch (error) {
		return skillSessionErrorResponse(error);
	}
};
