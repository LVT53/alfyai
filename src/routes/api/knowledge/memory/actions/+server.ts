import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	applyKnowledgeMemoryAction,
	MemoryProfileActionError,
} from "$lib/server/services/memory";
import type { RequestHandler } from "./$types";

function hasNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isValidLegacyPayload(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const action = (body as Record<string, unknown>).action;
	const target = (body as Record<string, unknown>).target;
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

/**
 * Validates the newer `kind`-discriminated action envelope
 * (profile_item correct/retire, summary edit, consolidation undo). Returns
 * false for anything that doesn't match one of those shapes, including
 * payloads with no `kind` at all (those fall through to the legacy check).
 */
function isValidV2Payload(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const record = body as Record<string, unknown>;
	if (record.kind === "profile_item") {
		if (
			!hasNonEmptyString(record.itemId) ||
			!Number.isInteger(record.expectedProjectionRevision) ||
			Number(record.expectedProjectionRevision) < 0
		) {
			return false;
		}
		if (record.action === "retire") return true;
		return record.action === "correct" && hasNonEmptyString(record.statement);
	}
	if (record.kind === "summary") {
		return record.action === "edit" && hasNonEmptyString(record.text);
	}
	if (record.kind === "consolidation") {
		return (
			record.action === "undo" &&
			hasNonEmptyString(record.reportId) &&
			Number.isInteger(record.actionIndex) &&
			Number(record.actionIndex) >= 0
		);
	}
	return false;
}

function isValidPayload(body: unknown): boolean {
	if (
		body &&
		typeof body === "object" &&
		"kind" in (body as Record<string, unknown>)
	) {
		return isValidV2Payload(body);
	}
	return isValidLegacyPayload(body);
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
