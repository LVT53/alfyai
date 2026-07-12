// Google Calendar v3 (5.2 read + 6.1 write) — READ methods (list calendars,
// list events over a range, free/busy, and a single-event lookup used to build
// write previews) AND the WRITE executor (insert/patch/delete) co-located in
// one module (C2) so the shared base URL, auth, and event-time knowledge is
// derived once rather than across a read/write file split. Built on top of the
// OAuth connect/refresh lifecycle in ./google (5.1). Every call obtains a fresh
// access token via googleRefreshAccessToken (which itself decrypts the stored
// refresh token and hits Google's token endpoint) and every network call
// accepts an injectable `fetch` so this module is fully testable against mocked
// Google endpoints. The write executor is registered via registerWriteExecutor
// (Issue 6.0) so confirmPendingWrite (pending-writes.ts) dispatches "google"
// pending writes here, and only after the user has explicitly confirmed — the
// calendar chat tool (normal-chat-tools/calendar.ts) never imports this
// module's write path; it only ever proposes a PENDING write via
// createPendingWrite.
import { createHash } from "node:crypto";
import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
import { updateConnection } from "../store";
import {
	registerWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";

type FetchOpt = { fetch?: typeof fetch };

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_MAX_EVENTS = 25;

export type GoogleCalendarErrorCode =
	| "needs_reauth"
	| "request_failed"
	| "connection_not_found";

// Not thrown as an error today — googleGetEvent (6.1) returns `null` for a
// missing event rather than throwing, mirroring how a missing pending write
// resolves to `null` in pending-writes.ts, so a "not found" here is one more
// ordinary outcome for a write-action caller to branch on rather than a typed
// exception every caller must catch.

export class GoogleCalendarError extends ConnectionHttpError<GoogleCalendarErrorCode> {
	constructor(message: string, code: GoogleCalendarErrorCode) {
		super(message, code);
		this.name = "GoogleCalendarError";
	}
}

// Timeout error for every Google Calendar call routed through providerFetch —
// matches the wording the private fetchWithTimeout produced.
const googleCalendarTimeout = (ms: number) =>
	new GoogleCalendarError(
		`Google Calendar request timed out after ${ms}ms`,
		"request_failed",
	);

export type GoogleCalendarListEntry = {
	id: string;
	summary: string;
	primary?: boolean;
};

export type CalendarEvent = {
	id: string;
	summary: string;
	start: string;
	end: string;
	location?: string;
	htmlLink: string;
	// Only ever populated by the Apple CalDAV adapter (providers/apple-caldav
	// .ts) — a CalDAV resource's ETag, kept for Phase 6.2 writes (conditional
	// updates need it). Google events never set this; it is NOT surfaced to
	// the calendar chat tool's model-facing payload (see
	// normal-chat-tools/calendar.ts's toToolEventItem), only used internally.
	etag?: string;
	// Google-only (6.1 write guardrail): present on an expanded recurring
	// instance, pointing at its recurring master event's id. Used by the
	// calendar write tool to detect "this is part of a recurring series"
	// before proposing an update/delete, and by the write executor to resolve
	// which id to actually PATCH/DELETE for a "series"-scoped write. Never
	// surfaced to the model-facing tool payload.
	recurringEventId?: string;
	// Google-only: present (non-empty) on a recurring MASTER event itself
	// (RRULE/EXDATE/etc. strings). Combined with `recurringEventId` above,
	// `isRecurring` (normal-chat-tools/calendar.ts) treats either signal as
	// "this event is part of a series". Apple CalDAV (6.2) also populates this
	// — with a single-element array holding the raw RRULE value — since a
	// CalDAV calendar-query never expands a recurring series into per-instance
	// results the way Google's `singleEvents=true` does; every match for a
	// recurring series comes back as the same master VEVENT, so Apple has no
	// master/instance distinction to make (see isRecurring's use in the
	// calendar tool's Apple update/delete guardrail).
	recurrence?: string[];
	// Apple CalDAV only (6.2) — the VEVENT's DESCRIPTION, captured so an
	// update can regenerate the full VEVENT resource (a CalDAV PUT REPLACES
	// the whole resource; unlike Google's PATCH, an omitted field here would
	// be silently deleted) without losing an existing description the update
	// didn't intend to touch. Google's own mapping never sets this because
	// its PATCH endpoint doesn't require resending unchanged fields.
	description?: string;
	// Apple CalDAV only (6.2, corruption-safety fix) — the RAW `calendar-data`
	// text (the whole VCALENDAR document, exactly as iCloud returned it) this
	// event was parsed out of. A CalDAV PUT replaces the whole resource, and
	// this tool only ever models a handful of VEVENT properties
	// (SUMMARY/DTSTART/DTEND/LOCATION/DESCRIPTION) — regenerating a brand-new
	// VEVENT from just those fields would silently drop everything else a
	// pre-existing event carries (ATTENDEE/ORGANIZER/VALARM/RRULE/CATEGORIES/
	// X-*/...). The write executor instead PATCHES this original text in
	// place (see apple-caldav.ts's patchVevent), touching only the
	// specific properties the caller actually supplied. Never surfaced to the
	// calendar chat tool's model-facing payload (see toToolEventItem)  —
	// internal to the write path only, same posture as `etag`.
	rawIcs?: string;
};

export type CalendarFreeBusy = {
	calendarId: string;
	busy: { start: string; end: string }[];
};

// Obtains a fresh access token for `connectionId`, remapping the refresh
// step's own typed errors onto this module's error type so callers only
// ever need to handle GoogleCalendarError. A refresh failure due to a
// rejected/missing refresh token is always surfaced as `needs_reauth` here —
// googleRefreshAccessToken has already flagged the connection row itself in
// that case, this just gives the caller (the calendar chat tool) a typed
// error to react to without inspecting GoogleOAuthError directly.
async function getAccessToken(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<string> {
	try {
		return await googleRefreshAccessToken(userId, connectionId, {
			fetch: opts?.fetch,
		});
	} catch (err) {
		if (err instanceof GoogleOAuthError) {
			if (err.code === "connection_not_found") {
				throw new GoogleCalendarError(err.message, "connection_not_found");
			}
			if (err.code === "needs_reauth" || err.code === "invalid_grant") {
				throw new GoogleCalendarError(err.message, "needs_reauth");
			}
			throw new GoogleCalendarError(err.message, "request_failed");
		}
		throw new GoogleCalendarError(
			err instanceof Error
				? err.message
				: "Failed to obtain a Google access token",
			"request_failed",
		);
	}
}

// A 401 here means Google is rejecting the access token even right after a
// successful refresh (e.g. the grant was revoked server-side mid-flight) —
// distinct from the refresh step itself failing, but treated identically:
// typed needs_reauth, and the connection row is flagged so health checks /
// the UI reflect it without waiting for the next scheduled health check.
async function assertNotAuthFailure(
	response: Response,
	userId: string,
	connectionId: string,
): Promise<void> {
	if (response.status !== 401) return;
	const detail = "Google rejected the access token for this Calendar request";
	await updateConnection(userId, connectionId, {
		status: "needs_reauth",
		statusDetail: detail,
	});
	throw new GoogleCalendarError(detail, "needs_reauth");
}

async function calendarGet(
	userId: string,
	connectionId: string,
	path: string,
	searchParams: Record<string, string | number | undefined>,
	opts?: FetchOpt,
): Promise<unknown> {
	const fetchImpl = opts?.fetch ?? fetch;
	const accessToken = await getAccessToken(userId, connectionId, opts);

	const url = new URL(`${CALENDAR_API_BASE}${path}`);
	for (const [key, value] of Object.entries(searchParams)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}

	const response = await providerFetch(url.toString(), {
		method: "GET",
		headers: { ...bearerAuthHeader(accessToken) },
		fetch: fetchImpl,
		timeoutError: googleCalendarTimeout,
	});

	await assertNotAuthFailure(response, userId, connectionId);
	if (!response.ok) {
		throw new GoogleCalendarError(
			`Google Calendar request failed with status ${response.status}`,
			"request_failed",
		);
	}
	return response.json().catch(() => null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// googleListCalendars
// ---------------------------------------------------------------------------

export async function googleListCalendars(
	userId: string,
	connectionId: string,
	opts?: FetchOpt,
): Promise<GoogleCalendarListEntry[]> {
	const body = await calendarGet(
		userId,
		connectionId,
		"/users/me/calendarList",
		{},
		opts,
	);
	if (!isRecord(body) || !Array.isArray(body.items)) return [];

	const entries: GoogleCalendarListEntry[] = [];
	for (const item of body.items) {
		if (!isRecord(item)) continue;
		const id = item.id;
		const summary = item.summary;
		if (typeof id !== "string" || typeof summary !== "string") continue;
		entries.push({
			id,
			summary,
			...(item.primary === true ? { primary: true } : {}),
		});
	}
	return entries;
}

// ---------------------------------------------------------------------------
// googleListEvents
// ---------------------------------------------------------------------------

// Google represents an all-day event as `{ date: "YYYY-MM-DD" }` and a timed
// event as `{ dateTime: "...", timeZone: "..." }` — never both. This picks
// whichever is present so callers get a single ISO-ish string regardless of
// event kind.
function eventTimestamp(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (typeof value.dateTime === "string") return value.dateTime;
	if (typeof value.date === "string") return value.date;
	return null;
}

function parseCalendarEvent(item: unknown): CalendarEvent | null {
	if (!isRecord(item)) return null;
	const id = item.id;
	const htmlLink = item.htmlLink;
	const start = eventTimestamp(item.start);
	const end = eventTimestamp(item.end);
	if (
		typeof id !== "string" ||
		typeof htmlLink !== "string" ||
		start === null ||
		end === null
	) {
		return null;
	}
	const summary = typeof item.summary === "string" ? item.summary : "";
	const location =
		typeof item.location === "string" ? item.location : undefined;
	const recurringEventId =
		typeof item.recurringEventId === "string"
			? item.recurringEventId
			: undefined;
	const recurrence = Array.isArray(item.recurrence)
		? item.recurrence.filter(
				(entry): entry is string => typeof entry === "string",
			)
		: undefined;
	return {
		id,
		summary,
		start,
		end,
		...(location ? { location } : {}),
		htmlLink,
		...(recurringEventId ? { recurringEventId } : {}),
		...(recurrence && recurrence.length > 0 ? { recurrence } : {}),
	};
}

export async function googleListEvents(
	userId: string,
	connectionId: string,
	params: {
		calendarId?: string;
		timeMin: string;
		timeMax: string;
		q?: string;
		maxResults?: number;
	},
	opts?: FetchOpt,
): Promise<CalendarEvent[]> {
	const calendarId = encodeURIComponent(params.calendarId ?? "primary");
	const body = await calendarGet(
		userId,
		connectionId,
		`/calendars/${calendarId}/events`,
		{
			singleEvents: "true",
			orderBy: "startTime",
			timeMin: params.timeMin,
			timeMax: params.timeMax,
			q: params.q,
			maxResults: params.maxResults ?? DEFAULT_MAX_EVENTS,
		},
		opts,
	);
	if (!isRecord(body) || !Array.isArray(body.items)) return [];

	const events: CalendarEvent[] = [];
	for (const item of body.items) {
		const parsed = parseCalendarEvent(item);
		if (parsed) events.push(parsed);
	}
	return events;
}

// ---------------------------------------------------------------------------
// googleGetEvent (6.1) — fetches a single event by id, used by the calendar
// write tool to build an update/delete preview and to detect whether the
// target event is part of a recurring series (recurringEventId/recurrence)
// before proposing a pending write. Deliberately NOT built on top of
// `calendarGet` (which throws on any non-2xx): a 404/410 here is an ordinary,
// expected outcome for a stale eventId, not a transport failure — so this
// resolves to `null` instead of throwing, exactly like getPendingWrite
// resolves to `null` for an unknown id rather than raising.
// ---------------------------------------------------------------------------

export async function googleGetEvent(
	userId: string,
	connectionId: string,
	params: { calendarId?: string; eventId: string },
	opts?: FetchOpt,
): Promise<CalendarEvent | null> {
	const fetchImpl = opts?.fetch ?? fetch;
	const accessToken = await getAccessToken(userId, connectionId, opts);
	const calendarId = encodeURIComponent(params.calendarId ?? "primary");
	const eventId = encodeURIComponent(params.eventId);

	const response = await providerFetch(
		`${CALENDAR_API_BASE}/calendars/${calendarId}/events/${eventId}`,
		{
			method: "GET",
			headers: { ...bearerAuthHeader(accessToken) },
			fetch: fetchImpl,
			timeoutError: googleCalendarTimeout,
		},
	);

	await assertNotAuthFailure(response, userId, connectionId);
	if (response.status === 404 || response.status === 410) return null;
	if (!response.ok) {
		throw new GoogleCalendarError(
			`Google Calendar request failed with status ${response.status}`,
			"request_failed",
		);
	}

	const body: unknown = await response.json().catch(() => null);
	return parseCalendarEvent(body);
}

// ---------------------------------------------------------------------------
// googleFreeBusy
// ---------------------------------------------------------------------------

function parseBusyIntervals(value: unknown): { start: string; end: string }[] {
	if (!Array.isArray(value)) return [];
	const intervals: { start: string; end: string }[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const { start, end } = entry;
		if (typeof start === "string" && typeof end === "string") {
			intervals.push({ start, end });
		}
	}
	return intervals;
}

export async function googleFreeBusy(
	userId: string,
	connectionId: string,
	params: { timeMin: string; timeMax: string; calendarIds?: string[] },
	opts?: FetchOpt,
): Promise<CalendarFreeBusy[]> {
	const fetchImpl = opts?.fetch ?? fetch;
	const accessToken = await getAccessToken(userId, connectionId, opts);
	const calendarIds =
		params.calendarIds && params.calendarIds.length > 0
			? params.calendarIds
			: ["primary"];

	const response = await providerFetch(`${CALENDAR_API_BASE}/freeBusy`, {
		method: "POST",
		headers: {
			...bearerAuthHeader(accessToken),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			timeMin: params.timeMin,
			timeMax: params.timeMax,
			items: calendarIds.map((id) => ({ id })),
		}),
		fetch: fetchImpl,
		timeoutError: googleCalendarTimeout,
	});

	await assertNotAuthFailure(response, userId, connectionId);
	if (!response.ok) {
		throw new GoogleCalendarError(
			`Google Calendar freeBusy request failed with status ${response.status}`,
			"request_failed",
		);
	}

	const body: unknown = await response.json().catch(() => null);
	if (!isRecord(body) || !isRecord(body.calendars)) return [];

	const results: CalendarFreeBusy[] = [];
	for (const [calendarId, entry] of Object.entries(body.calendars)) {
		if (!isRecord(entry)) continue;
		results.push({ calendarId, busy: parseBusyIntervals(entry.busy) });
	}
	return results;
}

// ===========================================================================
// WRITE executor (Issue 6.1) — the ONLY code path that ever issues a mutating
// (POST/PATCH/DELETE) request against a user's Google Calendar. Co-located
// with the read methods above (C2) so CALENDAR_API_BASE, the OAuth token
// lifecycle, and the event-time mapping are shared, not re-derived. Nothing
// here ever runs at propose time — only via confirmPendingWrite's dispatch.
// ===========================================================================

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
// event as `{ dateTime: "..." }` — the inverse of eventTimestamp above (which
// reads whichever is present back OUT of a Google event). A bare `YYYY-MM-DD`
// string is treated as an all-day event; anything else (assumed to already be
// a valid ISO 8601 datetime) is passed through as a dateTime.
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
// assertNotAuthFailure flags a read-side 401, so health checks / the UI
// reflect it without waiting for the next scheduled check.
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
