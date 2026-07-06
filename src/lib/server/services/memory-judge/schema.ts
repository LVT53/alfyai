import { z } from "zod";
import {
	MEMORY_PROFILE_CATEGORIES,
	type MemoryProfileCategory,
} from "../memory-profile/types";

export type JudgeDecision = {
	action: "add" | "update" | "strengthen";
	targetItemId?: string;
	statement: string;
	category: MemoryProfileCategory;
	scope: "global" | "project";
	confidence: "stated" | "inferred";
	expiryClass: "durable" | "time_bound";
	expiresInDays?: number;
	sourceQuote: string;
};

export const JUDGE_JSON_SCHEMA = {
	name: "memory_judge_decisions",
	strict: true as const,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["decisions"],
		properties: {
			decisions: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: [
						"action",
						"statement",
						"category",
						"scope",
						"confidence",
						"expiryClass",
						"sourceQuote",
					],
					properties: {
						action: { type: "string", enum: ["add", "update", "strengthen"] },
						targetItemId: { type: "string" },
						statement: { type: "string" },
						category: { type: "string", enum: [...MEMORY_PROFILE_CATEGORIES] },
						scope: { type: "string", enum: ["global", "project"] },
						confidence: { type: "string", enum: ["stated", "inferred"] },
						expiryClass: { type: "string", enum: ["durable", "time_bound"] },
						expiresInDays: { type: "number", minimum: 1, maximum: 730 },
						sourceQuote: { type: "string" },
					},
				},
			},
		},
	},
};

const decisionSchema = z.object({
	action: z.enum(["add", "update", "strengthen"]),
	targetItemId: z.string().min(1).optional(),
	statement: z.string().min(4).max(400),
	category: z.enum(MEMORY_PROFILE_CATEGORIES),
	scope: z.enum(["global", "project"]),
	confidence: z.enum(["stated", "inferred"]),
	expiryClass: z.enum(["durable", "time_bound"]),
	expiresInDays: z.number().int().min(1).max(730).optional(),
	sourceQuote: z.string().min(1).max(300),
});

export const HEDGE_RE =
	/\b(might|may be|maybe|possibly|perhaps|probably|or has\b|talán|esetleg|lehet,? hogy|valószínűleg)\b/i;
export const EVIDENCE_TRAIL_RE =
	/\b(as indicated by|as evidenced by|extracted from|based on the (output|path|log)|amint az|ahogy a[bz]?ól kiderül)\b/i;
export const THIRD_PERSON_RE =
	/^(u_[0-9a-f]{6,}|the user|this user|a felhasználó)\b/i;

function firstSentence(statement: string): string {
	const match = statement.match(/^.*?[.!?](?=\s|$)/);
	return (match ? match[0] : statement).trim();
}

export function parseJudgeDecisions(rawText: string): JudgeDecision[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return [];
	}
	const envelope = z
		.object({ decisions: z.array(z.unknown()) })
		.safeParse(parsed);
	if (!envelope.success) return [];
	const out: JudgeDecision[] = [];
	for (const raw of envelope.data.decisions) {
		const d = decisionSchema.safeParse(raw);
		if (!d.success) continue;
		const statement = firstSentence(d.data.statement);
		if (HEDGE_RE.test(statement)) continue;
		if (EVIDENCE_TRAIL_RE.test(statement)) continue;
		if (THIRD_PERSON_RE.test(statement)) continue;
		if (d.data.expiryClass === "time_bound" && !d.data.expiresInDays) continue;
		if (
			(d.data.action === "update" || d.data.action === "strengthen") &&
			!d.data.targetItemId
		)
			continue;
		out.push({ ...d.data, statement });
	}
	return out;
}
