// Google Calendar v3 READ methods (5.2): list calendars, list events over a
// range, free/busy, and (6.1) a single-event lookup used to build write
// previews — built on top of the OAuth connect/refresh lifecycle in ./google
// (5.1). The actual mutating calls (insert/patch/delete) live in
// providers/google-calendar-write.ts (6.1), not here — this module stays
// read-only. Every call obtains a fresh access token via
// googleRefreshAccessToken (which itself decrypts the stored refresh token
// and hits Google's token endpoint) and every network call accepts an
// injectable `fetch` so this module is fully testable against mocked Google
// endpoints.
import {
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
import { updateConnection } from "../store";
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
	// place (see apple-caldav-write.ts's patchVevent), touching only the
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
