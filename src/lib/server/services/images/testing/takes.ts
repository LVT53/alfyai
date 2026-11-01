// Rows for card tests: a request and a take inserted as the engine would leave
// it. Call after the test reset the module registry (dynamic db import).

import { randomUUID } from "node:crypto";
import type { TakeRequest } from "../take-request";

export function takeRequest(overrides: Partial<TakeRequest> = {}): TakeRequest {
	return {
		v: 1,
		mode: "generate",
		prompt: "a cosy living room",
		inputs: [],
		baseFromUpload: false,
		canvas: { width: 1248, height: 832 },
		transparent: false,
		avoidSeeds: [],
		anchor: null,
		marks: null,
		title: "Cosy living room",
		summary: null,
		...overrides,
	};
}

let tick = 1_700_000_000;

export async function insertTake(input: {
	userId: string;
	conversationId: string;
	cardId: string;
	status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	seed?: number;
	hidden?: boolean;
	request?: TakeRequest;
	resultFileId?: string | null;
	phase?: string | null;
	phaseAt?: number | null;
	queueAhead?: number | null;
	progressPercent?: number | null;
	errorCode?: string | null;
	retryable?: boolean;
	origin?: "turn" | "retry" | "auto_retry" | "another";
	retryOf?: string | null;
	heldUntil?: number | null;
}): Promise<string> {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const id = randomUUID();
	tick += 1;
	db.insert(schema.imageJobs)
		.values({
			id,
			userId: input.userId,
			status: input.status ?? "succeeded",
			cardId: input.cardId,
			conversationId: input.conversationId,
			origin: input.origin ?? "turn",
			retryOf: input.retryOf ?? null,
			heldUntil: input.heldUntil ?? null,
			requestJson: JSON.stringify(input.request ?? takeRequest()),
			seed: input.seed ?? 7,
			hidden: input.hidden ? 1 : 0,
			resultFileId: input.resultFileId ?? null,
			phase: input.phase ?? null,
			phaseAt: input.phaseAt ?? null,
			queueAhead: input.queueAhead ?? null,
			progressPercent: input.progressPercent ?? null,
			errorCode: input.errorCode ?? null,
			retryable: input.retryable ?? false,
			createdAt: new Date(tick * 1000),
		})
		.run();
	return id;
}
