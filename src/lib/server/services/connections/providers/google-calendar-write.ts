// Google Calendar WRITE executor (Issue 6.1) — the ONLY code path that ever
// issues a mutating (POST/PATCH/DELETE) request against a user's Google
// Calendar. Registered via registerWriteExecutor (Issue 6.0) so
// confirmPendingWrite (pending-writes.ts) dispatches "google" pending writes
// here, and only after the user has explicitly confirmed — the calendar chat
// tool (normal-chat-tools/calendar.ts) never imports this module; it only
// ever proposes a PENDING write via createPendingWrite. Every network call
// accepts an injectable `fetch` so this module is fully testable against
// mocked Google endpoints — nothing here ever talks to live Google in tests.
import { createHash } from "node:crypto";
import { bearerAuthHeader, providerFetch } from "../provider-http";
import { updateConnection } from "../store";
import {
	registerWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";

type FetchOpt = { fetch?: typeof fetch };

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

// Timeout error for every write-path Calendar call routed through
// providerFetch. Throws a plain Error (not GoogleCalendarError) on abort —
// matching the previous private fetchWithTimeout — because every call site
// already maps any thrown error to a request_failed write result.
const googleCalendarWriteTimeout = (ms: number) =>
	new Error(`Google Calendar write request timed out after ${ms}ms`);

// ---------------------------------------------------------------------------
// content parsing — the calendar tool (normal-chat-tools/calendar.ts) is the
// only producer of this shape; this module is the only consumer.
// ---------------------------------------------------------------------------

type CalendarWriteEventFields = {
	summary?: string;
	start?: string;
	end?: string;
	location?: string;
	description?: string;
};

export type CalendarWriteContent = {
	calendarId: string;
	eventId?: string;
	event?: CalendarWriteEventFields;
	recurringScope?: "this_event" | "series";
};

function parseContent(content: string): CalendarWriteContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<CalendarWriteContent>;
		if (
			typeof parsed.calendarId !== "string" ||
			parsed.calendarId.length === 0
		) {
			return null;
		}
		return {
			calendarId: parsed.calendarId,
			...(typeof parsed.eventId === "string"
				? { eventId: parsed.eventId }
				: {}),
			...(parsed.event && typeof parsed.event === "object"
				? { event: parsed.event }
				: {}),
			...(parsed.recurringScope === "this_event" ||
			parsed.recurringScope === "series"
				? { recurringScope: parsed.recurringScope }
				: {}),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Deterministic client-supplied event id (create idempotency)
// ---------------------------------------------------------------------------

// Google event ids may only use lowercase base32hex characters (a-v, 0-9) and
// must be 5-1024 chars long. Deriving one from the pending write's
// idempotencyKey — a pure function of the WriteOperation (provider/
// connectionId/action/target/payloadFingerprint, see write-guard.ts) — means
// re-attempting the SAME create (a retried confirm after a crash between
// Google accepting the insert and this row being marked "executed", or a
// second pending write proposed from byte-identical tool input) always maps
// onto the same Google event id. Re-inserting that id a second time gets
// Google's own 409 "already exists" instead of silently creating a duplicate
// event — this needs no persisted state of its own, the determinism is the
// whole mechanism.
const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

function toBase32Hex(buffer: Buffer): string {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 0x1f];
			bits -= 5;
		}
	}
	if (bits > 0) {
		output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 0x1f];
	}
	return output;
}

// Exported for tests only — production callers never need to compute this
// independently, `execute` (below) derives it internally for create_event.
export function googleEventIdForOp(op: WriteOperation): string {
	const hash = createHash("sha256").update(idempotencyKey(op)).digest();
	return toBase32Hex(hash);
}

// Google represents an all-day event as `{ date: "YYYY-MM-DD" }` and a timed
// event as `{ dateTime: "..." }` — the inverse of google-calendar.ts's
// eventTimestamp (which reads whichever is present back OUT of a Google
// event). A bare `YYYY-MM-DD` string is treated as an all-day event; anything
// else (assumed to already be a valid ISO 8601 datetime) is passed through as
// a dateTime.
const ALL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toGoogleEventTime(
	value: string,
): { date: string } | { dateTime: string } {
	return ALL_DAY_PATTERN.test(value) ? { date: value } : { dateTime: value };
}

