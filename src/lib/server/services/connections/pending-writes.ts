import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

// Side-effect imports ONLY — load providers/nextcloud-files.ts,
// providers/google-calendar-write.ts, providers/apple-caldav-write.ts,
// providers/imap-write.ts, and providers/immich-write.ts so their top-level
// registerWriteExecutor(...) calls (Issue 6.0, 6.1, 6.2, 6.3, 6.4) have run
// before confirmPendingWrite below ever dispatches to getWriteExecutor.
// This mirrors how, before 6.0, this module's own direct import of
// executeNextcloudWrite from the same file caused the same module evaluation
// (and its registerConnectionAdapter side effect) to happen as a byproduct.
// Nothing in this module calls into any provider module directly anymore —
// dispatch happens purely through the write-executors registry — but each
// registration still needs to run somewhere in every path that reaches
// confirmPendingWrite (prod request handling AND every *.test.ts here that
// exercises confirm without importing the provider module itself).
import "./providers/nextcloud-files";
import "./providers/google-calendar-write";
import "./providers/apple-caldav-write";
import "./providers/imap-write";
import "./providers/immich-write";
import { getConnection } from "./store";
import { getWriteExecutor } from "./write-executors";
import type { WriteOperation, WritePreview } from "./write-guard";

type PendingWriteRow = typeof connectionPendingWrites.$inferSelect;

export type PendingWriteStatus =
	| "pending"
	| "executing"
	| "executed"
	| "cancelled"
	| "failed";

// Fix 1 (write-safety hardening) — TTL for the confirm chokepoint. Without
// an expiry, a pending write proposed once could be confirmed arbitrarily
// far in the future against state that has since changed underneath it
// (a stale etag/uidValidity/allowlist, or just a very old, forgotten
// proposal). 30 minutes comfortably covers a normal "propose, read the
// preview, click confirm" turnaround without leaving a proposal live
// indefinitely.
export const PENDING_WRITE_TTL_MS = 30 * 60 * 1000;

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
	// Issue 7.5 — nullable association to the conversation/assistant message
	// that proposed this write. conversationId is set at creation time (the
	// write tool already has it via ctx); assistantMessageId is unknown
	// until the turn finalizes and is backfilled by
	// assignPendingWritesToAssistantMessage below (mirrors
	// file-production's assignFileProductionJobsToAssistantMessage).
	conversationId: string | null;
	assistantMessageId: string | null;
	createdAt: number;
	// Fix 1 — epoch seconds (same shape as createdAt) after which
	// confirmPendingWrite refuses this row with reason "expired", or null for
	// a row that predates this column (backward-compatible: NULL never
	// expires). Always set on rows created via createPendingWrite below.
	expiresAt: number | null;
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
		conversationId: row.conversationId ?? null,
		assistantMessageId: row.assistantMessageId ?? null,
		createdAt: Math.floor(row.createdAt.getTime() / 1000),
		expiresAt: row.expiresAt
			? Math.floor(row.expiresAt.getTime() / 1000)
			: null,
	};
}

// True iff `expiresAt` (epoch seconds, or null for "no expiry") has passed
// as of `now`. NULL is backward-compat for rows that predate the expiresAt
// column — never expired (Fix 1).
function isPendingWriteExpired(
	expiresAt: number | null,
	now: number = Date.now(),
): boolean {
	return expiresAt !== null && expiresAt * 1000 <= now;
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
		// Issue 7.5 — threaded in from the tool call's ctx.conversationId.
		// Optional/undefined for callers (and existing tests) that don't
		// carry a conversation — the column is nullable.
		conversationId?: string | null;
	},
): Promise<{ id: string; preview: WritePreview }> {
	const id = randomUUID();
	const opJson: PendingWriteOpJson = { op: params.op, content: params.content };
	const now = new Date();
	await db.insert(connectionPendingWrites).values({
		id,
		userId,
		connectionId: params.connectionId,
		provider: params.provider,
		opJson: JSON.stringify(opJson),
		idempotencyKey: params.idempotencyKey,
		status: "pending",
		previewJson: JSON.stringify(params.preview),
		conversationId: params.conversationId ?? null,
		createdAt: now,
		// Fix 1 — every new row gets a TTL; only rows created before this
		// column existed can ever be NULL (see isPendingWriteExpired).
		expiresAt: new Date(now.getTime() + PENDING_WRITE_TTL_MS),
	});
	return { id, preview: params.preview };
}

