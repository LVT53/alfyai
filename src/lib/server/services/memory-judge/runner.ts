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
		await runMemoryJudgeOnSegment({ userId, conversationId, trigger: "idle" });
		await completeDirtyRowsForConversation(userId, conversationId);
	} catch (error) {
		console.error("[MEMORY_JUDGE] idle run failed:", error);
	}
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
	for (const conversationId of conversationIds) {
		const result = await runMemoryJudgeOnSegment({
			userId,
			conversationId,
			trigger: "sweep",
		});
		if (result.status === "ran") ran++;
		await completeDirtyRowsForConversation(userId, conversationId);
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
