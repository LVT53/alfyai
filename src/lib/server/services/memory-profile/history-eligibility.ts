import { and, eq, lte } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryControlIntervals,
	memoryResetGenerations,
	users,
} from "$lib/server/db/schema";

export const HISTORY_POLICY_VERSION = "1";

type HistoricalControls = {
	account?: Pick<
		typeof memoryAccounts.$inferSelect,
		"historyChoice" | "historyCutoff" | "historyPolicyVersion"
	>;
	intervals: Pick<
		typeof memoryControlIntervals.$inferSelect,
		"startedAt" | "endedAt" | "enabled"
	>[];
	resetAt?: Date | null;
	enabled: boolean;
};

/** The same historical permission rules apply to sources and each piece of chat context. */
export function historicalMemoryExclusion(
	controls: HistoricalControls,
	input: { assertedAt: Date; incognito?: boolean; userAuthored?: boolean },
) {
	const { assertedAt: at } = input;
	if (!Number.isFinite(at.getTime())) return "missing_date";
	if (at.getTime() > Date.now()) return "future_date";
	if (!controls.enabled) return "memory_off";
	if (input.incognito) return "incognito";
	if (controls.resetAt && at <= controls.resetAt) return "pre_reset";

	const periods = controls.intervals.filter((i) => i.startedAt <= at);
	if (periods.some((i) => !i.enabled && (!i.endedAt || at <= i.endedAt)))
		return "known_off";
	// A message and a control change stored in the same second have no proven order.
	if (
		input.userAuthored ||
		periods.some(
			(i) => i.enabled && i.startedAt < at && (!i.endedAt || at < i.endedAt),
		)
	)
		return null;

	const account = controls.account;
	if (
		account?.historyChoice === "include" &&
		account.historyPolicyVersion === HISTORY_POLICY_VERSION &&
		account.historyCutoff &&
		at <= account.historyCutoff
	)
		return null;
	return "unknown_history";
}

/** Eligibility is checked before any native/model request, and again before publication. */
export function isHistoricalMemorySourceEligible(input: {
	userId: string;
	assertedAt: Date;
	incognito: boolean;
	excluded?: boolean;
	deleted?: boolean;
	userAuthored?: boolean;
}): boolean {
	if (input.incognito || input.excluded || input.deleted) return false;
	const { userId } = input;
	const user = db
		.select({ enabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user?.enabled) return false;
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	const reset = db
		.select({ at: memoryResetGenerations.advancedAt })
		.from(memoryResetGenerations)
		.where(eq(memoryResetGenerations.userId, userId))
		.get();
	const intervals = db
		.select()
		.from(memoryControlIntervals)
		.where(
			and(
				eq(memoryControlIntervals.userId, userId),
				lte(memoryControlIntervals.startedAt, input.assertedAt),
			),
		)
		.all();
	return (
		historicalMemoryExclusion(
			{ account, resetAt: reset?.at, intervals, enabled: user.enabled },
			input,
		) === null
	);
}
