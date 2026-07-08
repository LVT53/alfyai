import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { connectionPendingWrites } from "$lib/server/db/schema";

// ---------------------------------------------------------------------------
// Pending-write store (Issue 4.3) — the "explicit confirm" chokepoint between
// a tool's write proposal (files.ts "save" action) and the actual mutation,
// dispatched by provider via the write-executor registry (Issue 6.0; see
// write-executors.ts). A row here is created ONCE with status "pending" and
// NEVER executed at creation time.
//
// Status lifecycle: pending -> executing -> executed | failed, or
// pending -> cancelled. The pending -> executing transition
// (claimPendingWrite) is a single conditional UPDATE that runs BEFORE the
// dispatched executor is ever called — this is what makes "executes exactly
// once" hold under concurrent confirms (two POST /confirm calls racing each
// other, a client retry, multiple server workers). Only the confirm that
// wins the claim (changes === 1) may call the executor; a loser
// (changes === 0) returns without ever touching the provider. This replaces
// an earlier, buggy version of this module that checked `status` in
// application code and only updated the row AFTER awaiting the network call
// — a classic TOCTOU race (flagged in 4.3 review).
// ---------------------------------------------------------------------------

// Side-effect import ONLY — loads providers/nextcloud-files.ts so its
// top-level registerWriteExecutor("nextcloud", ...) call (Issue 6.0) has run
// before confirmPendingWrite below ever dispatches to getWriteExecutor. This
// mirrors how, before 6.0, this module's own direct import of
// executeNextcloudWrite from the same file caused the same module evaluation
// (and its registerConnectionAdapter side effect) to happen as a byproduct.
// Nothing in this module calls into nextcloud-files.ts directly anymore —
// dispatch happens purely through the write-executors registry — but the
// registration still needs to run somewhere in every path that reaches
// confirmPendingWrite (prod request handling AND pending-writes.test.ts,
// which does not import nextcloud-files.ts itself).
import "./providers/nextcloud-files";
import { getWriteExecutor } from "./write-executors";
import type { WriteOperation, WritePreview } from "./write-guard";

type PendingWriteRow = typeof connectionPendingWrites.$inferSelect;

export type PendingWriteStatus =
	| "pending"
	| "executing"
	| "executed"
	| "cancelled"
	| "failed";

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
	etag: string | null;
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
		etag: row.etag ?? null,
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

// THE atomic claim. A single conditional UPDATE that flips "pending" ->
// "executing" — this MUST run, and its result MUST be checked, before
// confirmPendingWrite calls executeNextcloudWrite. Two concurrent confirms
// racing on the same row both read "pending", but only one of the two
// UPDATE...WHERE status='pending' statements can actually match a row
// (SQLite serializes writes), so only one caller ever sees `true` here. The
// loser sees `false` and must NOT execute. Returns false (no-op, i.e. "you
// did not win the claim") if the row is missing, owned by a different user,
// or already past "pending" (already claimed, executed, cancelled, or
// failed).
export async function claimPendingWrite(
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.update(connectionPendingWrites)
		.set({ status: "executing" })
		.where(
			and(scoped(userId, id), eq(connectionPendingWrites.status, "pending")),
		);
	return result.changes > 0;
}

// Conditional update — only a row the caller itself just claimed (status
// "executing") is moved to "executed"; this can never race because only the
// caller that won claimPendingWrite ever reaches this call for a given row.
// Also records the etag from a successful "put" so a later already-executed
// confirm can still report it. Returns false if the row is missing, owned by
// a different user, or (should not happen in practice) no longer
// "executing".
export async function markPendingWriteExecuted(
	userId: string,
	id: string,
	etag: string | null = null,
): Promise<boolean> {
	const result = await db
		.update(connectionPendingWrites)
		.set({ status: "executed", etag })
		.where(
			and(scoped(userId, id), eq(connectionPendingWrites.status, "executing")),
		);
	return result.changes > 0;
}

