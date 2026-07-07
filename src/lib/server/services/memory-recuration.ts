import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryProfileItems,
	memoryReviewItems,
	users,
} from "$lib/server/db/schema";
import type { ModelId } from "$lib/types";
import { runUserMemoryConsolidation } from "./memory-consolidation/index";
import { buildJudgeSystemPrompt } from "./memory-judge/prompt";
import {
	EVIDENCE_TRAIL_RE,
	HEDGE_RE,
	parseJsonWithEnvelopeExtraction,
	reasoningAwareMaxTokens,
	THIRD_PERSON_RE,
} from "./memory-judge/schema";
import {
	mergeMemoryProfileItemMetadata,
	updateMemoryProfileItemWithRevision,
} from "./memory-profile/projection-store";
import { getCurrentMemoryResetGeneration } from "./memory-profile/reset-generation";
import { resolveMemoryReviewItem } from "./memory-profile/review";
import { recordMemoryReworkTelemetry } from "./memory-profile/telemetry";
import {
	isUserAuthoredMemoryMetadata,
	MEMORY_PROFILE_CATEGORIES,
	type MemoryProfileCategory,
} from "./memory-profile/types";

// Batch-size and token-budget arithmetic (production-snapshot evidence):
// The recuration judge runs on reasoning models (e.g. DeepSeek R1-style) whose
// chain-of-thought tokens COUNT AGAINST max_tokens on OpenAI-compatible
// providers. Captured raw responses show finish_reason="length" with
// usage.completion_tokens_details.reasoning_tokens equal to the entire
// completion budget and an EMPTY content channel: the model burned the whole
// cap reasoning about the items and never got to emit the verdicts JSON
// (a 3-item batch used 1083 reasoning tokens before emitting the first
// verdict bytes). allowReasoningFallback then surfaces the reasoning PROSE,
// which can never parse -> parseRecurationVerdicts() returns [] -> the whole
// batch silently applied zero verdicts (the original all-zeros failure at 20
// items / 2400 maxTokens; the same run applied a 3-item user fine because a
// 3-item task's reasoning still fit under 2400).
//
// So the budget must cover reasoning-that-grows-with-batch-size PLUS the
// verdicts JSON (~150 tokens worst case per rewrite verdict: 36-char UUID +
// enum + <=400-char statement + expiry fields + punctuation). We keep batches
// at 10 items to bound the reasoning volume and provision tokens via
// reasoningAwareMaxTokens (JUDGE_MAX_TOKENS base + 500/item, capped at 8000 —
// see memory-judge/schema.ts). The unparsed-split-retry safety net below
// covers residual overruns: halves re-run with proportionally lighter
// reasoning loads.
const BATCH_SIZE = 10;

// When a batch still parses to zero verdicts despite being non-empty, we split
// it in half and re-run each half exactly once (one level of recursion only —
// the halves are processed directly, they do NOT recurse again). Guards against
// any residual truncation or a transient malformed response.
const MAX_SPLIT_DEPTH = 1;

const RECURATION_JSON_SCHEMA = {
	name: "memory_recuration_verdicts",
	strict: true as const,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["verdicts"],
		properties: {
			verdicts: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["itemId", "verdict"],
					properties: {
						itemId: { type: "string" },
						verdict: { type: "string", enum: ["keep", "rewrite", "retire"] },
						statement: { type: "string" },
						category: { type: "string", enum: [...MEMORY_PROFILE_CATEGORIES] },
						expiryClass: { type: "string", enum: ["durable", "time_bound"] },
						expiresInDays: { type: "number", minimum: 1, maximum: 730 },
					},
				},
			},
		},
	},
};

const verdictSchema = z.object({
	itemId: z.string().min(1),
	verdict: z.enum(["keep", "rewrite", "retire"]),
	statement: z.string().min(1).max(400).optional(),
	category: z.enum(MEMORY_PROFILE_CATEGORIES).optional(),
	expiryClass: z.enum(["durable", "time_bound"]).optional(),
	expiresInDays: z.number().int().min(1).max(730).optional(),
});

type RecurationVerdict = z.infer<typeof verdictSchema>;

// Parse the raw model text into verdicts. The envelope may be embedded in
// reasoning prose (see parseJsonWithEnvelopeExtraction); the extracted object
// still goes through the same strict zod validation — the extraction only
// relaxes WHERE the envelope may sit, not its shape.
function parseRecurationVerdicts(rawText: string): RecurationVerdict[] {
	const parsed = parseJsonWithEnvelopeExtraction(rawText, "verdicts");
	if (parsed === null) return [];
	const envelope = z
		.object({ verdicts: z.array(z.unknown()) })
		.safeParse(parsed);
	if (!envelope.success) return [];
	const out: RecurationVerdict[] = [];
	for (const raw of envelope.data.verdicts) {
		const v = verdictSchema.safeParse(raw);
		if (v.success) out.push(v.data);
	}
	return out;
}

