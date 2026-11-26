import { z } from "zod";
import { bearerAuthHeader, providerFetch } from "../provider-http";
import type { ConnectionPublic } from "../store";
import type { CalendarEvent } from "./google-calendar";
import { OneDriveError, onedriveGetAccessTokenForRead } from "./onedrive";

type FetchOptions = { fetch?: typeof fetch };
type CalendarWindow = { timeMin: string; timeMax: string; calendarId?: string };
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const OUTLOOK_HOSTS = new Set([
	"outlook.live.com",
	"outlook.office.com",
	"outlook.office365.com",
	"outlook.cloud.microsoft",
]);
const pageSchema = z.object({
	value: z.array(z.unknown()).max(1000),
	"@odata.nextLink": z.string().optional(),
});
const dateTime = z.object({ dateTime: z.string(), timeZone: z.string() });
const occurrence = z.object({
	isCancelled: z.boolean(),
	start: dateTime,
	end: dateTime,
});
const eventDetails = z.object({
	id: z.string().min(1),
	subject: z.string().nullish(),
	location: z.object({ displayName: z.string().nullish() }).nullish(),
	webLink: z.string().nullish(),
});
const scheduleDetails = z.object({
	showAs: z.string(),
	responseStatus: z.object({ response: z.string() }).nullish(),
});
const calendarDetails = z.object({
	id: z.string().min(1),
	name: z.string(),
	isDefaultCalendar: z.boolean(),
});

function invalidResponse() {
	return new OneDriveError(
		"Microsoft returned an incomplete calendar response",
		"request_failed",
	);
}

function instant(value: z.infer<typeof dateTime>): string {
	const absolute = /(?:Z|[+-]\d\d:\d\d)$/i.test(value.dateTime);
	if (!absolute && value.timeZone !== "UTC") throw invalidResponse();
	if (
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)?$/i.test(
			value.dateTime,
		)
	)
		throw invalidResponse();
	const ms = Date.parse(absolute ? value.dateTime : `${value.dateTime}Z`);
	if (!Number.isFinite(ms)) throw invalidResponse();
	return new Date(ms).toISOString();
}

function calendarView(window: CalendarWindow, select: string): URL {
	const { calendarId, timeMin, timeMax } = window;
	if (calendarId === "." || calendarId === "..")
		throw new OneDriveError("Invalid Outlook calendar ID", "invalid_path");
	const calendar =
		calendarId && calendarId !== "primary"
			? `/calendars/${encodeURIComponent(calendarId)}`
			: "";
	const url = new URL(`${GRAPH}${calendar}/calendarView`);
	url.searchParams.set("startDateTime", timeMin);
	url.searchParams.set("endDateTime", timeMax);
	url.searchParams.set("$select", select);
	url.searchParams.set("$orderby", "start/dateTime");
	return url;
}

// Only the continuation query is opaque to us. Keep every request on this
// account and calendar, even when Graph spells /me as /users/{id} in a link.
function continuation(raw: string, initial: URL): URL {
	let link: URL;
	try {
		link = new URL(raw);
	} catch {
		throw invalidResponse();
	}
	const canonicalPath = link.pathname
		.replace(/^\/v1\.0\/(?:me|users\/[^/]+)\//i, "/v1.0/me/")
		.replace(/^\/v1\.0\/me\/calendar\/calendarview$/i, "/v1.0/me/calendarView")
		.replace(/^\/v1\.0\/me\/calendars(?=\/|$)/i, "/v1.0/me/calendars")
		.replace(/\/calendarview$/i, "/calendarView");
	if (
		link.origin !== initial.origin ||
		link.username ||
		link.password ||
		link.hash ||
		canonicalPath !== initial.pathname ||
		!link.search
	)
		throw invalidResponse();
	const result = new URL(initial);
	result.search = link.search;
	return result;
}

async function* graphRows(
	conn: ConnectionPublic,
	url: URL,
	opts?: FetchOptions,
) {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "calendar");
	url.searchParams.set("$top", String(PAGE_SIZE));
	const seen = new Set<string>();
	let next = url;
	for (let index = 0; index < MAX_PAGES; index++) {
		if (seen.has(next.href)) throw invalidResponse();
		seen.add(next.href);
		const response = await providerFetch(next.href, {
			headers: { ...bearerAuthHeader(token), Prefer: 'outlook.timezone="UTC"' },
			fetch: opts?.fetch,
			redirect: "error",
		});
		if (response.status === 401)
			throw new OneDriveError(
				"Microsoft rejected the calendar access token",
				"needs_reauth",
			);
		if (response.status === 404)
			throw new OneDriveError("Outlook calendar was not found", "not_found");
		if (!response.ok)
			throw new OneDriveError(
				"Microsoft calendar request failed",
				"request_failed",
			);
		const page = pageSchema.safeParse(await response.json());
		if (!page.success) throw invalidResponse();
		yield* page.data.value;
		const link = page.data["@odata.nextLink"];
		if (link === undefined) return;
		next = continuation(link, url);
	}
	// Availability must never call the unseen remainder of a busy calendar free.
	throw new OneDriveError(
		"Outlook calendar exceeded the page limit",
		"too_large",
	);
}

