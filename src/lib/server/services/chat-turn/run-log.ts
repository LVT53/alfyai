import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
	NormalChatCompletion,
	NormalChatStopCause,
} from "$lib/shared/normal-chat-completion";
import { db } from "../../db";
import { type normalChatAttempts, normalChatRunLog } from "../../db/schema";

/**
 * The anonymous run record (`normal_chat_run_log`): one row per Normal Chat
 * model run, so a model failure is known whatever happens to the chat. It keeps
 * no user, conversation or message id and no text, survives the deletion of all
 * three, and covers runs of incognito chats, whose row has no segment id and no
 * attempt ids and so cannot be joined to anything. The ledger
 * (`turn-ledger.ts`) is the audit that goes with its conversation; this is the
 * trace that stays.
 *
 * Every write here is best effort: it never throws, and a failed one leaves one
 * content-free warning. A row whose `settled_at` stays null means the run never
 * reported an end; nothing sweeps it.
 */

/** One attempt as the record keeps it. `attemptId` is null for an incognito run. */
export type RunLogAttempt = {
	attemptId: string | null;
	phase: "working" | "closing";
	providerId: string | null;
	modelId: string;
	providerModelName: string;
	outcome: NormalChatCompletion["outcome"] | null;
	safeStopCause: NormalChatStopCause | null;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	usageFinal: boolean;
	generationTimeMs: number | null;
	/** Only where the ledger priced it. */
	costUsdMicros?: number | null;
};

export type RunLogOutcome = {
	outcome: NormalChatCompletion["outcome"] | null;
	stopCause: NormalChatStopCause | null;
	workingStopCause: NormalChatStopCause | null;
	phase: NormalChatCompletion["phase"] | null;
	closingAttempted: boolean;
	recoveryCount: number;
	saved: boolean;
	attempts: readonly RunLogAttempt[];
};

/** The turn's timing as finalize knows it (all ms, server side). */
export type RunLogTiming = {
	firstByteMs?: number | null;
	firstThinkingMs?: number | null;
	firstTokenMs?: number | null;
	generationTimeMs?: number | null;
};

export type TurnSettledFacts = {
	/** Null for a turn that left no ledger row (an incognito chat). */
	segmentId: string | null;
	outcome: string | null;
	stopCause: string | null;
	workingStopCause: string | null;
	phase: string | null;
	closingAttempted: boolean;
	recoveryCount: number;
	/** A reply was saved and linked. */
	saved: boolean;
	accountingStatus: string | null;
	attempts: readonly {
		/** Null for an attempt that left no ledger row. */
		attemptId: string | null;
		phase: string;
		outcome: string | null;
		safeStopCause: string | null;
		modelId: string;
	}[];
};

/**
 * One status line for the server log the first time a turn's outcome is
 * written: the ledger rows go with their conversation, the line does not. Only
 * `key=value` facts of the turn, never a user, conversation or message id, a
 * title or any text; the attempt ids are there so that a billing row
 * (`turn-attempt:<attemptId>`) of a deleted chat can still be matched to the
 * outcome. Logging must never fail the settle it reports.
 */
export function logTurnSettled(facts: TurnSettledFacts): void {
	try {
		const attempts = facts.attempts
			.map((a) =>
				[
					a.attemptId,
					a.phase,
					a.outcome ?? "-",
					a.safeStopCause ?? "-",
					a.modelId,
				]
					.filter((part) => part !== null)
					.join(":"),
			)
			.join(",");
		console.info(
			`[TURN_SETTLED] segment=${facts.segmentId?.slice(0, 8) ?? "-"} outcome=${facts.outcome ?? "-"} stop=${facts.stopCause ?? "-"} working=${facts.workingStopCause ?? "-"} phase=${facts.phase ?? "-"} closing=${facts.closingAttempted ? 1 : 0} recovery=${facts.recoveryCount} saved=${facts.saved ? 1 : 0} accounting=${facts.accountingStatus ?? "-"} attempts=${attempts || "-"}`,
		);
	} catch {
		// A status line is never worth a failed settle.
	}
}

/** The run's own id, or its ledger segment (a run settled by another process). */
type RunKey = { id: string } | { segmentId: string };

