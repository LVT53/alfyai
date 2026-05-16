import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { verifyServiceAssertion } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { conversations } from "$lib/server/db/schema";
import {
	type ResearchFreshness,
	type ResearchMode,
	type ResearchSourcePolicy,
	researchWeb,
} from "$lib/server/services/web-research";
import type { RequestHandler } from "./$types";

const MODES = new Set<ResearchMode>(["quick", "research", "exact"]);
const FRESHNESS = new Set<ResearchFreshness>([
	"auto",
	"live",
	"recent",
	"cache",
]);
const SOURCE_POLICIES = new Set<ResearchSourcePolicy>([
	"general",
	"technical",
	"news",
	"commerce",
	"medical_legal_financial",
]);

function optionalEnum<T extends string>(
	value: unknown,
	allowed: Set<T>,
	fieldName: string,
): T | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !allowed.has(value as T)) {
		throw new Error(`${fieldName} is invalid`);
	}
	return value as T;
}

function optionalPositiveInt(
	value: unknown,
	fieldName: string,
): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${fieldName} is invalid`);
	}
	return Math.max(1, Math.min(12, Math.floor(value)));
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
	const { query, conversationId } = data;
	if (typeof query !== "string" || query.trim().length === 0) {
		return json({ error: "query is required" }, { status: 400 });
	}

	const serviceAssertion =
		user === null
			? verifyServiceAssertion(
					event.request.headers.get("authorization"),
				)
			: null;
	if (user === null && !serviceAssertion?.valid) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}
	if (user === null) {
		if (
			typeof conversationId !== "string" ||
			conversationId.trim().length === 0
		) {
			return json(
				{ error: "conversationId is required for service calls" },
				{ status: 400 },
			);
		}
		if (serviceAssertion?.claims.conversationId !== conversationId.trim()) {
			return json({ error: "Unauthorized" }, { status: 401 });
		}
	}

	let ownerUserId = user?.id ?? null;
	if (typeof conversationId === "string" && conversationId.trim().length > 0) {
		const conversation = await db.query.conversations.findFirst({
			where: eq(conversations.id, conversationId),
		});
		if (!conversation || (user && conversation.userId !== user.id)) {
			return json({ error: "Unauthorized" }, { status: 401 });
		}
		ownerUserId = conversation.userId;
	}

	if (!ownerUserId) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const result = await researchWeb({
			query: query.trim(),
			mode: optionalEnum(data.mode, MODES, "mode"),
			freshness: optionalEnum(data.freshness, FRESHNESS, "freshness"),
			sourcePolicy: optionalEnum(
				data.sourcePolicy ?? data.source_policy,
				SOURCE_POLICIES,
				"sourcePolicy",
			),
			maxSources: optionalPositiveInt(
				data.maxSources ?? data.max_sources,
				"maxSources",
			),
			quoteRequired:
				typeof data.quoteRequired === "boolean"
					? data.quoteRequired
					: typeof data.quote_required === "boolean"
						? data.quote_required
						: undefined,
		});
		return json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Research failed";
		const status = /invalid|required/.test(message) ? 400 : 500;
		return json({ error: message }, { status });
	}
};
