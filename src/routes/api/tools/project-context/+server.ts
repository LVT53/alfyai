import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { verifyFileProductionServiceAssertion } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { conversations } from "$lib/server/db/schema";
import { getProjectContext } from "$lib/server/services/project-context";
import type { RequestHandler } from "./$types";

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("maxSiblings is invalid");
	}
	return Math.max(1, Math.floor(value));
}

export const POST: RequestHandler = async (event) => {
	const user = event.locals.user ?? null;

	if (!user && !event.request.headers.get("authorization")) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (!body || typeof body !== "object") {
		return json({ error: "Invalid request body" }, { status: 400 });
	}

	const data = body as Record<string, unknown>;
	const conversationId = optionalString(data.conversationId);
	if (!conversationId) {
		return json({ error: "conversationId is required" }, { status: 400 });
	}

	const serviceAssertion =
		user === null
			? verifyFileProductionServiceAssertion(
					event.request.headers.get("authorization"),
				)
			: null;
	if (user === null && !serviceAssertion?.valid) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	if (
		user === null &&
		serviceAssertion?.claims.conversationId !== conversationId
	) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const conversation = await db.query.conversations.findFirst({
		where: eq(conversations.id, conversationId),
	});
	if (!conversation || (user && conversation.userId !== user.id)) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const mode = optionalString(data.mode) ?? "summary";
		if (mode !== "summary") {
			return json(
				{ error: "Only summary mode is supported for project_context" },
				{ status: 400 },
			);
		}

		const result = await getProjectContext({
			userId: conversation.userId,
			conversationId,
			mode,
			query: optionalString(data.query) ?? null,
			maxSiblings: optionalPositiveInt(data.maxSiblings),
			includeEvidenceCandidates:
				typeof data.includeEvidenceCandidates === "boolean"
					? data.includeEvidenceCandidates
					: undefined,
		});
		return json(result);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Project context lookup failed";
		const status = /invalid|required|supported/.test(message) ? 400 : 500;
		return json({ error: message }, { status });
	}
};
