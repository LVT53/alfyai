import { randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryConsolidationReports,
	memoryProfileItems,
	users,
} from "$lib/server/db/schema";
import { sweepDirtyConversations } from "../memory-judge/runner";
import { listPendingMemoryDirtyEntries } from "../memory-profile/dirty-ledger";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";
// Self namespace import so the scheduler's timer callback dispatches through the
// module's own export binding, which vi.spyOn can replace in tests.
import * as self from "./index";
import type { ConsolidationAction } from "./steps";
import { runExpireAndRenew, runReconcileAndMerge } from "./steps";
import { generateAndStorePersonaSummary } from "./summary";

export type MemoryConsolidationRunResult = {
	status: "succeeded" | "failed" | "skipped";
	reportId?: string;
};

export type MemoryConsolidationReport = {
	id: string;
	status: string;
	summaryText: string;
	createdAt: Date;
	actions: ConsolidationAction[];
};

/**
 * Return the createdAt of the newest succeeded report, or null when there are
 * no succeeded reports yet (in which case a run must never be skipped).
 */
async function latestSucceededReportCreatedAt(
	userId: string,
): Promise<Date | null> {
	const [row] = await db
		.select({ createdAt: memoryConsolidationReports.createdAt })
		.from(memoryConsolidationReports)
		.where(
			and(
				eq(memoryConsolidationReports.userId, userId),
				eq(memoryConsolidationReports.status, "succeeded"),
			),
		)
		.orderBy(desc(memoryConsolidationReports.createdAt))
		.limit(1);
	return row?.createdAt ?? null;
}

/**
 * Change detection: skip a run only when there is nothing new to consolidate —
 * i.e. no pending deferred_intake dirty rows AND no memory profile item touched
 * more recently than the last succeeded report. With no prior report we never
 * skip.
 */
async function shouldSkipConsolidation(userId: string): Promise<boolean> {
	const lastReportAt = await latestSucceededReportCreatedAt(userId);
	if (!lastReportAt) return false;

	const pending = await listPendingMemoryDirtyEntries({ userId });
	const hasDeferredIntake = pending.some((p) => p.reason === "deferred_intake");
	if (hasDeferredIntake) return false;

	const [changed] = await db
		.select({ id: memoryProfileItems.id })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, userId),
				gt(memoryProfileItems.updatedAt, lastReportAt),
			),
		)
		.limit(1);
	return !changed;
}

/**
 * Assemble a one-sentence, plain-English summary of a consolidation run from
 * the accumulated actions. When the persona summary was regenerated we always
 * say so, even with zero structural actions.
 */
function buildSummaryText(
	actions: ConsolidationAction[],
	summaryRefreshed: boolean,
): string {
	const merged = actions.filter((a) => a.type === "merged").length;
	const superseded = actions.filter((a) => a.type === "superseded").length;
	const expired = actions
		.filter((a) => a.type === "expired")
		.reduce((sum, a) => sum + a.itemIds.length, 0);
	const renewed = actions
		.filter((a) => a.type === "renewed")
		.reduce((sum, a) => sum + a.itemIds.length, 0);

	const parts: string[] = [];
	if (merged > 0) parts.push(`Merged ${merged}`);
	if (superseded > 0) parts.push(`superseded ${superseded}`);
	if (expired > 0) parts.push(`retired ${expired} expired`);
	if (renewed > 0) parts.push(`renewed ${renewed}`);
	if (summaryRefreshed) parts.push("refreshed your summary");

	if (parts.length === 0) return "No changes needed.";

	// Capitalise the first fragment (later ones stay lowercase mid-sentence).
	const [first, ...rest] = parts;
	const head = first.charAt(0).toUpperCase() + first.slice(1);
	const sentence = [head, ...rest].join(", ");
	return `${sentence}.`;
}

async function writeReport(params: {
	userId: string;
	resetGeneration: number;
	status: "succeeded" | "failed";
	summaryText: string;
	actions: ConsolidationAction[];
}): Promise<string> {
	const id = randomUUID();
	await db
		.insert(memoryConsolidationReports)
		.values({
			id,
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			status: params.status,
			summaryText: params.summaryText,
			actionsJson: JSON.stringify(params.actions),
			createdAt: new Date(),
		})
		.run();
	return id;
}

