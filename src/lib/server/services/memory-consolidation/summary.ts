import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { memoryProjectionState, users } from "$lib/server/db/schema";
import { getActiveMemoryProfileContext } from "../memory-profile/active-context";
import { ensureProjectionState } from "../memory-profile/projection-store";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";

export type PersonaSummary = {
	text: string;
	links: Array<{ text: string; factIds: string[] }>;
	updatedAt: Date;
} | null;

const PERSONA_SUMMARY_JSON_SCHEMA = {
	name: "persona_summary",
	strict: true as const,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["sentences"],
		properties: {
			sentences: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["text", "factIds"],
					properties: {
						text: { type: "string" },
						factIds: { type: "array", items: { type: "string" } },
					},
				},
			},
		},
	},
};

const personaSummaryResponseSchema = z.object({
	sentences: z
		.array(
			z
				.object({
					text: z.string().optional(),
					factIds: z.array(z.string()).optional(),
				})
				.loose(),
		)
		.optional(),
});

const LANGUAGE_NAMES: Record<string, string> = {
	en: "English",
	hu: "Hungarian",
};

function languageNameForCode(code: string): string {
	return LANGUAGE_NAMES[code] ?? code;
}

function buildSystemPrompt(language: string): string {
	return (
		`Write a persona summary of this user in ${language}, 150-250 words, ` +
		"plain prose, present tense, grouped as: who they are; durable " +
		"preferences; current context. Use ONLY the numbered facts provided; " +
		"attach the ids of the facts supporting each sentence."
	);
}

async function resolveSummaryLanguage(userId: string): Promise<string> {
	const [userRow] = await db
		.select({
			titleLanguage: users.titleLanguage,
			uiLanguage: users.uiLanguage,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const code =
		userRow && userRow.titleLanguage !== "auto"
			? userRow.titleLanguage
			: (userRow?.uiLanguage ?? "en");
	return languageNameForCode(code);
}

function parseLinks(
	responseText: string,
	activeFactIds: Set<string>,
): Array<{ text: string; factIds: string[] }> | null {
	let raw: unknown;
	try {
		raw = JSON.parse(responseText);
	} catch {
		return null;
	}
	const parsed = personaSummaryResponseSchema.safeParse(raw);
	if (!parsed.success) return null;

	const links: Array<{ text: string; factIds: string[] }> = [];
	for (const sentence of parsed.data.sentences ?? []) {
		const text = typeof sentence.text === "string" ? sentence.text.trim() : "";
		if (text.length === 0) continue;
		const factIds = (sentence.factIds ?? []).filter((id) =>
			activeFactIds.has(id),
		);
		links.push({ text, factIds });
	}
	return links.length > 0 ? links : null;
}

/**
 * Generate a persona summary from the user's active memory facts via one
 * control-model call and store it on the projection state row. Returns null
 * (storing nothing) when there are no active facts or when the model response
 * is unusable.
 */
export async function generateAndStorePersonaSummary(params: {
	userId: string;
}): Promise<PersonaSummary> {
	const { userId } = params;
	const context = await getActiveMemoryProfileContext({ userId });
	if (context.items.length === 0) return null;

	const language = await resolveSummaryLanguage(userId);
	const userMessage = context.items
		.map((item) => `- [${item.id}] (${item.category}) ${item.statement}`)
		.join("\n");

	let responseText: string;
	try {
		const { sendJsonControlMessage } = await import(
			"../normal-chat-control-model"
		);
		const res = await sendJsonControlMessage(
			userMessage,
			getConfig().memoryConsolidationModel,
			{
				systemPrompt: buildSystemPrompt(language),
				temperature: 0,
				jsonSchema: PERSONA_SUMMARY_JSON_SCHEMA,
				allowReasoningFallback: true,
			},
		);
		responseText = res.text;
	} catch {
		await recordPersonaSummaryFailure(userId);
		return null;
	}

	const activeFactIds = new Set(context.items.map((item) => item.id));
	const links = parseLinks(responseText, activeFactIds);
	if (!links) {
		await recordPersonaSummaryFailure(userId);
		return null;
	}

	const text = links.map((link) => link.text).join(" ");
	const now = new Date();
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const projection = await ensureProjectionState({ userId, resetGeneration });
	await db
		.update(memoryProjectionState)
		.set({
			personaSummaryText: text,
			personaSummaryLinksJson: JSON.stringify(links),
			personaSummaryUpdatedAt: now,
			revision: sql`${memoryProjectionState.revision} + 1`,
			updatedAt: now,
		})
		.where(eq(memoryProjectionState.id, projection.id))
		.run();

	return { text, links, updatedAt: now };
}

async function recordPersonaSummaryFailure(userId: string): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId,
			eventFamily: "maintenance",
			eventName: "persona_summary_failed",
		});
	} catch {
		// Telemetry is best-effort; never fail summary generation over it.
	}
}

/**
 * Read the stored persona summary from the projection state row. Returns null
 * when no summary has been stored for the current reset generation.
 */
export async function getPersonaSummary(params: {
	userId: string;
}): Promise<PersonaSummary> {
	const { userId } = params;
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const projection = await ensureProjectionState({ userId, resetGeneration });
	if (
		!projection.personaSummaryText ||
		projection.personaSummaryText.length === 0
	) {
		return null;
	}

	let links: Array<{ text: string; factIds: string[] }> = [];
	try {
		const parsed = JSON.parse(projection.personaSummaryLinksJson ?? "[]");
		if (Array.isArray(parsed)) {
			links = parsed.filter(
				(entry): entry is { text: string; factIds: string[] } =>
					entry !== null &&
					typeof entry === "object" &&
					typeof entry.text === "string" &&
					Array.isArray(entry.factIds) &&
					entry.factIds.every((id: unknown) => typeof id === "string"),
			);
		}
	} catch {
		// Corrupt links JSON degrades to an empty links array.
	}

	return {
		text: projection.personaSummaryText,
		links,
		updatedAt: projection.personaSummaryUpdatedAt ?? new Date(),
	};
}