function interval(row: unknown) {
	const parsed = occurrence.safeParse(row);
	if (!parsed.success) throw invalidResponse();
	if (parsed.data.isCancelled) return null;
	const start = instant(parsed.data.start);
	const end = instant(parsed.data.end);
	if (end < start) throw invalidResponse();
	return { start, end };
}

function eventUrl(link: string | null | undefined): string {
	if (link && URL.canParse(link)) {
		const url = new URL(link);
		if (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.port &&
			OUTLOOK_HOSTS.has(url.hostname)
		)
			return url.href;
	}
	return "";
}

export async function outlookListEvents(
	conn: ConnectionPublic,
	window: CalendarWindow & { maxResults: number; query?: string },
	opts?: FetchOptions,
): Promise<CalendarEvent[]> {
	const url = calendarView(
		window,
		"id,subject,start,end,isCancelled,location,webLink",
	);
	const events: CalendarEvent[] = [];
	const query = window.query?.trim().toLowerCase();
	for await (const row of graphRows(conn, url, opts)) {
		const times = interval(row);
		if (!times) continue;
		const parsed = eventDetails.safeParse(row);
		if (!parsed.success) throw invalidResponse();
		const { id, subject, location, webLink } = parsed.data;
		const summary = subject ?? "";
		const place = location?.displayName;
		if (
			query &&
			![summary, place ?? ""].some((value) =>
				value.toLowerCase().includes(query),
			)
		)
			continue;
		events.push({
			id,
			summary,
			...times,
			...(place ? { location: place } : {}),
			htmlLink: eventUrl(webLink),
		});
		if (events.length >= window.maxResults) break;
	}
	return events;
}

export async function outlookBusyIntervals(
	conn: ConnectionPublic,
	window: CalendarWindow,
	opts?: FetchOptions,
) {
	const url = calendarView(
		window,
		"start,end,isCancelled,showAs,responseStatus",
	);
	const busy: { start: string; end: string }[] = [];
	for await (const row of graphRows(conn, url, opts)) {
		const times = interval(row);
		if (!times) continue;
		const parsed = scheduleDetails.safeParse(row);
		if (!parsed.success) throw invalidResponse();
		if (
			parsed.data.responseStatus?.response !== "declined" &&
			parsed.data.showAs !== "free" &&
			parsed.data.showAs !== "workingElsewhere"
		)
			busy.push(times);
	}
	return busy;
}

export async function outlookListCalendars(
	conn: ConnectionPublic,
	opts?: FetchOptions,
) {
	const url = new URL(`${GRAPH}/calendars`);
	url.searchParams.set("$select", "id,name,isDefaultCalendar");
	const calendars: { id: string; summary: string; primary?: boolean }[] = [];
	for await (const row of graphRows(conn, url, opts)) {
		const parsed = calendarDetails.safeParse(row);
		if (!parsed.success) throw invalidResponse();
		const { id, name, isDefaultCalendar } = parsed.data;
		calendars.push({
			id,
			summary: name,
			...(isDefaultCalendar ? { primary: true } : {}),
		});
	}
	return calendars;
}