function buildRecurationSystemPrompt(): string {
	return [
		buildJudgeSystemPrompt(),
		"These are EXISTING stored memories being re-audited. 'rewrite' when the underlying fact is real but the statement is third-person, contains peer tokens (U_xxxx), evidence-trail prose, or should be time_bound; 'retire' when it fails any gate; 'keep' only if already perfect. Rewrite statements in FIRST PERSON, one sentence, in the statement's original language.",
		"",
		"OUTPUT FORMAT FOR THIS RE-AUDIT TASK (this overrides the decisions/candidate format described above — you are producing VERDICTS on existing items, not new candidates):",
		"Reply with ONLY a single JSON object. No reasoning, no chain-of-thought, no markdown code fences, no prose before or after — the first character of your reply must be '{' and the last must be '}'.",
		'The JSON object has exactly one top-level key, "verdicts", an array with exactly one entry per item you were given.',
		"EVERY object in the verdicts array MUST include ALL of these fields — a verdict missing a required field is invalid and will be discarded:",
		'  - "itemId": REQUIRED, copied exactly from the input item',
		'  - "verdict": REQUIRED, one of "keep", "rewrite", "retire" (exactly these three strings)',
		'  - "statement": REQUIRED whenever verdict is "rewrite" (the new first-person, one-sentence statement); omit otherwise',
		`  - "category": one of ${MEMORY_PROFILE_CATEGORIES.map((c) => `"${c}"`).join(", ")} — include when verdict is "rewrite" and the category should change`,
		'  - "expiryClass": "durable" or "time_bound" — include when verdict is "rewrite" or "keep" and the expiry classification should be set or changed',
		'  - "expiresInDays": a number of days — REQUIRED whenever expiryClass is "time_bound", omit otherwise',
		"Unknown or extra fields and any verdict not in keep/rewrite/retire are all invalid.",
		"Example of a fully valid response:",
		'{"verdicts":[{"itemId":"f1","verdict":"keep"},{"itemId":"f2","verdict":"rewrite","statement":"I prefer plain, jargon-free explanations.","category":"preferences","expiryClass":"durable"},{"itemId":"f3","verdict":"retire"}]}',
	].join("\n");
}

function buildRecurationUserMessage(
	items: Array<{
		id: string;
		statement: string;
		category: MemoryProfileCategory;
	}>,
): string {
	return JSON.stringify({
		items: items.map((i) => ({
			itemId: i.id,
			statement: i.statement,
			category: i.category,
		})),
	});
}

