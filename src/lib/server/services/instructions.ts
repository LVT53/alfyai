import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	type InstructionScope,
	normalizeInstructionText,
} from "$lib/shared/instructions";

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
 * One read of the user row plus (Slice D) one read of the conversation's
 * project. Returns nulls rather than throwing when nothing is set: "no
 * instructions" is the ordinary case, not a failure.
 */
export async function resolveTurnInstructions(params: {
	userId: string;
	conversationId: string;
}): Promise<ResolvedTurnInstructions> {
	const personal = await getInstructionText(params.userId, {
		kind: "personal",
	});

	return {
		personal,
		// Slice D resolves this from the conversation's project. The field is
		// part of the contract now so that prompt assembly, the audit metadata,
		// and the archive do not change shape when it starts returning a value.
		project: null,
	};
}

/** For Settings, the project page and the data archive. */
export async function getInstructionText(
	userId: string,
	scope: InstructionScope,
): Promise<string | null> {
	if (scope.kind === "project") {
		// Projects do not carry instructions yet (Slice D). Returning null is the
		// true answer; reading the user's personal text and labelling it as the
		// project's would be a wrong answer that looks like a right one.
		return null;
	}

	const rows = await db
		.select({ personalInstructions: users.personalInstructions })
		.from(users)
		.where(eq(users.id, userId));

	return normalizeInstructionText(rows[0]?.personalInstructions ?? "");
}
