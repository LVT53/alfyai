import { randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryConsolidationReports,
	memoryProfileItems,
	users,
} from "$lib/server/db/schema";
import { createIntervalJob } from "../interval-job";
import { listPendingMemoryDirtyEntries } from "../memory-profile/dirty-ledger";
import { getCurrentMemoryResetGeneration } from "../memory-profile/reset-generation";
import { recordMemoryReworkTelemetry } from "../memory-profile/telemetry";
import { NIGHT_SHIFT_EVENT_FAMILY } from "./event-family";
// Self namespace import so the scheduler's timer callback dispatches through the
// module's own export binding, which vi.spyOn can replace in tests.
import * as self from "./index";
import { NIGHT_SHIFT_SPINE } from "./spine";
import type { ConsolidationAction } from "./steps";

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
	reason?: string;
}): Promise<void> {
	try {
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: NIGHT_SHIFT_EVENT_FAMILY,
			eventName: "consolidation_run",
			status: params.status,
			count: params.count,
			reason: params.reason,
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
	reason?: string,
): Promise<MemoryConsolidationRunResult> {
	// Master memory toggle: a user who turned memory off gets no consolidation
	// (no reorganization, no summary regeneration, no model spend).
	const { isUserMemoryEnabled } = await import("../memory-controls");
	if (!(await isUserMemoryEnabled(userId))) {
		return { status: "skipped" };
	}
	if (await shouldSkipConsolidation(userId)) {
		return { status: "skipped" };
	}

	const resetGeneration = await getCurrentMemoryResetGeneration(userId);
	const actions: ConsolidationAction[] = [];

	try {
		// Walk the night-shift spine in order. Each step is transactional in its
		// own right, so writes applied before a later step throws stay applied —
		// the same guarantee the hand-inlined pipeline gave.
		let summaryRefreshed = false;
		for (const step of NIGHT_SHIFT_SPINE) {
			const result = await step.run({ userId });
			if (result.actions) actions.push(...result.actions);
			if (result.summaryRefreshed) summaryRefreshed = true;
		}
		const summaryText = buildSummaryText(actions, summaryRefreshed);

		const reportId = await writeReport({
			userId,
			resetGeneration,
			status: "succeeded",
			summaryText,
			actions,
		});
		await recordRunTelemetry({
			userId,
			status: "ok",
			count: actions.length,
			reason,
		});
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
			reason,
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
	since?: Date;
}): Promise<MemoryConsolidationReport[]> {
	const limit = params.limit ?? 20;
	const scope = params.since
		? and(
				eq(memoryConsolidationReports.userId, params.userId),
				gt(memoryConsolidationReports.createdAt, params.since),
			)
		: eq(memoryConsolidationReports.userId, params.userId);
	const rows = await db
		.select()
		.from(memoryConsolidationReports)
		.where(scope)
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

// One interval-job for the night shift. The tick dispatches through the module's
// own `self.runAllUsersMemoryConsolidation` export binding so tests can spy the
// timer callback (see index.test.ts "memory consolidation scheduler").
const consolidationJob = createIntervalJob({
	name: "MEMORY_CONSOLIDATION",
	periodMinutes: () => getConfig().memoryConsolidationIntervalMinutes,
	run: () => self.runAllUsersMemoryConsolidation("scheduler"),
});

export function ensureMemoryConsolidationScheduler(): void {
	consolidationJob.start();
}

export function stopMemoryConsolidationScheduler(): void {
	consolidationJob.stop();
}
