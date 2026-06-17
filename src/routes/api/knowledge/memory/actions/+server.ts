import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	MemoryProfileActionError,
	applyKnowledgeMemoryAction,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

function isValidPayload(body: unknown): body is
	| {
			target?: "profile_item";
			action: "delete";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target?: "profile_item";
			action: "suppress";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target?: "profile_item";
			action: "edit";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "accept";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "suppress";
			itemId: string;
			expectedProjectionRevision: number;
	  }
	| {
			target: "review_item";
			action: "edit";
			itemId: string;
			statement: string;
			expectedProjectionRevision: number;
	  } {
	if (!body || typeof body !== "object") return false;
	const action = (body as Record<string, unknown>).action;
	const target = (body as Record<string, unknown>).target;
	const hasNonEmptyString = (value: unknown) =>
		typeof value === "string" && value.trim().length > 0;
	const expectedProjectionRevision = (body as Record<string, unknown>)
		.expectedProjectionRevision;
	if (
		!hasNonEmptyString((body as Record<string, unknown>).itemId) ||
		!Number.isInteger(expectedProjectionRevision) ||
		Number(expectedProjectionRevision) < 0
	) {
		return false;
	}
	if (
		target !== undefined &&
		target !== "profile_item" &&
		target !== "review_item"
	) {
		return false;
	}
	if (target === "review_item") {
		if (action === "accept" || action === "suppress") return true;
		return (
			action === "edit" &&
			hasNonEmptyString((body as Record<string, unknown>).statement)
		);
	}
	if (action === "delete" || action === "suppress") return true;
	return (
		action === "edit" &&
		hasNonEmptyString((body as Record<string, unknown>).statement)
	);
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await event.request.json().catch(() => null);
	if (!isValidPayload(body)) {
		return json({ error: "Invalid memory action payload" }, { status: 400 });
	}

	try {
		const memory = await applyKnowledgeMemoryAction(
			user.id,
			user.displayName,
			body,
		);
		return json(memory);
	} catch (error) {
		if (error instanceof MemoryProfileActionError) {
			return json(
				{
					error: error.message,
					code: error.code,
				},
				{ status: error.status },
			);
		}
		console.error("[KNOWLEDGE_MEMORY] Failed to apply memory action:", error);
		return json({ error: "Failed to update memory profile" }, { status: 500 });
	}
};
