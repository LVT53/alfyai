import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { memoryProjectionState, users } from "$lib/server/db/schema";
import {
	parseJsonWithEnvelopeExtraction,
	reasoningAwareMaxTokens,
} from "../memory-judge/schema";
import { getActiveMemoryProfileContext } from "../memory-profile/active-context";
import { ensureProjectionState } from "../memory-profile/projection-store";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";

export type PersonaSummary = {
	text: string;
	links: Array<{ text: string; factIds: string[] }>;
	updatedAt: Date;
} | null;

// A persona summary is a ~150-250 word synthesis; beyond a few dozen facts the
// summary cannot reference them all, and a very large fact list drives reasoning
// models past their token budget into invalid_json. Cap the input to the most
// recent facts (the list is ordered newest-first). Older facts still reach the
// model at recall time via memory-context's own top-K selection.
const PERSONA_SUMMARY_MAX_FACTS = 30;

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
	// Kept deliberately lean: a long, heavily-emphasised prompt drives reasoning
	// models to spend their whole token budget on chain-of-thought and emit an
	// empty content channel (observed live as invalid_json on 49- and 81-fact
	// profiles). A short contract yields clean JSON directly.
	return [
		`Write a persona summary of this user in ${language} from the facts below.`,
		"Present tense; group as who they are, durable preferences, current context.",
		"Use ONLY the given facts — do not pad or invent. Few facts → few sentences.",
		"",
		`Output ONLY a JSON object {"sentences":[{"text":"...","factIds":["..."]}]}:`,
		`each sentence's "text" is one sentence in ${language} (no ids inside it),`,
		'and "factIds" lists the bracketed ids of the facts supporting it ([] if none).',
		"No reasoning, no prose, no code fences — start with { and end with }.",
		'Example: {"sentences":[{"text":"They are a software engineer in Berlin.","factIds":["f1"]}]}',
	].join("\n");
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

function isParseableJson(responseText: string): boolean {
	return parseJsonWithEnvelopeExtraction(responseText, "sentences") !== null;
}

function parseLinks(
	responseText: string,
	activeFactIds: Set<string>,
): Array<{ text: string; factIds: string[] }> | null {
	// The envelope may be embedded in reasoning prose (see
	// parseJsonWithEnvelopeExtraction); the extracted object still goes through
	// the same schema validation below.
	const raw = parseJsonWithEnvelopeExtraction(responseText, "sentences");
	if (raw === null) return null;
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

	// A 150-250 word summary cannot faithfully encode dozens of facts, and
	// feeding a very large profile drives reasoning models past their token
	// budget into invalid_json (observed live at 49 and 81 active facts). The
	// items arrive newest-first (active-context orders by updatedAt desc), so
	// the most recent, most relevant facts are kept; older facts still inform
	// recall via memory-context's own top-K path, just not the prose summary.
	const summaryFacts = context.items.slice(0, PERSONA_SUMMARY_MAX_FACTS);

	const language = await resolveSummaryLanguage(userId);
	const userMessage = summaryFacts
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
				// Structured extraction, not reasoning — disable chain-of-thought
				// (same quality, far cheaper on thinking models). See memory-recuration.
				thinkingMode: "off",
				// Reasoning-aware: chain-of-thought scales with the fact count and
				// counts against max_tokens on these providers; a flat budget starves
				// large profiles into invalid_json (see memory-judge/schema.ts).
				maxTokens: reasoningAwareMaxTokens(context.items.length),
				jsonSchema: PERSONA_SUMMARY_JSON_SCHEMA,
				allowReasoningFallback: true,
			},
		);
		responseText = res.text;
	} catch (error) {
		await recordPersonaSummaryFailure(
			userId,
			`llm_error:${error instanceof Error ? error.name : "Unknown"}`,
		);
		return null;
	}

	const activeFactIds = new Set(summaryFacts.map((item) => item.id));
	const links = parseLinks(responseText, activeFactIds);
	if (!links) {
		const reason = isParseableJson(responseText)
			? "no_usable_sentences"
			: "invalid_json";
		await recordPersonaSummaryFailure(userId, reason);
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

async function recordPersonaSummaryFailure(
	userId: string,
	reason: "invalid_json" | "no_usable_sentences" | `llm_error:${string}`,
): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId,
			eventFamily: "maintenance",
			eventName: "persona_summary_failed",
			reason,
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
