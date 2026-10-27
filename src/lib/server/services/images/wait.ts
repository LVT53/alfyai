// Waiting for a take inside a tool call. The verdict wait is the job engine's
// own (`waitForVerdict`: its settle event plus a one-second poll, requeue
// aware); this adds the one thing a tool call needs on top of it, a heartbeat
// (`onTick`, once a second, so a long wait never reads as a silent stream) and
// one read of the take as the card shows it.

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { imageJobs } from "$lib/server/db/schema";
import { waitForVerdict } from "$lib/server/services/jobs";
import { imageJob } from "./image-job";
import type { ImageTakePhase } from "./read-model";
import type { StoredTakeMeasures } from "./take-request";

export type TakeSnapshot = {
	takeId: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	phase: ImageTakePhase | null;
	resultFileId: string | null;
	measures: StoredTakeMeasures | null;
	errorCode: string | null;
	retryable: boolean;
};

const TICK_MS = 1_000;
const PHASES: readonly string[] = [
	"submitted",
	"starting",
	"rendering",
	"finishing",
];

function parseMeasures(json: string | null): StoredTakeMeasures | null {
	if (!json) return null;
	try {
		const value: unknown = JSON.parse(json);
		return typeof value === "object" && value !== null
			? (value as StoredTakeMeasures)
			: null;
	} catch {
		return null;
	}
}

function statusOf(status: string): TakeSnapshot["status"] {
	return status === "queued" ||
		status === "running" ||
		status === "succeeded" ||
		status === "cancelled"
		? status
		: "failed";
}

/**
 * Waits up to `budgetMs` for the take to settle, calling `onTick` every second
 * meanwhile, then reads the take once. A take that has not settled comes back
 * `queued` or `running`; the signal ends the wait early the same way.
 */
export async function waitForTake(
	takeId: string,
	options: { budgetMs: number; signal: AbortSignal; onTick?: () => void },
): Promise<TakeSnapshot> {
	const ticker = options.onTick
		? setInterval(() => {
				try {
					options.onTick?.();
				} catch {
					// A heartbeat that fails never ends the wait.
				}
			}, TICK_MS)
		: null;
	ticker?.unref?.();
	try {
		await waitForVerdict(imageJob, takeId, {
			timeoutMs: options.budgetMs,
			signal: options.signal,
		});
	} finally {
		if (ticker) clearInterval(ticker);
	}
	const [row] = await db
		.select()
		.from(imageJobs)
		.where(eq(imageJobs.id, takeId))
		.limit(1);
	if (!row) {
		return {
			takeId,
			status: "failed",
			phase: null,
			resultFileId: null,
			measures: null,
			errorCode: "image_take_missing",
			retryable: false,
		};
	}
	return {
		takeId,
		status: statusOf(row.status),
		phase:
			row.phase && PHASES.includes(row.phase)
				? (row.phase as ImageTakePhase)
				: null,
		resultFileId: row.resultFileId,
		measures: parseMeasures(row.measuresJson),
		errorCode: row.errorCode,
		retryable: Boolean(row.retryable),
	};
}
