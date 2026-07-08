// Google Calendar v3 READ methods (5.2): list calendars, list events over a
// range, and free/busy — built on top of the OAuth connect/refresh lifecycle
// in ./google (5.1). Read-only (write scopes/methods land in Phase 6). Every
// call obtains a fresh access token via googleRefreshAccessToken (which
// itself decrypts the stored refresh token and hits Google's token
// endpoint) and every network call accepts an injectable `fetch` so this
// module is fully testable against mocked Google endpoints.
import { updateConnection } from "../store";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";

type FetchOpt = { fetch?: typeof fetch };

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_EVENTS = 25;

export type GoogleCalendarErrorCode =
	| "needs_reauth"
	| "request_failed"
	| "connection_not_found";

export class GoogleCalendarError extends Error {
	constructor(
		message: string,
		public readonly code: GoogleCalendarErrorCode,
	) {
		super(message);
		this.name = "GoogleCalendarError";
	}
}

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

// Bounds every Calendar API call to ~15s via AbortController so a
// slow/unreachable Google endpoint can't hang a chat turn indefinitely —
// mirrors the same pattern in providers/nextcloud-files.ts.
async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new GoogleCalendarError(
				`Google Calendar request timed out after ${timeoutMs}ms`,
				"request_failed",
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
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

	const response = await fetchWithTimeout(fetchImpl, url.toString(), {
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
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
	return {
		id,
		summary,
		start,
		end,
		...(location ? { location } : {}),
		htmlLink,
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

	const response = await fetchWithTimeout(
		fetchImpl,
		`${CALENDAR_API_BASE}/freeBusy`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				timeMin: params.timeMin,
				timeMax: params.timeMax,
				items: calendarIds.map((id) => ({ id })),
			}),
		},
	);

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
