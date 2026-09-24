import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	type InstructionScope,
	normalizeInstructionText,
} from "$lib/shared/instructions";
import { getConversationProjectId, getProjectInstructions } from "./projects";

/**
 * The standing guidance that applies to one turn, resolved once and consumed
 * by prompt assembly, the message audit metadata, and the data archive.
 *
 * This is a service boundary of its own because the two scopes of standing
 * guidance live in two different tables: personal instructions are a column on
 * the user row, and (Slice D) project instructions are a column on the
 * project's row, reached through the conversation. Every consumer wants the
 * same pair, resolved the same way, so the read belongs in one place.
 */
export interface ResolvedTurnInstructions {
	/** Trimmed personal text, or null when unset. */
	personal: string | null;
	/** Present only when the conversation has a project with instructions. */
	project: { id: string; name: string; text: string } | null;
}

/**
 * One read of the user row plus one read of the conversation's project.
 * Returns nulls rather than throwing when nothing is set: "no instructions" is
 * the ordinary case, not a failure.
 *
 * Nothing is cached between turns. The conversation's project is read from the
 * conversation's own row each time, so moving a conversation into a project —
 * or out of one, or into a different one — changes the next turn's block
 * without anything having to notice the move and invalidate a copy.
 */
export async function resolveTurnInstructions(params: {
	userId: string;
	conversationId: string;
}): Promise<ResolvedTurnInstructions> {
	// The two reads are independent: which project the conversation is in does
	// not depend on the personal text, and neither of them writes.
	const [personal, projectId] = await Promise.all([
		getInstructionText(params.userId, { kind: "personal" }),
		getConversationProjectId(params.userId, params.conversationId),
	]);

	return {
		personal,
		project: projectId
			? await resolveProjectInstructions(params.userId, projectId)
			: null,
	};
}

/**
 * The project block itself: present only when the project has text. A project
 * with none is a folder, and a heading with framing about nothing is worse
 * than no section at all.
 */
async function resolveProjectInstructions(
	userId: string,
	projectId: string,
): Promise<ResolvedTurnInstructions["project"]> {
	const project = await getProjectInstructions(userId, projectId);
	if (!project?.text) return null;

	return { id: project.id, name: project.name, text: project.text };
}

/** For Settings, the project page and the data archive. */
export async function getInstructionText(
	userId: string,
	scope: InstructionScope,
): Promise<string | null> {
	if (scope.kind === "project") {
		if (!scope.projectId) return null;

		const project = await getProjectInstructions(userId, scope.projectId);
		return project?.text ?? null;
	}

	const rows = await db
		.select({ personalInstructions: users.personalInstructions })
		.from(users)
		.where(eq(users.id, userId));

	return normalizeInstructionText(rows[0]?.personalInstructions ?? "");
}