async function recordRunTelemetry(params: {
	userId: string;
	status: "ok" | "error";
	count: number;
}): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "consolidation_run",
			status: params.status,
			count: params.count,
		});
	} catch {
		// Telemetry is best-effort; never fail a run over it.
	}
}

/**
 * Run the full consolidation pipeline for one user:
 *   sweep dirty conversations → expire/renew → reconcile/merge → persona summary.
 *
 * Writes a report row on every run that is not skipped. Any thrown error is
 * caught: a failed report is written with the error's constructor name and
 * {status:"failed"} is returned — the error is never rethrown. Individual steps
 * are transactional, so writes applied before a failure stay applied and the
 * failed report makes that visible.
 */
export async function runUserMemoryConsolidation(
	userId: string,
	_reason?: string,
): Promise<MemoryConsolidationRunResult> {
	if (await shouldSkipConsolidation(userId)) {
		return { status: "skipped" };
	}

	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const actions: ConsolidationAction[] = [];

	try {
		await sweepDirtyConversations(userId);
		actions.push(...(await runExpireAndRenew({ userId })));
		actions.push(...(await runReconcileAndMerge({ userId })));
		const summary = await generateAndStorePersonaSummary({ userId });
		const summaryText = buildSummaryText(actions, summary !== null);

		const reportId = await writeReport({
			userId,
			resetGeneration,
			status: "succeeded",
			summaryText,
			actions,
		});
		await recordRunTelemetry({ userId, status: "ok", count: actions.length });
		return { status: "succeeded", reportId };
	} catch (error) {
		const errorName = error instanceof Error ? error.constructor.name : "Error";
		const reportId = await writeReport({
			userId,
			resetGeneration,
			status: "failed",
			summaryText: `Failed during consolidation: ${errorName}`,
			actions,
		});
		await recordRunTelemetry({
			userId,
			status: "error",
			count: actions.length,
		});
		return { status: "failed", reportId };
	}
}

function parseActionsJson(actionsJson: string): ConsolidationAction[] {
	try {
		const parsed = JSON.parse(actionsJson);
		return Array.isArray(parsed) ? (parsed as ConsolidationAction[]) : [];
	} catch {
		return [];
	}
}

/**
 * List a user's consolidation reports, newest first. actionsJson is parsed
 * defensively — malformed JSON degrades to an empty actions array.
 */
export async function listMemoryConsolidationReports(params: {
	userId: string;
	limit?: number;
}): Promise<MemoryConsolidationReport[]> {
	const limit = params.limit ?? 20;
	const rows = await db
		.select()
		.from(memoryConsolidationReports)
		.where(eq(memoryConsolidationReports.userId, params.userId))
		.orderBy(desc(memoryConsolidationReports.createdAt))
		.limit(limit);

	return rows.map((row) => ({
		id: row.id,
		status: row.status,
		summaryText: row.summaryText,
		createdAt: row.createdAt,
		actions: parseActionsJson(row.actionsJson),
	}));
}

/**
 * Run consolidation for every user, one at a time with a small gap to avoid
 * bursting the control model. Exported so the scheduler (and tests) can drive
 * it without reaching into module internals.
 */
export async function runAllUsersMemoryConsolidation(
	reason = "scheduler",
): Promise<void> {
	const rows = await db.select({ id: users.id }).from(users);
	for (let i = 0; i < rows.length; i++) {
		if (i > 0) {
			await new Promise((r) => setTimeout(r, 200));
		}
		await runUserMemoryConsolidation(rows[i].id, reason);
	}
}

let schedulerStarted = false;
let schedulerHandle: ReturnType<typeof setInterval> | null = null;

export function ensureMemoryConsolidationScheduler(): void {
	if (schedulerStarted) return;
	const intervalMinutes = getConfig().memoryConsolidationIntervalMinutes;
	if (!intervalMinutes || intervalMinutes <= 0) return;

	schedulerStarted = true;
	schedulerHandle = setInterval(() => {
		void self.runAllUsersMemoryConsolidation("scheduler");
	}, intervalMinutes * 60_000);
	schedulerHandle.unref?.();
	console.info("[MEMORY_CONSOLIDATION] Scheduler enabled", { intervalMinutes });
}

export function stopMemoryConsolidationScheduler(): void {
	if (schedulerHandle) {
		clearInterval(schedulerHandle);
		schedulerHandle = null;
	}
	schedulerStarted = false;
}