async function calendarWriteRequest(
	fetchImpl: typeof fetch,
	token: string,
	method: string,
	url: string,
	body?: unknown,
): Promise<Response> {
	return providerFetch(url, {
		method,
		headers: {
			...bearerAuthHeader(token),
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		fetch: fetchImpl,
		timeoutError: googleCalendarWriteTimeout,
	});
}

function extractEtag(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const etag = (body as Record<string, unknown>).etag;
	return typeof etag === "string" ? etag : null;
}

// A 401/403 here means Google rejected the (just-refreshed) access token for
// this specific request — e.g. the connection's stored scope no longer
// includes calendar.events, or the grant was revoked mid-flight — not a bare
// retryable failure. The connection is flagged the same way
// google-calendar.ts's assertNotAuthFailure flags a read-side 401, so health
// checks / the UI reflect it without waiting for the next scheduled check.
async function flagNeedsReauth(
	userId: string,
	connectionId: string,
): Promise<void> {
	await updateConnection(userId, connectionId, {
		status: "needs_reauth",
		statusDetail:
			"Google rejected the write request for this Calendar connection",
	});
}

async function getAccessTokenOrReauth(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<
	{ ok: true; token: string } | { ok: false; result: WriteExecutionResult }
> {
	try {
		const token = await googleRefreshAccessToken(userId, connectionId, {
			fetch: opts?.fetch,
		});
		return { ok: true, token };
	} catch (err) {
		if (err instanceof GoogleOAuthError) {
			if (err.code === "needs_reauth" || err.code === "invalid_grant") {
				// googleRefreshAccessToken has already flagged the connection row
				// itself in this case (see google.ts) — no need to flag again.
				return { ok: false, result: { ok: false, reason: "needs_reauth" } };
			}
			if (err.code === "connection_not_found") {
				return {
					ok: false,
					result: { ok: false, reason: "connection_not_found" },
				};
			}
		}
		return { ok: false, result: { ok: false, reason: "request_failed" } };
	}
}

// Resolves which event id an update/delete must actually act on, and — for
// "this_event" — refuses to act at all when the given id would clobber a
// whole series. Google's recurring-instance ids (as returned by list/get with
// singleEvents=true) are distinct from their series MASTER id (the event that
// carries the `recurrence` array); PATCHing/DELETEing the master is what
// changes the WHOLE series. `eventId` is caller-supplied and not guaranteed
// to have come from this tool's own reads (pasted id, stale context, a
// pending write confirmed long after propose time, model error), so this is
// looked up fresh at execute time rather than trusted from propose time —
// same posture as the "series" resolution below, which predates this check.
//
//   - "this_event": fetch the target. If it turns out to BE the master
//     (has a non-empty `recurrence` array) → fail closed with
//     "recurring_instance_ambiguous" and never issue the PATCH/DELETE — a
//     "this event only" request must never fall through to mutating the
//     series definition. A genuine instance (has `recurringEventId`, no
//     `recurrence`) is patched/deleted using the id AS GIVEN, not the master.
//   - "series": resolve to the master id — either the fetched event already
//     IS the master, or its `recurringEventId` points at the real one.
//   - no scope at all: non-recurring targets never reach this module with a
//     scope set (calendar.ts's recurring guardrail requires one whenever the
//     target is recurring) — use the id as-is, no fetch needed.
async function resolveTargetEventId(
	fetchImpl: typeof fetch,
	userId: string,
	connectionId: string,
	token: string,
	calendarId: string,
	eventId: string,
	recurringScope: "this_event" | "series" | undefined,
): Promise<
	{ ok: true; id: string } | { ok: false; result: WriteExecutionResult }
> {
	if (recurringScope === undefined) return { ok: true, id: eventId };

	const response = await providerFetch(
		`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
		{
			method: "GET",
			headers: { ...bearerAuthHeader(token) },
			fetch: fetchImpl,
			timeoutError: googleCalendarWriteTimeout,
		},
	);
	if (response.status === 401 || response.status === 403) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, result: { ok: false, reason: "needs_reauth" } };
	}
	if (response.status === 404 || response.status === 410) {
		return { ok: false, result: { ok: false, reason: "not_found" } };
	}
	if (!response.ok) {
		return { ok: false, result: { ok: false, reason: "request_failed" } };
	}
	const body: unknown = await response.json().catch(() => null);
	const record =
		body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const isMaster =
		Array.isArray(record.recurrence) && record.recurrence.length > 0;
	const recurringEventId =
		typeof record.recurringEventId === "string"
			? record.recurringEventId
			: undefined;

	if (recurringScope === "this_event") {
		if (isMaster) {
			// The id given for a "this_event" scope IS the series' own
			// definition, not a single occurrence — patching or deleting it here
			// would silently apply to the whole series. Fail closed instead of
			// guessing which occurrence was meant.
			return {
				ok: false,
				result: { ok: false, reason: "recurring_instance_ambiguous" },
			};
		}
		return { ok: true, id: eventId };
	}

	// recurringScope === "series"
	return { ok: true, id: recurringEventId ?? eventId };
}

// ---------------------------------------------------------------------------
// create / update / delete
// ---------------------------------------------------------------------------

async function executeCreate(
	userId: string,
	connectionId: string,
	token: string,
	op: WriteOperation,
	content: CalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	const calendarId = encodeURIComponent(content.calendarId);
	const clientEventId = googleEventIdForOp(op);
	const event = content.event ?? {};
	const body: Record<string, unknown> = { id: clientEventId };
	if (event.summary !== undefined) body.summary = event.summary;
	if (event.location !== undefined) body.location = event.location;
	if (event.description !== undefined) body.description = event.description;
	if (event.start !== undefined) body.start = toGoogleEventTime(event.start);
	if (event.end !== undefined) body.end = toGoogleEventTime(event.end);

	const response = await calendarWriteRequest(
		fetchImpl,
		token,
		"POST",
		`${CALENDAR_API_BASE}/calendars/${calendarId}/events`,
		body,
	);

	if (response.status === 409) {
		// Re-inserting the same client-supplied id — idempotent success, NOT a
		// double-create. Google returns 409 with an "identifier already exists"
		// (or "duplicate") error body for this case; the exact wording isn't
		// load-bearing here, only the status code is.
		return { ok: true, detail: "already created" };
	}
	if (response.status === 401 || response.status === 403) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	const responseBody: unknown = await response.json().catch(() => null);
	return { ok: true, etag: extractEtag(responseBody), detail: "created" };
}

async function executeUpdate(
	userId: string,
	connectionId: string,
	token: string,
	content: CalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.eventId) return { ok: false, reason: "missing_event_id" };

	const resolved = await resolveTargetEventId(
		fetchImpl,
		userId,
		connectionId,
		token,
		content.calendarId,
		content.eventId,
		content.recurringScope,
	);
	if (!resolved.ok) return resolved.result;

	const event = content.event ?? {};
	const body: Record<string, unknown> = {};
	if (event.summary !== undefined) body.summary = event.summary;
	if (event.location !== undefined) body.location = event.location;
	if (event.description !== undefined) body.description = event.description;
	if (event.start !== undefined) body.start = toGoogleEventTime(event.start);
	if (event.end !== undefined) body.end = toGoogleEventTime(event.end);

	const response = await calendarWriteRequest(
		fetchImpl,
		token,
		"PATCH",
		`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(content.calendarId)}/events/${encodeURIComponent(resolved.id)}`,
		body,
	);

	if (response.status === 401 || response.status === 403) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	const responseBody: unknown = await response.json().catch(() => null);
	return {
		ok: true,
		etag: extractEtag(responseBody),
		detail:
			content.recurringScope === "series" ? "series updated" : "event updated",
	};
}

async function executeDelete(
	userId: string,
	connectionId: string,
	token: string,
	content: CalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.eventId) return { ok: false, reason: "missing_event_id" };

	const resolved = await resolveTargetEventId(
		fetchImpl,
		userId,
		connectionId,
		token,
		content.calendarId,
		content.eventId,
		content.recurringScope,
	);
	if (!resolved.ok) return resolved.result;

	const response = await calendarWriteRequest(
		fetchImpl,
		token,
		"DELETE",
		`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(content.calendarId)}/events/${encodeURIComponent(resolved.id)}`,
	);

	if (response.status === 401 || response.status === 403) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	// 410 (Gone) means the event was already deleted — idempotent success, not
	// a failure to surface to the user a second time.
	if (response.status === 410 || response.ok) {
		return {
			ok: true,
			detail: response.status === 410 ? "already deleted" : "deleted",
		};
	}
	return { ok: false, reason: "request_failed" };
}

// ---------------------------------------------------------------------------
// registration (Issue 6.0) — imported for its side effect by pending-writes
// .ts, the same way providers/nextcloud-files.ts is (see the comment above
// that import for why this needs to happen on that exact import path).
// ---------------------------------------------------------------------------

registerWriteExecutor({
	provider: "google",
	async execute(userId, connectionId, op, content, opts) {
		const parsed = parseContent(content);
		if (!parsed) return { ok: false, reason: "unsupported_operation" };

		const tokenResult = await getAccessTokenOrReauth(
			userId,
			connectionId,
			opts,
		);
		if (!tokenResult.ok) return tokenResult.result;

		switch (op.action) {
			case "calendar.create_event":
				return executeCreate(
					userId,
					connectionId,
					tokenResult.token,
					op,
					parsed,
					opts,
				);
			case "calendar.update_event":
				return executeUpdate(
					userId,
					connectionId,
					tokenResult.token,
					parsed,
					opts,
				);
			case "calendar.delete_event":
				return executeDelete(
					userId,
					connectionId,
					tokenResult.token,
					parsed,
					opts,
				);
			default:
				return { ok: false, reason: "unsupported_operation" };
		}
	},
});