// User+conversation-scoped listing for the GET pending-writes endpoint
// (Issue 7.5) — mirrors listConversationFileProductionJobs. Only rows that
// belong to BOTH the caller and the given conversation are ever returned,
// newest first.
export async function listPendingWritesForConversation(
	userId: string,
	conversationId: string,
): Promise<PendingWriteRecord[]> {
	const rows = await db
		.select()
		.from(connectionPendingWrites)
		.where(
			and(
				eq(connectionPendingWrites.userId, userId),
				eq(connectionPendingWrites.conversationId, conversationId),
			),
		)
		.orderBy(desc(connectionPendingWrites.createdAt));
	return rows.map(toRecord);
}

// Backfills assistantMessageId onto pending writes created during a turn,
// once the turn's assistant message has been persisted and its id is known.
// Mirrors assignFileProductionJobsToAssistantMessage (file-production/
// job-ledger.ts) exactly: a conditional UPDATE that only touches rows that
// are (a) this user's, (b) in this conversation, (c) one of the ids created
// this turn, and (d) not already stamped — so it can never clobber an
// earlier turn's already-assigned row.
export async function assignPendingWritesToAssistantMessage(
	userId: string,
	conversationId: string,
	assistantMessageId: string,
	pendingWriteIds: string[],
): Promise<void> {
	const uniqueIds = Array.from(
		new Set(pendingWriteIds.filter((id) => id.trim().length > 0)),
	);
	if (uniqueIds.length === 0) {
		return;
	}

	await db
		.update(connectionPendingWrites)
		.set({ assistantMessageId })
		.where(
			and(
				eq(connectionPendingWrites.userId, userId),
				eq(connectionPendingWrites.conversationId, conversationId),
				inArray(connectionPendingWrites.id, uniqueIds),
				isNull(connectionPendingWrites.assistantMessageId),
			),
		);
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

// Fix 1 — atomic "pending" -> "failed" transition for a row whose TTL has
// passed. A single conditional UPDATE (same shape as cancelPendingWrite),
// so a row is only ever expired out of "pending" — never out of
// "executing"/"executed"/"cancelled"/"failed" — and a concurrent confirm
// that already claimed the row (flipped it to "executing") between
// confirmPendingWrite's read and this call simply loses this race (changes
// === 0), exactly like a concurrent claim would. Terminal ("failed"), not
// reopened, so an expired write can never be silently retried.
export async function markPendingWriteExpired(
	userId: string,
	id: string,
): Promise<boolean> {
	const result = await db
		.update(connectionPendingWrites)
		.set({ status: "failed" })
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

	// record.status === "pending" here. Fix 1 — refuse an EXPIRED pending
	// write BEFORE the allowWrites re-check or the claim: a proposal that has
	// sat unconfirmed past its TTL is refused rather than executed against
	// state that may have changed long ago. NULL expiresAt (a row that
	// predates this column) is never expired — see isPendingWriteExpired.
	if (isPendingWriteExpired(record.expiresAt)) {
		const expired = await markPendingWriteExpired(userId, id);
		if (!expired) {
			// Lost a race with a concurrent confirm/cancel that resolved this
			// row between our read and this point — report the authoritative
			// current state rather than blindly claiming "expired", same
			// posture as the claim-loss fallback below.
			const latest = await getPendingWrite(userId, id);
			if (latest?.status === "executed") {
				return { ok: true, alreadyExecuted: true, etag: latest.etag };
			}
			return { ok: false, status: 409, reason: "in_progress" };
		}
		return { ok: false, status: 409, reason: "expired" };
	}

	// Before claiming, re-check the
	// connection's CURRENT allowWrites setting — this is the fix for the
	// second TOCTOU gap (write-safety point 1): a write can be proposed
	// while allowWrites=true, then the user flips writes off in the 7.1
	// panel before confirming. Without this re-check, google/apple/imap/
	// immich's write executors would still execute (only nextcloud's own
	// executor re-checked allowWrites itself, as one-off defense-in-depth).
	// Enforcing it HERE — in the single confirm chokepoint every provider's
	// confirm goes through — makes the guarantee uniform across all
	// providers, present and future, rather than requiring each new
	// executor to remember to re-implement it. Deliberately BEFORE
	// claimPendingWrite so a disabled write is never even flipped to
	// "executing" (claimed-but-never-runs would leave the row stuck).
	const conn = await getConnection(userId, record.connectionId);
	if (conn?.allowWrites !== true) {
		return { ok: false, status: 409, reason: "writes_disabled" };
	}

	// Claim BEFORE doing anything that talks to the provider. This is the
	// fix for the original TOCTOU race: previously this function checked
	// `record.status` (read above) and only updated the row AFTER awaiting
	// the write, so two concurrent confirms could both pass the check and
	// both issue a real write.
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
