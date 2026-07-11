import { and, eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { memoryDirtyLedger } from "$lib/server/db/schema";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";

// Unicode-aware boundaries (\b breaks on accented letters like á in "rá").
const EXPLICIT_RE =
	/(?<![\p{L}])(?:please\s+)?(?:remember\s+(?:that|this)|jegyezd\s+meg|emlékezz(?:él)?\s+(?:rá|arra))(?![\p{L}])/iu;

export function detectExplicitMemoryRequest(text: string): boolean {
	return EXPLICIT_RE.test(text);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>(); // key: conversationId
const owners = new Map<string, string>(); // conversationId -> userId

export function scheduleConversationJudge(params: {
	userId: string;
	conversationId: string;
}): void {
	const existing = timers.get(params.conversationId);
	if (existing) clearTimeout(existing);
	owners.set(params.conversationId, params.userId);
	const delayMs = getConfig().memoryJudgeIdleMinutes * 60_000;
	const handle = setTimeout(() => {
		void fireJudge(params.userId, params.conversationId);
	}, delayMs);
	handle.unref?.();
	timers.set(params.conversationId, handle);
}

async function fireJudge(
	userId: string,
	conversationId: string,
): Promise<void> {
	timers.delete(conversationId);
	owners.delete(conversationId);
	try {
		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId,
			conversationId,
			trigger: "idle",
		});
		await completeDirtyRowsForConversation(userId, conversationId);
		// A backlog larger than one segment is drained oldest-first across
		// several passes. Re-mark dirty (after completing this pass's rows so the
		// mark survives) and reschedule an idle pass so the remainder drains
		// without waiting for the next consolidation sweep.
		if (result.status === "ran" && result.backlogRemaining) {
			await requeueConversationForDrain(userId, conversationId);
			scheduleConversationJudge({ userId, conversationId });
		}
	} catch (error) {
		console.error("[MEMORY_JUDGE] idle run failed:", error);
	}
}

async function requeueConversationForDrain(
	userId: string,
	conversationId: string,
): Promise<void> {
	const { markMemoryDirty } = await import("../memory-profile/dirty-ledger");
	await markMemoryDirty({
		userId,
		reason: "deferred_intake",
		scope: { type: "conversation", id: conversationId },
	});
}

export async function flushPendingJudgeRuns(userId: string): Promise<void> {
	const pending = [...owners.entries()]
		.filter(([, u]) => u === userId)
		.map(([c]) => c);
	for (const conversationId of pending) {
		const handle = timers.get(conversationId);
		if (handle) clearTimeout(handle);
		await fireJudge(userId, conversationId);
	}
}

export async function sweepDirtyConversations(userId: string): Promise<number> {
	const { listPendingMemoryDirtyEntries } = await import(
		"../memory-profile/dirty-ledger"
	);
	const pending = await listPendingMemoryDirtyEntries({ userId });
	const conversationIds = [
		...new Set(
			pending
				.filter(
					(p) =>
						p.reason === "deferred_intake" && p.scope?.type === "conversation",
				)
				.map((p) => (p.scope as { type: "conversation"; id: string }).id),
		),
	];
	let ran = 0;
	const { runMemoryJudgeOnSegment } = await import("./index");
	const { isConversationIncognito } = await import("../memory-controls");
	for (const conversationId of conversationIds) {
		// Defense in depth: a conversation may have been marked dirty before it
		// was flipped to incognito. Never judge an incognito conversation — just
		// clear its dirty rows so it doesn't linger in the queue.
		if (await isConversationIncognito(conversationId)) {
			await completeDirtyRowsForConversation(userId, conversationId);
			continue;
		}
		const result = await runMemoryJudgeOnSegment({
			userId,
			conversationId,
			trigger: "sweep",
		});
		if (result.status === "ran") ran++;
		await completeDirtyRowsForConversation(userId, conversationId);
		// If the segment loader left a backlog (conversation had more unjudged
		// messages than one segment holds), re-mark it dirty AFTER completing this
		// pass's rows so a subsequent sweep drains the remainder. The current
		// sweep only iterates the conversations gathered at entry, so this fresh
		// row is picked up next sweep — not looped here.
		if (result.status === "ran" && result.backlogRemaining) {
			await requeueConversationForDrain(userId, conversationId);
		}
	}
	return ran;
}

async function completeDirtyRowsForConversation(
	userId: string,
	conversationId: string,
): Promise<void> {
	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	await db
		.update(memoryDirtyLedger)
		.set({ status: "completed", completedAt: new Date() })
		.where(
			and(
				eq(memoryDirtyLedger.userId, userId),
				eq(memoryDirtyLedger.resetGeneration, resetGeneration),
				eq(memoryDirtyLedger.scopeType, "conversation"),
				eq(memoryDirtyLedger.scopeId, conversationId),
				eq(memoryDirtyLedger.status, "pending"),
			),
		)
		.run();
}

export function stopMemoryJudgeRunner(): void {
	for (const handle of timers.values()) clearTimeout(handle);
	timers.clear();
	owners.clear();
}