function tripsRewriteFilter(statement: string): boolean {
	return (
		HEDGE_RE.test(statement) ||
		EVIDENCE_TRAIL_RE.test(statement) ||
		THIRD_PERSON_RE.test(statement)
	);
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

type EligibleRow = typeof memoryProfileItems.$inferSelect;

// Call the control model on one set of eligible items and parse the verdicts.
// maxTokens is reasoning-aware (see the arithmetic comment at BATCH_SIZE and
// reasoningAwareMaxTokens in memory-judge/schema.ts). Throws on transport
// failure; returns [] when the response parses to no valid verdicts.
async function fetchRecurationVerdicts(
	eligible: EligibleRow[],
	memoryJudgeModel: ModelId | undefined,
): Promise<RecurationVerdict[]> {
	const { sendJsonControlMessage } = await import(
		"./normal-chat-control-model"
	);
	const maxTokens = reasoningAwareMaxTokens(eligible.length);
	const res = await sendJsonControlMessage(
		buildRecurationUserMessage(
			eligible.map((row) => {
				const category = row.category as MemoryProfileCategory;
				return { id: row.id, statement: row.statement, category };
			}),
		),
		memoryJudgeModel,
		{
			systemPrompt: buildRecurationSystemPrompt(),
			temperature: 0,
			maxTokens,
			jsonSchema: RECURATION_JSON_SCHEMA,
			allowReasoningFallback: true,
		},
	);
	return parseRecurationVerdicts(res.text);
}

type ApplyVerdictsResult = {
	kept: number;
	rewritten: number;
	retired: number;
	unknownIds: number;
};

// Apply a parsed verdict list to one set of eligible rows. Returns per-
// disposition counts plus the number of verdicts that referenced an id not in
// this set (silently dropped, but counted so the caller can surface telemetry).
async function applyRecurationVerdicts(params: {
	userId: string;
	resetGeneration: number;
	eligible: EligibleRow[];
	verdicts: RecurationVerdict[];
}): Promise<ApplyVerdictsResult> {
	const { userId, resetGeneration, eligible, verdicts } = params;
	const eligibleById = new Map(eligible.map((row) => [row.id, row]));
	let projectionRevision: number | null = null;
	let kept = 0;
	let rewritten = 0;
	let retired = 0;
	let unknownIds = 0;

	for (const verdict of verdicts) {
		const row = eligibleById.get(verdict.itemId);
		if (!row) {
			unknownIds++;
			continue; // drop unknown ids
		}

		if (projectionRevision === null) {
			const { ensureProjectionState } = await import(
				"./memory-profile/projection-store"
			);
			const projection = await ensureProjectionState({
				userId,
				resetGeneration,
			});
			projectionRevision = projection.revision;
		}

		let effectiveVerdict = verdict.verdict;
		if (effectiveVerdict === "rewrite") {
			const newStatement = verdict.statement?.trim();
			if (!newStatement || tripsRewriteFilter(newStatement)) {
				effectiveVerdict = "retire";
			}
		}

		if (effectiveVerdict === "rewrite") {
			const newStatement = (verdict.statement as string).trim();
			const expiryClass = verdict.expiryClass;
			const wasReviewNeeded = row.status === "review_needed";
			const expiresAt =
				expiryClass === "time_bound" && verdict.expiresInDays
					? new Date(Date.now() + verdict.expiresInDays * 86_400_000)
					: undefined;
			// On a review_needed -> active transition, always recompute
			// expiresAt from the verdict (mirrors the accept flow in
			// memory-profile/review.ts): time_bound sets a fresh horizon,
			// otherwise the review-window expiry is cleared entirely.
			const expiresAtPatch = wasReviewNeeded
				? { expiresAt: expiresAt ?? null }
				: expiresAt
					? { expiresAt }
					: {};
			const patched = await updateMemoryProfileItemWithRevision({
				userId,
				itemId: row.id,
				expectedProjectionRevision: projectionRevision,
				patch: {
					statement: newStatement,
					...(wasReviewNeeded ? { status: "active" } : {}),
					...expiresAtPatch,
				},
			});
			if (patched.status === "updated") {
				projectionRevision = patched.projectionRevision;
				await mergeMemoryProfileItemMetadata({
					userId,
					itemId: row.id,
					patch: {
						origin: "recuration",
						...(expiryClass ? { expiryClass } : {}),
					},
				});
				rewritten++;
			}
			continue;
		}

		if (effectiveVerdict === "retire") {
			const patched = await updateMemoryProfileItemWithRevision({
				userId,
				itemId: row.id,
				expectedProjectionRevision: projectionRevision,
				patch: { status: "retired" },
			});
			if (patched.status === "updated") {
				projectionRevision = patched.projectionRevision;
			}
			await mergeMemoryProfileItemMetadata({
				userId,
				itemId: row.id,
				patch: { origin: "recuration" },
			});
			retired++;
			continue;
		}

		// keep
		if (row.status === "review_needed") {
			const expiryClass = verdict.expiryClass;
			const expiresAt =
				expiryClass === "time_bound" && verdict.expiresInDays
					? new Date(Date.now() + verdict.expiresInDays * 86_400_000)
					: null;
			const patched = await updateMemoryProfileItemWithRevision({
				userId,
				itemId: row.id,
				expectedProjectionRevision: projectionRevision,
				patch: { status: "active", expiresAt },
			});
			if (patched.status === "updated") {
				projectionRevision = patched.projectionRevision;
			}
		}
		await mergeMemoryProfileItemMetadata({
			userId,
			itemId: row.id,
			patch: { origin: "recuration" },
		});
		kept++;
	}

	return { kept, rewritten, retired, unknownIds };
}

export async function runMemoryRecuration(userId: string): Promise<{
	kept: number;
	rewritten: number;
	retired: number;
	reviewResolved: number;
}> {
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				inArray(memoryProfileItems.status, [
					"active",
					"review_needed",
					"inactive",
				]),
			),
		);

	let kept = 0;
	let rewritten = 0;
	let retired = 0;
	let reviewResolved = 0;

	const config = getConfig();
	const batches = chunk(rows, BATCH_SIZE);

	// Process one eligible set: call the model, and if a non-empty set parses to
	// ZERO verdicts (the truncation failure), emit telemetry and retry once with
	// the set split in half. `depth` bounds the split recursion to MAX_SPLIT_DEPTH
	// (one level): the halves are applied directly and never split again.
	const processEligibleSet = async (
		eligible: EligibleRow[],
		depth: number,
	): Promise<void> => {
		if (eligible.length === 0) return;

		let verdicts: RecurationVerdict[];
		try {
			verdicts = await fetchRecurationVerdicts(
				eligible,
				config.memoryJudgeModel,
			);
		} catch (error) {
			await recordMemoryReworkTelemetry({
				userId,
				eventFamily: "intake",
				eventName: "recuration_batch_failed",
				reason:
					error instanceof Error ? error.message.slice(0, 200) : "unknown",
				status: "error",
			}).catch(() => {});
			return;
		}

		if (verdicts.length === 0) {
			// A non-empty batch that yields no verdicts almost always means the
			// model burned its whole reasoning budget and emitted no parseable
			// JSON. Make it VISIBLE, then recover so no real fact is silently
			// dropped: split in half once, and at the split cap fall back to a
			// flat per-item pass (each item its own call at the smallest — thus
			// most reasoning-headroom-per-item — budget). A lone item that still
			// fails is the genuine terminal give-up. Call count is bounded O(n)
			// per batch (split is one level; the per-item pass is a flat loop of
			// single-item calls that cannot recurse), never exponential.
			const canSplit = eligible.length > 1 && depth < MAX_SPLIT_DEPTH;
			const canPerItem = eligible.length > 1 && depth >= MAX_SPLIT_DEPTH;
			await recordMemoryReworkTelemetry({
				userId,
				eventFamily: "intake",
				eventName: "recuration_batch_unparsed",
				reason: `size=${eligible.length} ${
					canSplit
						? "retrying-split"
						: canPerItem
							? "per-item-fallback"
							: "gave-up-single-item"
				}`,
				status: "error",
				count: eligible.length,
			}).catch(() => {});

			if (canSplit) {
				const mid = Math.ceil(eligible.length / 2);
				await processEligibleSet(eligible.slice(0, mid), depth + 1);
				await processEligibleSet(eligible.slice(mid), depth + 1);
			} else if (canPerItem) {
				for (const item of eligible) {
					await processEligibleSet([item], depth + 1);
				}
			}
			return;
		}

		const applied = await applyRecurationVerdicts({
			userId,
			resetGeneration,
			eligible,
			verdicts,
		});
		kept += applied.kept;
		rewritten += applied.rewritten;
		retired += applied.retired;
		if (applied.unknownIds > 0) {
			await recordMemoryReworkTelemetry({
				userId,
				eventFamily: "intake",
				eventName: "recuration_verdicts_dropped",
				reason: `unknown-item-ids in batch of ${eligible.length}`,
				status: "warning",
				count: applied.unknownIds,
			}).catch(() => {});
		}
	};

	for (const batch of batches) {
		const eligible = batch.filter(
			(row) => !isUserAuthoredMemoryMetadata(row.metadataJson),
		);
		await processEligibleSet(eligible, 0);
	}

	// Items still stuck in review_needed after the batches ran (e.g. their
	// batch's control-model call failed) must not have their review row
	// force-resolved: that would orphan the item in review_needed with no
	// visible review row. Only resolve rows that don't reference any such
	// still-pending item.
	const stillReviewNeededRows = await db
		.select({ id: memoryProfileItems.id })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "review_needed"),
			),
		);
	const stillReviewNeededIds = new Set(
		stillReviewNeededRows.map((row) => row.id),
	);

	const openReviewRows = await db
		.select({
			id: memoryReviewItems.id,
			affectedItemIdsJson: memoryReviewItems.affectedItemIdsJson,
		})
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, userId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		);
	for (const review of openReviewRows) {
		let affectedItemIds: string[] = [];
		try {
			const parsed = JSON.parse(review.affectedItemIdsJson ?? "[]");
			if (Array.isArray(parsed)) affectedItemIds = parsed;
		} catch {
			// malformed metadata: fall through with an empty list, resolve as usual
		}
		const referencesUnprocessedItem = affectedItemIds.some((id) =>
			stillReviewNeededIds.has(id),
		);
		if (referencesUnprocessedItem) continue;

		const result = await resolveMemoryReviewItem({
			userId,
			reviewItemId: review.id,
			resolutionType: "do_not_remember",
			metadata: { reason: "recuration" },
		});
		if (result.status === "resolved") reviewResolved++;
	}

	await runUserMemoryConsolidation(userId, "recuration");

	return { kept, rewritten, retired, reviewResolved };
}

export async function runAllUsersMemoryRecuration(
	userIds?: string[],
): Promise<
	Record<
		string,
		{ kept: number; rewritten: number; retired: number; reviewResolved: number }
	>
> {
	const ids =
		userIds ??
		(await db.select({ id: users.id }).from(users)).map((row) => row.id);
	const results: Record<
		string,
		{ kept: number; rewritten: number; retired: number; reviewResolved: number }
	> = {};
	for (const id of ids) {
		results[id] = await runMemoryRecuration(id);
	}
	return results;
}