const matches = (key: RunKey) =>
	"id" in key
		? eq(normalChatRunLog.id, key.id)
		: eq(normalChatRunLog.segmentId, key.segmentId);

function guarded<T>(operation: string, write: () => T): T | undefined {
	try {
		return write();
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		console.warn(
			`[RUN_LOG] write failed op=${operation} code=${typeof code === "string" ? code : "-"}`,
		);
		return undefined;
	}
}

const ms = (value: number | null | undefined): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.round(value)
		: null;

/** The attempt as the ledger holds it, for a run settled from the ledger. */
export function runLogAttemptFromLedger(
	row: typeof normalChatAttempts.$inferSelect,
): RunLogAttempt {
	return {
		attemptId: row.attemptId,
		phase: row.phase,
		providerId: row.providerId,
		modelId: row.modelId,
		providerModelName: row.providerModelName,
		outcome: row.outcome,
		safeStopCause: row.safeStopCause,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		reasoningTokens: row.reasoningTokens,
		totalTokens: row.totalTokens,
		usageFinal: row.usageFinal,
		generationTimeMs: row.generationTimeMs,
		costUsdMicros: row.costUsdMicros,
	};
}

/** Opens the record when a lifetime begins; returns its fresh id (never the segment id), or null. */
export function openRunLog(input: {
	tracked: boolean;
	segmentId: string | null;
}): string | null {
	const id = randomUUID();
	return (
		guarded("open", () => {
			db.insert(normalChatRunLog)
				.values({
					id,
					tracked: input.tracked,
					segmentId: input.tracked ? input.segmentId : null,
					startedAt: new Date(),
				})
				.run();
			return id;
		}) ?? null
	);
}

/** Brings the attempts up to date while the run is open, so a run that never settles still names its model. */
export function recordRunLogAttempts(
	id: string | null,
	attempts: readonly RunLogAttempt[],
): void {
	if (!id) return;
	guarded("attempts", () =>
		db
			.update(normalChatRunLog)
			.set({ attemptsJson: JSON.stringify(attempts) })
			.where(
				and(eq(normalChatRunLog.id, id), isNull(normalChatRunLog.settledAt)),
			)
			.run(),
	);
}

/** Writes the outcome facts, once: only a record still open takes them. */
export function settleRunLog(key: RunKey, facts: RunLogOutcome): void {
	guarded("settle", () =>
		db
			.update(normalChatRunLog)
			.set({
				settledAt: new Date(),
				outcome: facts.outcome,
				stopCause: facts.stopCause,
				workingStopCause: facts.workingStopCause,
				phase: facts.phase,
				closingAttempted: facts.closingAttempted,
				recoveryCount: facts.recoveryCount,
				saved: facts.saved,
				attemptsJson: JSON.stringify(facts.attempts),
			})
			.where(and(matches(key), isNull(normalChatRunLog.settledAt)))
			.run(),
	);
}

/**
 * Fills in what only a later call knows: that a reply was saved, and the timing
 * finalize holds. Each is set once and never overwritten, so a repeated call
 * changes nothing.
 */
export function completeRunLog(
	key: RunKey,
	late: { saved: boolean; timing?: RunLogTiming },
): void {
	const timing = late.timing;
	if (!late.saved && !timing) return;
	guarded("complete", () =>
		db
			.update(normalChatRunLog)
			.set({
				saved: sql`${normalChatRunLog.saved} or ${late.saved ? 1 : 0}`,
				firstByteMs: sql`coalesce(${normalChatRunLog.firstByteMs}, ${ms(timing?.firstByteMs)})`,
				firstThinkingMs: sql`coalesce(${normalChatRunLog.firstThinkingMs}, ${ms(timing?.firstThinkingMs)})`,
				firstTokenMs: sql`coalesce(${normalChatRunLog.firstTokenMs}, ${ms(timing?.firstTokenMs)})`,
				generationTimeMs: sql`coalesce(${normalChatRunLog.generationTimeMs}, ${ms(timing?.generationTimeMs)})`,
			})
			.where(matches(key))
			.run(),
	);
}
