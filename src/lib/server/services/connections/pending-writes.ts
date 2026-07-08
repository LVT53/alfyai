import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { connectionPendingWrites } from "$lib/server/db/schema";

// ---------------------------------------------------------------------------
// Pending-write store (Issue 4.3) — the "explicit confirm" chokepoint between
// a tool's write proposal (files.ts "save" action) and the actual mutation
// (executeNextcloudWrite, 4.2). A row here is created ONCE with status
// "pending" and NEVER executed at creation time; only confirmPendingWrite
// (below) can transition it to "executed", and only after successfully
// calling the guarded executor. `cancelPendingWrite` transitions it to
// "cancelled" instead, after which a confirm is permanently refused.
// ---------------------------------------------------------------------------

import {
	executeNextcloudWrite,
	type NextcloudWriteRequest,
} from "./providers/nextcloud-files";
import type { WriteOperation, WritePreview } from "./write-guard";

type PendingWriteRow = typeof connectionPendingWrites.$inferSelect;

export type PendingWriteStatus = "pending" | "executed" | "cancelled";

export type PendingWriteRecord = {
	id: string;
	userId: string;
	connectionId: string;
	provider: string;
	op: WriteOperation;
	content: string;
	idempotencyKey: string;
	status: PendingWriteStatus;
	preview: WritePreview;
	createdAt: number;
};

// The persisted shape of `op_json` — the serialized WriteOperation plus the
// text payload the assistant produced. TEXT only (brief, 4.3): large binary
// payloads are explicitly out of scope for this table.
type PendingWriteOpJson = { op: WriteOperation; content: string };

function toRecord(row: PendingWriteRow): PendingWriteRecord {
	const parsed = JSON.parse(row.opJson) as PendingWriteOpJson;
	return {
		id: row.id,
		userId: row.userId,
		connectionId: row.connectionId,
		provider: row.provider,
		op: parsed.op,
		content: parsed.content,
		idempotencyKey: row.idempotencyKey,
		status: row.status as PendingWriteStatus,
		preview: JSON.parse(row.previewJson) as WritePreview,
		createdAt: Math.floor(row.createdAt.getTime() / 1000),
	};
}

function scoped(userId: string, id: string) {
	return and(
		eq(connectionPendingWrites.userId, userId),
		eq(connectionPendingWrites.id, id),
	);
}

// Creates a PENDING write row. This function — and this module in general —
// never calls executeNextcloudWrite itself at creation time; only
// confirmPendingWrite does, and only later, after the user has explicitly
// confirmed.
export async function createPendingWrite(
	userId: string,
	params: {
		connectionId: string;
		provider: string;
		op: WriteOperation;
		content: string;
		idempotencyKey: string;
		preview: WritePreview;
	},
): Promise<{ id: string; preview: WritePreview }> {
	const id = randomUUID();
	const opJson: PendingWriteOpJson = { op: params.op, content: params.content };
	await db.insert(connectionPendingWrites).values({
		id,
		userId,
		connectionId: params.connectionId,
		provider: params.provider,
		opJson: JSON.stringify(opJson),
		idempotencyKey: params.idempotencyKey,
		status: "pending",
		previewJson: JSON.stringify(params.preview),
		createdAt: new Date(),
	});
	return { id, preview: params.preview };
}

// User-scoped lookup — returns null (never throws, never leaks another
// user's row) when the id doesn't exist or belongs to a different user.
export async function getPendingWrite(
	userId: string,
	id: string,
): Promise<PendingWriteRecord | null> {
	const [row] = await db
		.select()
		.from(connectionPendingWrites)
		.where(scoped(userId, id));
	return row ? toRecord(row) : null;
}

// Conditional update — only a row still in "pending" is moved to "executed";
// this is the atomic guard confirmPendingWrite relies on to never execute the
// same write twice. Returns false (no-op) if the row is missing, owned by a
// different user, or already past "pending".
export async function markPendingWriteExecuted(
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.update(connectionPendingWrites)
		.set({ status: "executed" })
		.where(
			and(scoped(userId, id), eq(connectionPendingWrites.status, "pending")),
		);
	return result.changes > 0;
}

// Conditional update — only a still-"pending" row can be cancelled. Returns
// false for a missing/other-user/already-resolved row, same shape as
// markPendingWriteExecuted.
export async function cancelPendingWrite(
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.update(connectionPendingWrites)
		.set({ status: "cancelled" })
		.where(
			and(scoped(userId, id), eq(connectionPendingWrites.status, "pending")),
		);
	return result.changes > 0;
}

// Only "files.put" is supported by the confirm executor today (the only
// write action a tool can currently propose, files.ts "save"). Any other
// action is refused rather than silently mis-executed.
function toNextcloudWriteRequest(
	op: WriteOperation,
	content: string,
): NextcloudWriteRequest | null {
	if (op.action !== "files.put") return null;
	const MAX_SUMMARY_CHARS = 200;
	const contentSummary =
		content.length > MAX_SUMMARY_CHARS
			? `${content.slice(0, MAX_SUMMARY_CHARS)}…`
			: content;
	return {
		kind: "put",
		requestedPath: op.target?.path,
		bytes: new TextEncoder().encode(content),
		contentSummary,
	};
}

export type ConfirmPendingWriteResult =
	| { ok: true; alreadyExecuted: boolean; etag?: string | null }
	| { ok: false; status: 404 | 409; reason: string };

// The single chokepoint that turns a confirmed pending write into a real
// mutation, via executeNextcloudWrite (4.2). Idempotent: a pending write
// already in "executed" short-circuits to a success response WITHOUT calling
// the executor again (guarded on status, not merely on idempotencyKey, since
// the id itself already pins the confirm to one specific pending write). A
// "cancelled" (or missing/other-user) pending write is refused outright.
export async function confirmPendingWrite(
	userId: string,
	id: string,
	opts?: { fetch?: typeof fetch },
): Promise<ConfirmPendingWriteResult> {
	const record = await getPendingWrite(userId, id);
	if (!record) {
		return { ok: false, status: 404, reason: "not_found" };
	}
	if (record.status === "executed") {
		return { ok: true, alreadyExecuted: true };
	}
	if (record.status === "cancelled") {
		return { ok: false, status: 409, reason: "cancelled" };
	}

	const request = toNextcloudWriteRequest(record.op, record.content);
	if (!request) {
		return { ok: false, status: 409, reason: "unsupported_operation" };
	}

	const result = await executeNextcloudWrite(
		userId,
		record.connectionId,
		request,
		opts,
	);
	if (!result.ok) {
		return { ok: false, status: 409, reason: result.reason };
	}

	await markPendingWriteExecuted(userId, id);
	return { ok: true, alreadyExecuted: false, etag: result.etag ?? null };
}
