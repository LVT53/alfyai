import { z } from "zod";
import {
	MEMORY_PROFILE_CATEGORIES,
	type MemoryProfileCategory,
} from "../memory-profile/types";

// Shared completion budget for the judge call, used by both the production
// runner (index.ts) and the offline eval harness (scripts/memory-judge-eval.ts)
// so they exercise the same headroom. Non-strict json_object fallback
// providers (e.g. DeepSeek without strict structured outputs) sometimes emit
// free-text chain-of-thought before the JSON envelope; this budget must be
// large enough to survive that plus the JSON payload itself.
export const JUDGE_MAX_TOKENS = 2400;

// Reasoning-aware completion budget for memory-rework calls whose input scales
// with the number of items shown to the model (recuration verdicts,
// reconcile-and-merge, persona summary). On the OpenAI-compatible providers
// these run on, a reasoning model's chain-of-thought tokens COUNT AGAINST
// max_tokens: captured production traffic shows finish_reason="length" with
// usage.completion_tokens_details.reasoning_tokens consuming the entire budget
// and an empty content channel when the cap is too small for the item count
// (a 3-item task burned 1083 reasoning tokens before emitting its first
// payload byte). Budget = the flat JUDGE_MAX_TOKENS base (empirically enough
// for ~3 items end-to-end) plus 500 per item, capped at 8000 to stay within
// provider limits.
export function reasoningAwareMaxTokens(itemCount: number): number {
	return Math.min(JUDGE_MAX_TOKENS + 500 * itemCount, 8000);
}

// Scan for a balanced JSON object starting at `start` (which must point at a
// "{"), respecting string literals and escapes. Returns the matching substring
// or null when the braces never balance (e.g. the text was truncated).
function extractBalancedJsonObject(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

// Parse a control-model response that is expected to be a JSON object with the
// given top-level `key`. Reasoning models sometimes surround the JSON envelope
// with chain-of-thought prose (surfaced via the reasoning-fallback path) or
// markdown fences, so when the bare parse fails we additionally look for a
// balanced object containing `"key"` inside the text — scanning occurrences
// LAST first, because reasoning prose may quote a format example while
// thinking and the real envelope is emitted after the reasoning ends. The
// extracted object must still pass the caller's schema validation — this only
// relaxes WHERE the envelope may sit, not its shape. Returns null when no
// parseable envelope is found.
export function parseJsonWithEnvelopeExtraction(
	rawText: string,
	key: string,
): unknown | null {
	try {
		return JSON.parse(rawText);
	} catch {
		// fall through to embedded-envelope extraction
	}
	const quotedKey = `"${key}"`;
	let keyIdx = rawText.lastIndexOf(quotedKey);
	while (keyIdx !== -1) {
		const start = rawText.lastIndexOf("{", keyIdx);
		if (start !== -1) {
			const candidate = extractBalancedJsonObject(rawText, start);
			if (candidate) {
				try {
					return JSON.parse(candidate);
				} catch {
					// not valid JSON here; keep scanning
				}
			}
		}
		keyIdx = rawText.lastIndexOf(quotedKey, keyIdx - 1);
	}
	return null;
}

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

// The `or has\b` token targets audit-style compound hedges the control model
// sometimes emits, e.g. "has a bike or has a bike to which insurance might be
// applicable" — a disjunction dressed up as a fact, which is not a stated truth.
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

// Non-strict json_object fallback providers occasionally free-form the
// `action` value as "create" (a synonym never in our enum) instead of "add".
// Alias it before validation so an otherwise-valid candidate isn't rejected
// for a naming mismatch alone; this does not add or infer any missing
// required field, so genuinely incomplete candidates still fail validation.
function normalizeRawAction(raw: unknown): unknown {
	if (
		raw &&
		typeof raw === "object" &&
		"action" in raw &&
		(raw as { action?: unknown }).action === "create"
	) {
		return { ...raw, action: "add" };
	}
	return raw;
}

export type RejectedJudgeCandidate = {
	statement: string;
	reason:
		| "hedge"
		| "evidence_trail"
		| "third_person"
		| "invalid_shape"
		| "missing_expiry"
		| "missing_target";
};

/**
 * Best-effort statement extraction for a raw candidate that failed schema
 * validation, so a rejected-candidate telemetry row still carries a readable
 * (privacy-safe) statement. Falls back to "" when no string is present.
 */
function rawStatement(raw: unknown): string {
	if (raw && typeof raw === "object" && "statement" in raw) {
		const s = (raw as { statement?: unknown }).statement;
		if (typeof s === "string") return firstSentence(s);
	}
	return "";
}

/**
 * Parse the judge JSON envelope into accepted decisions plus a diagnostic list
 * of post-filter rejects. `parseJudgeDecisions` wraps this and returns only the
 * accepted decisions. A malformed envelope yields empty lists (no rejects) —
 * there are no candidates to attribute a rejection to.
 */
export function parseJudgeDecisionsDetailed(rawText: string): {
	decisions: JudgeDecision[];
	rejected: RejectedJudgeCandidate[];
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return { decisions: [], rejected: [] };
	}
	const envelope = z
		.object({ decisions: z.array(z.unknown()) })
		.safeParse(parsed);
	if (!envelope.success) return { decisions: [], rejected: [] };
	const decisions: JudgeDecision[] = [];
	const rejected: RejectedJudgeCandidate[] = [];
	for (const raw of envelope.data.decisions) {
		const d = decisionSchema.safeParse(normalizeRawAction(raw));
		if (!d.success) {
			rejected.push({ statement: rawStatement(raw), reason: "invalid_shape" });
			continue;
		}
		const statement = firstSentence(d.data.statement);
		if (HEDGE_RE.test(statement)) {
			rejected.push({ statement, reason: "hedge" });
			continue;
		}
		if (EVIDENCE_TRAIL_RE.test(statement)) {
			rejected.push({ statement, reason: "evidence_trail" });
			continue;
		}
		if (THIRD_PERSON_RE.test(statement)) {
			rejected.push({ statement, reason: "third_person" });
			continue;
		}
		if (d.data.expiryClass === "time_bound" && !d.data.expiresInDays) {
			rejected.push({ statement, reason: "missing_expiry" });
			continue;
		}
		if (
			(d.data.action === "update" || d.data.action === "strengthen") &&
			!d.data.targetItemId
		) {
			rejected.push({ statement, reason: "missing_target" });
			continue;
		}
		decisions.push({ ...d.data, statement });
	}
	return { decisions, rejected };
}

export function parseJudgeDecisions(rawText: string): JudgeDecision[] {
	return parseJudgeDecisionsDetailed(rawText).decisions;
}