// Conditional update — moves a claimed-but-failed row from "executing" to a
// terminal "failed" status. This is deliberately NOT reopened back to
// "pending": a caller that already claimed and attempted the write may have
// failed for a reason that would fail identically on retry (unsupported
// operation, allowlist violation, auth failure), and leaving the row
// "executing" forever would be a bug (a permanently stuck row that can never
// be claimed again). "failed" is a dead end — same as "cancelled" — a later
// confirm on a "failed" row is refused, not silently retried.
export async function markPendingWriteFailed(
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.update(connectionPendingWrites)
		.set({ status: "failed" })
		.where(
			and(scoped(userId, id), eq(connectionPendingWrites.status, "executing")),
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

export type ConfirmPendingWriteResult =
	| { ok: true; alreadyExecuted: boolean; etag?: string | null }
	| { ok: false; status: 404 | 409; reason: string };

// The single chokepoint that turns a confirmed pending write into a real
// mutation, dispatched by `record.provider` to whichever WriteExecutor is
// registered for it (Issue 6.0 — write-executors.ts). Idempotent AND safe
// under concurrency: a pending write already in "executed" short-circuits to
// a success response WITHOUT calling the executor again, and — critically —
// the "pending" -> "executing" transition is claimed ATOMICALLY
// (claimPendingWrite) BEFORE the dispatched executor is ever called. Two
// concurrent confirms for the same id can both read "pending" from
// getPendingWrite, but only one of them can win the claim; the other sees
// `claimed === false` and returns without touching the provider at all. A
// "cancelled"/"failed" (or missing/other-user) pending write is refused
// outright; a row another confirm currently has claimed ("executing") is
// also refused rather than raced.
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
		return { ok: true, alreadyExecuted: true, etag: record.etag };
	}
	if (record.status === "cancelled") {
		return { ok: false, status: 409, reason: "cancelled" };
	}
	if (record.status === "failed") {
		return { ok: false, status: 409, reason: "failed" };
	}
	if (record.status === "executing") {
		// Another confirm has already claimed this row and is (or was)
		// mid-flight. Refuse rather than issuing a second, racing call to
		// the dispatched executor — this is the state a losing confirm
		// should land in when it reads the row AFTER the winner's claim
		// commits.
		return { ok: false, status: 409, reason: "in_progress" };
	}

	// record.status === "pending" here. Claim BEFORE doing anything that
	// talks to the provider. This is the fix for the TOCTOU race:
	// previously this function checked `record.status` (read above) and
	// only updated the row AFTER awaiting the write, so two concurrent
	// confirms could both pass the check and both issue a real write.
	const claimed = await claimPendingWrite(userId, id);
	if (!claimed) {
		// Lost the race: something else (another confirm) claimed or
		// resolved this row between our read and our claim attempt.
		// Re-fetch to report the current, authoritative state rather than
		// guessing from the stale `record` we already have.
		const latest = await getPendingWrite(userId, id);
		if (latest?.status === "executed") {
			return { ok: true, alreadyExecuted: true, etag: latest.etag };
		}
		return { ok: false, status: 409, reason: "in_progress" };
	}

	// Provider dispatch (Issue 6.0) — an unregistered provider is refused
	// exactly like Nextcloud's own "unsupported operation" case used to be
	// (previously a null `toNextcloudWriteRequest`): the row was already
	// claimed above, so it must move to a terminal "failed" state rather
	// than being left stuck in "executing".
	const executor = getWriteExecutor(record.provider);
	if (!executor) {
		await markPendingWriteFailed(userId, id);
		return { ok: false, status: 409, reason: "unsupported_operation" };
	}

	const result = await executor.execute(
		userId,
		record.connectionId,
		record.op,
		record.content,
		opts,
	);
	if (!result.ok) {
		// The claim succeeded but the real write failed. Move to "failed"
		// (not back to "pending" — see markPendingWriteFailed) so the row
		// never sits in "executing" forever.
		await markPendingWriteFailed(userId, id);
		return { ok: false, status: 409, reason: result.reason };
	}

	await markPendingWriteExecuted(userId, id, result.etag ?? null);
	return { ok: true, alreadyExecuted: false, etag: result.etag ?? null };
}
