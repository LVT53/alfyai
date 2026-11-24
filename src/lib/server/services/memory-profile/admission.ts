import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { type DatabaseInstance, db } from "$lib/server/db";
import { memoryAccounts } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";

/**
 * How a memory model call declares its place in the admission queue
 * (`deploy/hindsight/alfyai_admission_queue.py`). The gateway admits every
 * `interactive` call (a person is waiting for this answer: the Overview
 * sheet) before any `background` one (curation jobs, the classifier, the
 * label migration); within a priority it takes Hindsight's own calls and the
 * app's in turn, and the app's tenants in turn, so one account's long run
 * never starves another's. A call that sends none of these headers is taken
 * for Hindsight's own.
 */
export type MemoryAdmissionPriority = "interactive" | "background";

export interface MemoryAdmission {
	priority: MemoryAdmissionPriority;
	/** The account's Memory tenant: its lane in the queue. Null shares one app lane. */
	tenantId: string | null;
}

export const BACKGROUND_MEMORY_ADMISSION: MemoryAdmission = {
	priority: "background",
	tenantId: null,
};

export const MEMORY_ADMISSION_HEADERS = {
	priority: "X-AlfyAI-Admission-Priority",
	lane: "X-AlfyAI-Admission-Lane",
	waitMs: "X-AlfyAI-Admission-Wait-Ms",
} as const;

/**
 * How long a call says it may wait in the queue before the gateway refuses it
 * (the gateway caps it at its own `admission_max_wait_s`). A person waiting
 * for the Overview gets an answer or a refusal within two minutes; background
 * work waits behind them and behind Hindsight's own calls.
 */
export const MEMORY_ADMISSION_WAIT_MS: Readonly<
	Record<MemoryAdmissionPriority, number>
> = { interactive: 120_000, background: 600_000 };

/** The model's own time once admitted: the gateway's upstream timeout. */
const MEMORY_MODEL_RUN_MS = 180_000;

/** A call's whole budget: its wait in the queue, then the model's own run. */
export function memoryAdmissionTimeoutMs(
	priority: MemoryAdmissionPriority,
): number {
	return MEMORY_ADMISSION_WAIT_MS[priority] + MEMORY_MODEL_RUN_MS;
}

/**
 * The tenant's lane: a stable digest the gateway can tell tenants apart by.
 * Never the tenant id itself, which also names the account's Hindsight schema.
 */
function admissionLane(tenantId: string): string {
	return createHash("sha256")
		.update(`alfyai-admission-lane\0${tenantId}`)
		.digest("hex")
		.slice(0, 32);
}

export function memoryAdmissionHeaders(
	admission: MemoryAdmission,
): Record<string, string> {
	return {
		[MEMORY_ADMISSION_HEADERS.priority]: admission.priority,
		...(admission.tenantId
			? { [MEMORY_ADMISSION_HEADERS.lane]: admissionLane(admission.tenantId) }
			: {}),
		[MEMORY_ADMISSION_HEADERS.waitMs]: String(
			MEMORY_ADMISSION_WAIT_MS[admission.priority],
		),
	};
}

/** The admission of a call made for this account, at this priority. */
export function memoryAdmissionFor(
	userId: string,
	priority: MemoryAdmissionPriority,
	database: DatabaseInstance | Tx = db,
): MemoryAdmission {
	const account = database
		.select({ tenantId: memoryAccounts.tenantId })
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	return { priority, tenantId: account?.tenantId ?? null };
}
