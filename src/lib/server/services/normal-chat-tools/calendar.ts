import { z } from "zod";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	AppleCalDavError,
	appleGetEventByUid,
	appleListEvents,
} from "$lib/server/services/connections/providers/apple-caldav";
import {
	type CalendarEvent,
	GoogleCalendarError,
	googleFreeBusy,
	googleGetEvent,
	googleListCalendars,
	googleListEvents,
} from "$lib/server/services/connections/providers/google-calendar";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import {
	buildWritePreview,
	idempotencyKey,
	type WriteOperation,
	type WritePreview,
} from "$lib/server/services/connections/write-guard";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

export const calendarToolInputSchema = z.object({
	action: z.enum([
		"list_events",
		"list_calendars",
		"check_availability",
		"create_event",
		"update_event",
		"delete_event",
	]),
	start: z.string().optional(),
	end: z.string().optional(),
	query: z.string().optional(),
	// Write-action fields (6.1). `title`/`start`/`end`/`location`/
	// `description` double as the new event's fields for create_event and as
	// the (only the ones actually provided) changed fields for update_event;
	// `start`/`end` are reused from the read-side range fields above rather
	// than duplicated. `eventId` identifies the target for update/delete.
	// `recurringScope` is required by the tool (never inferred) whenever the
	// target turns out to be part of a recurring series — see
	// runCalendarTool's recurring guardrail below.
	title: z.string().optional(),
	location: z.string().optional(),
	description: z.string().optional(),
	eventId: z.string().optional(),
	calendarId: z.string().optional(),
	recurringScope: z.enum(["this_event", "series"]).optional(),
});

export type CalendarToolInput = z.infer<typeof calendarToolInputSchema>;

export function sanitizeCalendarToolInput(
	input: CalendarToolInput,
): CalendarToolInput {
	return {
		action: input.action,
		...(input.start ? { start: input.start.trim() } : {}),
		...(input.end ? { end: input.end.trim() } : {}),
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.title ? { title: input.title.trim() } : {}),
		...(input.location ? { location: input.location.trim() } : {}),
		...(input.description ? { description: input.description.trim() } : {}),
		...(input.eventId ? { eventId: input.eventId.trim() } : {}),
		...(input.calendarId ? { calendarId: input.calendarId.trim() } : {}),
		...(input.recurringScope ? { recurringScope: input.recurringScope } : {}),
	};
}

export type CalendarCitation = { label: string; url: string };

// One event as surfaced to the model. `summary`/`location` are the "raw
// event details" the locality Option-A distill gate (below) strips when
// active — everything else (id/start/end/htmlLink) is structural metadata,
// same posture as the files tool keeping name/path/size while stripping
// `content`.
export type CalendarToolEventItem = {
	id: string;
	summary?: string;
	start: string;
	end: string;
	location?: string;
	htmlLink: string;
};

export type CalendarToolBusyItem = {
	calendarId: string;
	busy: { start: string; end: string }[];
};

// One calendar as surfaced to the model by the `list_calendars` action (Gap
// A5). `id` is the value the model then passes back as `calendarId` to scope a
// subsequent read/write; `summary` is its human-readable name; `primary` marks
// the account's default calendar. These are structural identifiers (like a
// file's name/path in the files tool), NOT the raw event body Option A
// protects — so, deliberately, the distill gate does not apply to them: the
// model needs the id verbatim to be able to scope anything at all.
export type CalendarToolCalendarItem = {
	id: string;
	summary: string;
	primary?: boolean;
};

export type CalendarToolModelPayload = {
	success: boolean;
	name: "calendar";
	sourceType: "tool";
	action: CalendarToolInput["action"];
	message: string;
	events: CalendarToolEventItem[];
	busy: CalendarToolBusyItem[];
	calendars: CalendarToolCalendarItem[];
	citations: CalendarCitation[];
	// Only set for a successful create_event/update_event/delete_event action
	// (6.1) — the write has NOT executed, this is the id the user's
	// confirm/cancel decision applies to (mirrors files.ts's "save").
	pendingWriteId?: string;
	preview?: WritePreview;
};

export type CalendarToolOutcome = {
	modelPayload: CalendarToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

// This tool's own cap, always passed explicitly to googleListEvents — it
// takes precedence over (and makes dead, for this call site) the adapter's
// own `DEFAULT_MAX_EVENTS` (25 — see google-calendar.ts), since a caller-
// supplied `maxResults` always wins there. Intentional: 20 is this tool's
// deliberate limit, not an oversight.
const MAX_EVENTS = 20;
const DEFAULT_RANGE_DAYS = 7;

function defaultRange(): { timeMin: string; timeMax: string } {
	const now = new Date();
	const later = new Date(
		now.getTime() + DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000,
	);
	return { timeMin: now.toISOString(), timeMax: later.toISOString() };
}

// Google Calendar's events.list (and Apple CalDAV's time-range filter)
// require a full date-TIME, not a bare "YYYY-MM-DD": Google returns HTTP 400
// for a date-only bound, which surfaced in live use as a hard "I couldn't
// reach your calendar" error. Models routinely emit date-only bounds for
// ranges like "next two weeks", so normalize whatever the model supplies into
// an RFC3339 UTC timestamp before it reaches a provider. A date-only value is
// anchored to the start of its UTC day for `timeMin` and the end of its UTC
// day for `timeMax`, so a date-only end bound still includes events on that
// final day. An unparseable value returns null so the caller falls back to
// the default range endpoint rather than forwarding garbage that would 400.
function toRfc3339(value: string, bound: "start" | "end"): string | null {
	const trimmed = value.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return bound === "end"
			? `${trimmed}T23:59:59.999Z`
			: `${trimmed}T00:00:00.000Z`;
	}
	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

function resolveRange(input: CalendarToolInput): {
	timeMin: string;
	timeMax: string;
} {
	const fallback = defaultRange();
	return {
		timeMin:
			(input.start && toRfc3339(input.start, "start")) || fallback.timeMin,
		timeMax: (input.end && toRfc3339(input.end, "end")) || fallback.timeMax,
	};
}

function toCandidate(citation: CalendarCitation): ToolEvidenceCandidate {
	return {
		id: `calendar:${citation.url}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.label,
		sourceType: "tool",
	};
}

function buildPayload(params: {
	success: boolean;
	action: CalendarToolInput["action"];
	message: string;
	events?: CalendarToolEventItem[];
	busy?: CalendarToolBusyItem[];
	calendars?: CalendarToolCalendarItem[];
	citations?: CalendarCitation[];
	pendingWriteId?: string;
	preview?: WritePreview;
}): CalendarToolOutcome {
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "calendar",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			events: params.events ?? [],
			busy: params.busy ?? [],
			calendars: params.calendars ?? [],
			citations,
			...(params.pendingWriteId
				? { pendingWriteId: params.pendingWriteId }
				: {}),
			...(params.preview ? { preview: params.preview } : {}),
		},
		candidates: citations.map(toCandidate),
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	return `You have ${connections.length} Calendar connections (${labels}); using "${conn.label}" for this request.`;
}

function withAmbiguityPrefix(
	message: string,
	ambiguous: boolean,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	return ambiguous ? `${ambiguityNote(conn, connections)} ${message}` : message;
}

function mapAdapterError(err: unknown): string {
	if (err instanceof GoogleCalendarError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your Google Calendar connection needs to be reconnected before I can access your calendar. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your Google Calendar connection couldn't be found. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your calendar right now. Please try again in a moment.";
		}
	}
	if (err instanceof AppleCalDavError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your Apple iCloud Calendar connection needs to be reconnected before I can access your calendar. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your Apple iCloud Calendar connection couldn't be found. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your calendar right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your calendar right now. Please try again in a moment.";
}

// Maps a provider's CalendarEvent[] onto the tool's own model-facing shape,
// dropping any provider-internal fields that shouldn't reach the payload —
// today that's just `etag` (Apple CalDAV only; carried on CalendarEvent for
// Phase 6.2 writes, never meant for the model or the Sources tab).
function toToolEventItem(event: CalendarEvent): CalendarToolEventItem {
	return {
		id: event.id,
		...(event.summary ? { summary: event.summary } : {}),
		start: event.start,
		end: event.end,
		...(event.location ? { location: event.location } : {}),
		htmlLink: event.htmlLink,
	};
}

// Dispatches list_events to the right provider adapter based on
// `conn.provider` — google -> googleListEvents (server-side `q` search +
// `maxResults`), apple -> appleListEvents (CalDAV REPORT has no equivalent
// free-text search, so `query` is not applied server-side for Apple; results
// are still capped at MAX_EVENTS client-side to match Google's bound).
async function listEventsForConnection(
	userId: string,
	conn: ConnectionPublic,
	params: {
		timeMin: string;
		timeMax: string;
		query?: string;
		calendarId?: string;
	},
): Promise<CalendarToolEventItem[]> {
	if (conn.provider === "apple") {
		// appleListEvents (CalDAV) has no per-calendar scoping parameter — it
		// always REPORTs across every calendar collection in the connection's
		// config. `calendarId` is therefore intentionally NOT forwarded here;
		// runCalendarTool surfaces a "using your default calendar(s)" note in the
		// message (see appleCalendarIdIgnored) rather than silently pretending a
		// non-primary Apple calendarId was honored (Trap C1).
		const events = await appleListEvents(userId, conn.id, {
			timeMin: params.timeMin,
			timeMax: params.timeMax,
		});
		return events.slice(0, MAX_EVENTS).map(toToolEventItem);
	}
	// Trap C1 fix: `calendarId` now flows into googleListEvents so a scoped read
	// actually hits the requested calendar. Omitted -> undefined -> the adapter
	// falls back to "primary" (google-calendar.ts), preserving the prior
	// default-primary behavior exactly.
	const events = await googleListEvents(userId, conn.id, {
		timeMin: params.timeMin,
		timeMax: params.timeMax,
		q: params.query,
		maxResults: MAX_EVENTS,
		...(params.calendarId ? { calendarId: params.calendarId } : {}),
	});
	return events.map(toToolEventItem);
}

// True when a non-primary `calendarId` was requested against an Apple
// connection, which appleListEvents can't scope to — the caller surfaces a
// plain "using your default calendar" note rather than silently returning
// all-calendar results as if they were scoped (Trap C1).
function appleCalendarIdIgnored(
	conn: ConnectionPublic,
	input: CalendarToolInput,
): boolean {
	return (
		conn.provider === "apple" &&
		Boolean(input.calendarId) &&
		input.calendarId !== "primary"
	);
}

function listEventsOutcome(
	conn: ConnectionPublic,
	events: CalendarToolEventItem[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
	ignoredCalendarId = false,
): CalendarToolOutcome {
	const citations: CalendarCitation[] = events.map((event) => ({
		label:
			event.summary && event.summary.length > 0
				? event.summary
				: "(untitled event)",
		url: event.htmlLink,
	}));
	const base =
		events.length === 0
			? "No events found in that range."
			: `Found ${events.length} ${events.length === 1 ? "event" : "events"}.`;
	// Trap C1: never let a non-primary Apple calendarId look honored — say
	// plainly that the read spanned the connection's default calendar(s).
	const message = ignoredCalendarId
		? `I'm using your default Apple iCloud calendar(s) — I can't scope a read to a specific calendar on an Apple connection yet. ${base}`
		: base;
	return buildPayload({
		success: true,
		action: "list_events",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		events,
		citations,
	});
}

function freeBusyOutcome(
	conn: ConnectionPublic,
	busy: CalendarToolBusyItem[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): CalendarToolOutcome {
	const totalIntervals = busy.reduce(
		(sum, entry) => sum + entry.busy.length,
		0,
	);
	const message =
		totalIntervals === 0
			? "You're free for the entire requested range."
			: `Found ${totalIntervals} busy ${totalIntervals === 1 ? "interval" : "intervals"} in that range.`;
	return buildPayload({
		success: true,
		action: "check_availability",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		busy,
	});
}

// ---------------------------------------------------------------------------
// list_calendars (Gap A5) — surfaces the user's calendars so the model can
// discover the ids it then passes back as `calendarId` to scope a read/write.
// Backed by the EXISTING googleListCalendars adapter. Apple has no equivalent
// enumeration wired up here (that would mean touching the CalDAV provider,
// out of scope), so an Apple-only connection falls back to the calendar
// collection URLs already discovered into its config — labeled plainly, with
// a note that those ids can't be used to scope a read (Trap C1).
// ---------------------------------------------------------------------------

function googleCalendarsOutcome(
	conn: ConnectionPublic,
	calendars: CalendarToolCalendarItem[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): CalendarToolOutcome {
	const message =
		calendars.length === 0
			? "No calendars found on your Google account."
			: `Found ${calendars.length} ${calendars.length === 1 ? "calendar" : "calendars"}. Pass a calendar's id as calendarId to scope a read or write to it.`;
	return buildPayload({
		success: true,
		action: "list_calendars",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		calendars,
	});
}

// Derives a human-readable name from a CalDAV calendar collection URL — its
// last non-empty path segment (e.g. ".../calendars/home/" -> "home"). Falls
// back to the raw URL for anything unparseable.
function appleCalendarName(url: string): string {
	try {
		const path = new URL(url).pathname.replace(/\/+$/, "");
		const segment = path.slice(path.lastIndexOf("/") + 1);
		return segment ? decodeURIComponent(segment) : url;
	} catch {
		return url;
	}
}

function appleCalendarsOutcome(conn: ConnectionPublic): CalendarToolOutcome {
	const urls = Array.isArray(conn.config.calendarUrls)
		? conn.config.calendarUrls.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const calendars: CalendarToolCalendarItem[] = urls.map((url) => ({
		id: url,
		summary: appleCalendarName(url),
	}));
	if (calendars.length === 0) {
		return buildPayload({
			success: false,
			action: "list_calendars",
			message:
				"I couldn't enumerate your Apple iCloud calendars — try reconnecting it in Settings.",
		});
	}
	return buildPayload({
		success: true,
		action: "list_calendars",
		// Honesty (Trap C1): Apple reads can't be scoped to one of these yet, so
		// don't imply the model can use these ids as a read scope.
		message: `Found ${calendars.length} Apple iCloud ${calendars.length === 1 ? "calendar" : "calendars"}. Note: I can't yet scope a read to a single Apple calendar — an Apple read always spans all of them.`,
		calendars,
	});
}

async function listCalendarsOutcome(
	userId: string,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): Promise<CalendarToolOutcome> {
	// googleListCalendars is the only real calendar enumerator wired up — prefer
	// any Google connection among the user's Calendar connections, mirroring how
	// check_availability falls back to Google for free/busy.
	const googleConnections = connections.filter((c) => c.provider === "google");
	const googleConn = googleConnections[0];
	if (googleConn) {
		const entries = await googleListCalendars(userId, googleConn.id);
		const calendars: CalendarToolCalendarItem[] = entries.map((entry) => ({
			id: entry.id,
			summary: entry.summary,
			...(entry.primary ? { primary: true } : {}),
		}));
		return googleCalendarsOutcome(
			googleConn,
			calendars,
			needsDisambiguation(googleConnections),
			googleConnections,
		);
	}

	// No Google connection — the resolved connection is Apple (or another
	// provider). Surface the CalDAV collections from config for an Apple one.
	if (conn.provider === "apple") {
		return appleCalendarsOutcome(conn);
	}

	return buildPayload({
		success: false,
		action: "list_calendars",
		message:
			"Listing your calendars needs a Google Calendar connection right now.",
	});
}

// Redacts the MODEL-FACING citation labels once Option A distillation has
// applied. Unlike files.ts (where citations[].label is a filename — metadata
// distinct from the protected file body), calendar.ts's citations[].label is
// populated with the exact same raw event `summary` that Option A strips
// from `events[]`. Leaving it untouched would let the raw title reach the
// cloud model through `citations` even though `events[].summary` was
// stripped two fields earlier in the same payload — so it must be redacted
// here too. `outcome.candidates` (built from the *original*, unredacted
// citations in `buildPayload`, before this gate ever runs) is intentionally
// left alone: it feeds the user's own Sources tab on their own screen, a
// different channel from what the model sees, and may keep the real title.
function redactCitationsForModel(
	events: CalendarToolEventItem[],
	citations: CalendarCitation[],
): CalendarCitation[] {
	return citations.map((citation, index) => {
		const start = events[index]?.start;
		return {
			...citation,
			label: start ? `Calendar event at ${start}` : "Calendar event",
		};
	});
}

// Locality Option A: when the user has opted in to local distillation and the
// selected chat model is cloud, replace raw event text (summary/location —
// analogous to a file's body content) with a summary produced by a local
// model before it reaches the (cloud) model. This includes redacting
// `citations[].label` in the MODEL-facing payload (see
// `redactCitationsForModel` above) — citations are not metadata here the way
// a filename is for the files tool, since the label is the raw summary
// itself.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: CalendarToolInput;
	outcome: CalendarToolOutcome;
}): Promise<CalendarToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;

	const rawTextParts = outcome.modelPayload.events
		.map((event) => {
			const descriptors = [event.summary, event.location].filter(
				(value): value is string => Boolean(value),
			);
			if (descriptors.length === 0) return null;
			return `${descriptors.join(" @ ")} (${event.start} to ${event.end})`;
		})
		.filter((value): value is string => Boolean(value));
	// Nothing raw to protect (e.g. every event is untitled with no location) —
	// the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "calendar",
		userQuestion: input.query ?? "",
		rawText: rawTextParts.join("\n"),
	});
	if (!decision.shouldDistill) return outcome;

	const strippedEvents = outcome.modelPayload.events.map((event) => {
		const { summary: _summary, location: _location, ...rest } = event;
		return rest;
	});
	// Redact only the MODEL-facing copy — `outcome.candidates` (the
	// user-facing Sources-tab list) was already built from the original,
	// unredacted citations in `buildPayload` and is untouched by this gate.
	const redactedCitations = redactCitationsForModel(
		outcome.modelPayload.events,
		outcome.modelPayload.citations,
	);

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				events: strippedEvents,
				citations: redactedCitations,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"These events couldn't be privately summarized for a cloud model, so their details were withheld. Switch to a local model to view them, or try again.",
			citations: redactedCitations,
			events: strippedEvents,
		},
	};
}

// ---------------------------------------------------------------------------
// Write actions (Issue 6.1) — create_event/update_event/delete_event. These
// NEVER execute a mutation: like files.ts's "save" action, each one builds a
// WriteOperation, runs it through buildWritePreview (4.1), and hands it to
// createPendingWrite (4.3), which persists a PENDING row and nothing more.
// The only path from here to an actual Google Calendar mutation is the user
// explicitly confirming via the confirm API — a separate request entirely,
// dispatched by the "google" write-executor (providers/google-calendar-write
// .ts) registered in Issue 6.1.
// ---------------------------------------------------------------------------

// Calendar reads (5.1/5.2) only ever requested calendar.readonly; a write
// needs the broader calendar.events scope, requested incrementally rather
// than up front (Phase 7 UI). Until the user reconnects and grants it, every
// write action degrades to a note — never a pending row.
const CALENDAR_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function hasCalendarWriteScope(conn: ConnectionPublic): boolean {
	return conn.oauthScopes.includes(CALENDAR_WRITE_SCOPE);
}

// True when `event` is part of a recurring series — either it's an expanded
// instance (recurringEventId points at its master) or it IS the master
// itself (non-empty `recurrence`). Either signal is enough to require the
// user pick a recurringScope before this tool ever proposes a write for it.
function isRecurring(event: CalendarEvent): boolean {
	return Boolean(event.recurringEventId) || Boolean(event.recurrence?.length);
}

// True when `event` IS the recurring series' own definition (carries a
// non-empty `recurrence` array) rather than one of its expanded instances
// (which carry `recurringEventId` instead). Distinguishing this from
// isRecurring above matters specifically for `recurringScope: "this_event"`:
// if the id the user/model gave for "this event only" turns out to resolve
// to the master itself, there is no single occurrence to scope the write to
// — proceeding would let a "this event only" request silently mutate the
// whole series at confirm time. See resolveTargetEventId's matching
// fail-closed check in the write executor for the same guardrail applied
// again right before the actual PATCH/DELETE.
function isRecurringMaster(event: CalendarEvent): boolean {
	return Boolean(event.recurrence?.length);
}

type CalendarWriteAction = "create_event" | "update_event" | "delete_event";

function isCalendarWriteAction(
	action: CalendarToolInput["action"],
): action is CalendarWriteAction {
	return (
		action === "create_event" ||
		action === "update_event" ||
		action === "delete_event"
	);
}

// ---------------------------------------------------------------------------
// Google write actions (Issue 6.1). Kept separate from the Apple ones below
// (Issue 6.2) rather than unified behind a single provider-branching
// function: the two providers' write semantics genuinely differ (Google's
// PATCH is a true partial update with server-side recurring-instance ids;
// CalDAV's PUT replaces the whole resource and has no instance/master
// distinction at all), so sharing one code path would mean threading
// provider-specific branches through nearly every line rather than two
// smaller, independently readable functions.
// ---------------------------------------------------------------------------

async function proposeCreateEvent(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: CalendarToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<CalendarToolOutcome> {
	// title/start/end are the user's own words from this turn, not connector-
	// read data — no locality distillation gate applies here (contrast with
	// update/delete below, which read an EXISTING event off the connector).
	if (!input.title || !input.start || !input.end) {
		return buildPayload({
			success: false,
			action: "create_event",
			message:
				"A title, start time, and end time are required to create an event.",
		});
	}

	const calendarId = input.calendarId ?? "primary";
	const eventFields = {
		summary: input.title,
		start: input.start,
		end: input.end,
		...(input.location ? { location: input.location } : {}),
		...(input.description ? { description: input.description } : {}),
	};

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "calendar.create_event",
		summary: `Create "${input.title}" on your Google Calendar`,
		reversible: true, // Google keeps history/trash for created events.
		destructive: false,
		target: { label: input.title },
		// Ties the deterministic client-supplied Google event id (6.1 write
		// executor) to this exact payload: an identical create request (a
		// retried confirm, or a byte-for-byte repeat tool call) maps onto the
		// same idempotencyKey and therefore the same Google event id, so
		// Google's own 409 on re-insert becomes the idempotent-success signal
		// rather than a silent duplicate event.
		payloadFingerprint: JSON.stringify({ calendarId, ...eventFields }),
	};
	const preview = buildWritePreview(op);

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify({ calendarId, event: eventFields }),
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared "${input.title}" to be added to your Google Calendar, but it has NOT been created yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "create_event",
		message,
		pendingWriteId,
		preview,
	});
}

async function proposeUpdateOrDeleteEvent(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: CalendarToolInput,
	action: "update_event" | "delete_event",
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<CalendarToolOutcome> {
	if (!input.eventId) {
		return buildPayload({
			success: false,
			action,
			message: "An event id is required to update or delete an event.",
		});
	}

	const calendarId = input.calendarId ?? "primary";
	let existing: CalendarEvent | null;
	try {
		existing = await googleGetEvent(userId, conn.id, {
			calendarId,
			eventId: input.eventId,
		});
	} catch (err) {
		return buildPayload({
			success: false,
			action,
			message: mapAdapterError(err),
		});
	}
	if (!existing) {
		return buildPayload({
			success: false,
			action,
			message: "I couldn't find that event on your calendar.",
		});
	}

	// Recurring guardrail — never silently pick "this event" or "the whole
	// series" on the user's behalf. Both scoping signals a single fetched
	// event can carry (recurringEventId for an instance, recurrence for the
	// master) are checked by isRecurring above.
	if (isRecurring(existing) && !input.recurringScope) {
		return buildPayload({
			success: false,
			action,
			message:
				'That event is part of a recurring series. Should I apply this to just this event, or the whole series? Reply with "this event" or "the whole series" and I\'ll try again.',
		});
	}

	// The id given resolves to the series' own definition (the master), not a
	// single occurrence — "this event only" has nothing to scope to. Ask which
	// occurrence was meant (or to apply to the whole series instead) rather
	// than ever creating a pending write that would clobber the whole series
	// at confirm time. This is caught here, before any pending row exists; the
	// write executor enforces the same rule again, fail-closed, at confirm
	// time in case content ever reaches it some other way.
	if (isRecurringMaster(existing) && input.recurringScope === "this_event") {
		return buildPayload({
			success: false,
			action,
			message:
				'That event id refers to the whole recurring series, not a single occurrence, so I can\'t apply this to "this event only." Tell me which occurrence you mean (e.g. its date), or say "the whole series" to apply it to all of them.',
		});
	}

	const isUpdate = action === "update_event";
	const label = input.title ?? existing.summary ?? "(untitled event)";
	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: isUpdate ? "calendar.update_event" : "calendar.delete_event",
		summary: isUpdate
			? `Update "${label}" on your Google Calendar`
			: `Delete "${label}" from your Google Calendar`,
		reversible: true, // Google keeps history/trash for updated/deleted events.
		destructive: true, // update-that-overwrites and delete are both destructive.
		target: { id: input.eventId, label },
	};
	const rawPreview = buildWritePreview(op);

	const content = {
		calendarId,
		eventId: input.eventId,
		...(isUpdate
			? {
					event: {
						...(input.title !== undefined ? { summary: input.title } : {}),
						...(input.start !== undefined ? { start: input.start } : {}),
						...(input.end !== undefined ? { end: input.end } : {}),
						...(input.location !== undefined
							? { location: input.location }
							: {}),
						...(input.description !== undefined
							? { description: input.description }
							: {}),
					},
				}
			: {}),
		...(input.recurringScope ? { recurringScope: input.recurringScope } : {}),
	};

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify(content),
		idempotencyKey: idempotencyKey(op),
		// The DB row keeps the RAW preview (real title/location) — this is
		// what a future confirm-card UI would render for the user on their own
		// screen, a channel entirely separate from the model-facing payload
		// built below. It is never sent back through the model.
		preview: rawPreview,
		conversationId,
	});

	// Option A (locality): `existing.summary`/`existing.location` are
	// connector-READ data (fetched from Google above), exactly the kind of
	// raw content the files/calendar READ paths already gate — so the same
	// gate applies here to the MODEL-FACING preview/message. Unlike a plain
	// read, the pending write's stored preview (just above) is deliberately
	// left untouched: only the copy returned in this outcome's `preview`/
	// `message` (what the model sees) is redacted.
	const rawTextParts = [existing.summary, existing.location].filter(
		(value): value is string => Boolean(value),
	);
	const decision =
		rawTextParts.length > 0
			? await decideLocalDistill({
					userId,
					modelId,
					capability: "calendar",
					userQuestion: input.title ?? "",
					rawText: rawTextParts.join(" @ "),
				})
			: ({ shouldDistill: false } as const);

	let modelPreview = rawPreview;
	let redactedNote = "";
	if (decision.shouldDistill) {
		modelPreview = {
			...rawPreview,
			title: isUpdate ? "Update a calendar event" : "Delete a calendar event",
			detail: `${op.action} — calendar event`,
		};
		redactedNote =
			"distilled" in decision
				? ` Privately summarized for a cloud model. Summary: ${decision.distilled}`
				: " Its details couldn't be privately summarized for a cloud model, so they were withheld.";
	}

	const actionVerb = isUpdate ? "changes to" : "the deletion of";
	const notYetVerb = isUpdate ? "applied" : "deleted";
	const baseMessage = `I've prepared ${actionVerb} a calendar event, but it has NOT been ${notYetVerb} yet — it is PENDING and awaiting your explicit confirmation. ${modelPreview.detail}${redactedNote}${modelPreview.warnings.length > 0 && !decision.shouldDistill ? ` Warnings: ${modelPreview.warnings.join("; ")}.` : ""}`;

	const message = withAmbiguityPrefix(
		baseMessage,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action,
		message,
		pendingWriteId,
		preview: modelPreview,
	});
}

// ---------------------------------------------------------------------------
// Apple write actions (Issue 6.2). CalDAV has no partial-update primitive
// (a PUT replaces the whole resource) and no server-side notion of a
// recurring instance distinct from its master — so this tool's Apple
// guardrails are deliberately simpler and MORE conservative than Google's:
//   - update_event on ANY recurring event is refused outright, before a
//     pending write is ever created (never a recurringScope prompt — CalDAV
//     genuinely has nothing safe to scope a partial update to).
//   - delete_event on a recurring event is allowed (CalDAV only has one
//     resource per series to delete), but the preview must say so plainly.
// ---------------------------------------------------------------------------

function appleWriteCalendarUrl(conn: ConnectionPublic): string | null {
	const urls = conn.config.calendarUrls;
	if (!Array.isArray(urls)) return null;
	const first = urls.find(
		(value): value is string => typeof value === "string",
	);
	return first ?? null;
}

const APPLE_MISSING_CONFIG_MESSAGE =
	"Your Apple iCloud Calendar connection is missing its calendar configuration — try reconnecting it in Settings.";

async function proposeAppleCreateEvent(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: CalendarToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<CalendarToolOutcome> {
	// title/start/end are the user's own words from this turn, not connector-
	// read data — no locality distillation gate applies here (contrast with
	// update/delete below, which read an EXISTING event off the connector).
	if (!input.title || !input.start || !input.end) {
		return buildPayload({
			success: false,
			action: "create_event",
			message:
				"A title, start time, and end time are required to create an event.",
		});
	}

	const calendarUrl = appleWriteCalendarUrl(conn);
	if (!calendarUrl) {
		return buildPayload({
			success: false,
			action: "create_event",
			message: APPLE_MISSING_CONFIG_MESSAGE,
		});
	}

	const eventFields = {
		summary: input.title,
		start: input.start,
		end: input.end,
		...(input.location ? { location: input.location } : {}),
		...(input.description ? { description: input.description } : {}),
	};

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "calendar.create_event",
		summary: `Create "${input.title}" on your Apple iCloud Calendar`,
		// Unlike Google (which keeps history/trash for created events), Apple
		// CalDAV has no platform-level undo exposed through this connection —
		// deleting it back out is the only way to reverse a create.
		reversible: false,
		destructive: false,
		target: { label: input.title },
		// Ties the deterministic client-derived UID (6.2 write executor) to
		// this exact payload — see appleEventUidForOp's doc comment.
		payloadFingerprint: JSON.stringify({ calendarUrl, ...eventFields }),
	};
	const preview = buildWritePreview(op);

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify({ calendarUrl, event: eventFields }),
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared "${input.title}" to be added to your Apple iCloud Calendar, but it has NOT been created yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "create_event",
		message,
		pendingWriteId,
		preview,
	});
}

async function proposeAppleUpdateOrDeleteEvent(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: CalendarToolInput,
	action: "update_event" | "delete_event",
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<CalendarToolOutcome> {
	if (!input.eventId) {
		return buildPayload({
			success: false,
			action,
			message: "An event id is required to update or delete an event.",
		});
	}

	let existing: CalendarEvent | null;
	try {
		existing = await appleGetEventByUid(userId, conn.id, input.eventId);
	} catch (err) {
		return buildPayload({
			success: false,
			action,
			message: mapAdapterError(err),
		});
	}
	if (!existing) {
		return buildPayload({
			success: false,
			action,
			message: "I couldn't find that event on your calendar.",
		});
	}
	if (!existing.htmlLink || !existing.etag) {
		// Every event parseReportMultistatus produces carries an absolute href;
		// a missing etag means the server omitted getetag for this resource —
		// either way, there's nothing safe to condition a PUT/DELETE on.
		return buildPayload({
			success: false,
			action,
			message:
				"I couldn't safely identify that event's underlying Apple iCloud resource, so I can't make this change. Please try again.",
		});
	}

	const isUpdate = action === "update_event";
	const recurring = isRecurring(existing);

	// Recurring guardrail — CalDAV has no "this occurrence only" primitive
	// and no separate master/instance ids the way Google exposes, so there is
	// nothing safe to scope a partial update to. Refused here, BEFORE any
	// pending write exists — this never reaches the write executor. Deleting
	// a recurring event is still allowed (see below): CalDAV keeps a whole
	// series as ONE resource, so deleting it is unambiguous, just more
	// consequential — the preview below states that plainly.
	if (isUpdate && recurring) {
		return buildPayload({
			success: false,
			action,
			message:
				"That event is part of a recurring series, and I can't safely update recurring events on your Apple iCloud Calendar yet — try a Google Calendar connection instead, or delete and recreate this event.",
		});
	}
	// Corruption-safety gate: an update PATCHES the original resource's exact
	// text in place (see AppleCalendarWriteContent.originalIcs's doc comment
	// on the executor side) rather than regenerating a brand-new VEVENT from
	// only this tool's fields — without the original text there is nothing
	// safe to patch, so refuse here rather than let a pending write reach the
	// executor with no way to honor that guarantee.
	if (isUpdate && !existing.rawIcs) {
		return buildPayload({
			success: false,
			action,
			message:
				"I couldn't safely read that event's full details from your Apple iCloud Calendar, so I can't make this change. Please try again.",
		});
	}

	const label = input.title ?? existing.summary ?? "(untitled event)";
	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: isUpdate ? "calendar.update_event" : "calendar.delete_event",
		summary: isUpdate
			? `Update "${label}" on your Apple iCloud Calendar`
			: `Delete "${label}" from your Apple iCloud Calendar${recurring ? " — this deletes the ENTIRE recurring series" : ""}`,
		// Apple CalDAV has no platform trash/version history exposed through
		// this connection, unlike Google's — an overwrite or delete here
		// cannot be recovered through AlfyAI.
		reversible: false,
		destructive: true,
		target: { id: input.eventId, label },
	};
	const rawPreview = buildWritePreview(op);
	if (!isUpdate && recurring) {
		rawPreview.warnings = [
			...rawPreview.warnings,
			"This deletes the ENTIRE recurring series, not a single occurrence.",
		];
	}

	const content = {
		resourceHref: existing.htmlLink,
		etag: existing.etag,
		uid: input.eventId,
		...(isUpdate
			? {
					// The executor PATCHES this original text in place rather than
					// regenerating a fresh VEVENT — see AppleCalendarWriteContent
					// .originalIcs's doc comment for why (corruption-safety fix:
					// preserves ATTENDEE/ORGANIZER/VALARM/RRULE/CATEGORIES/X-*/...
					// that this tool's minimal event fields don't model). Guarded
					// non-null above (`isUpdate && !existing.rawIcs` bails out
					// first).
					originalIcs: existing.rawIcs,
					// CalDAV's PUT REPLACES the whole resource — unlike Google's
					// PATCH, an omitted field would be silently deleted rather than
					// left unchanged. Every field is therefore always sent, falling
					// back to the EXISTING value for anything the user didn't ask to
					// change (Option A's redaction below only affects the
					// MODEL-facing copy, never this raw content the executor uses).
					event: {
						summary: input.title ?? existing.summary,
						start: input.start ?? existing.start,
						end: input.end ?? existing.end,
						...(input.location !== undefined
							? { location: input.location }
							: existing.location !== undefined
								? { location: existing.location }
								: {}),
						...(input.description !== undefined
							? { description: input.description }
							: existing.description !== undefined
								? { description: existing.description }
								: {}),
					},
					recurring: false, // update never reaches this point when recurring
				}
			: { recurring }),
	};

	const { id: pendingWriteId } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify(content),
		idempotencyKey: idempotencyKey(op),
		// The DB row keeps the RAW preview (real title/location) — see the
		// matching comment in proposeUpdateOrDeleteEvent (Google) above; the
		// same posture applies here.
		preview: rawPreview,
		conversationId,
	});

	// Option A (locality): `existing.summary`/`existing.location` are
	// connector-READ data, exactly the kind of raw content the read paths
	// already gate — same rule as the Google branch above.
	const rawTextParts = [existing.summary, existing.location].filter(
		(value): value is string => Boolean(value),
	);
	const decision =
		rawTextParts.length > 0
			? await decideLocalDistill({
					userId,
					modelId,
					capability: "calendar",
					userQuestion: input.title ?? "",
					rawText: rawTextParts.join(" @ "),
				})
			: ({ shouldDistill: false } as const);

	let modelPreview = rawPreview;
	let redactedNote = "";
	if (decision.shouldDistill) {
		modelPreview = {
			...rawPreview,
			title: isUpdate ? "Update a calendar event" : "Delete a calendar event",
			detail: `${op.action} — calendar event`,
		};
		redactedNote =
			"distilled" in decision
				? ` Privately summarized for a cloud model. Summary: ${decision.distilled}`
				: " Its details couldn't be privately summarized for a cloud model, so they were withheld.";
	}

	const actionVerb = isUpdate ? "changes to" : "the deletion of";
	const notYetVerb = isUpdate ? "applied" : "deleted";
	const baseMessage = `I've prepared ${actionVerb} a calendar event, but it has NOT been ${notYetVerb} yet — it is PENDING and awaiting your explicit confirmation. ${modelPreview.detail}${redactedNote}${modelPreview.warnings.length > 0 && !decision.shouldDistill ? ` Warnings: ${modelPreview.warnings.join("; ")}.` : ""}`;

	const message = withAmbiguityPrefix(
		baseMessage,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action,
		message,
		pendingWriteId,
		preview: modelPreview,
	});
}

async function calendarWriteOutcome(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: CalendarToolInput,
	action: CalendarWriteAction,
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<CalendarToolOutcome> {
	// Google and Apple only for v1. No pending write for a connection this
	// tool can't act on.
	if (conn.provider !== "google" && conn.provider !== "apple") {
		return buildPayload({
			success: false,
			action,
			message:
				"Calendar writes are only supported for Google and Apple iCloud connections right now.",
		});
	}

	// Hard gate, checked BEFORE any network call — same posture as
	// executeNextcloudWrite/saveOutcome (4.2/4.3): nothing below this line
	// runs, and no pending row is created, when writes are disabled.
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action,
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	// The write OAuth scope check is Google-only — Apple has no OAuth scope
	// concept, its app-specific password already grants full CalDAV access,
	// gated purely by allowWrites above.
	if (conn.provider === "google" && !hasCalendarWriteScope(conn)) {
		return buildPayload({
			success: false,
			action,
			message:
				"I don't have permission to make changes to your Google Calendar yet — please reconnect Google and grant calendar write access, then try again.",
		});
	}

	if (conn.provider === "apple") {
		return action === "create_event"
			? proposeAppleCreateEvent(
					userId,
					conversationId,
					conn,
					input,
					ambiguous,
					connections,
				)
			: proposeAppleUpdateOrDeleteEvent(
					userId,
					conversationId,
					conn,
					input,
					action,
					ambiguous,
					connections,
					modelId,
				);
	}

	if (action === "create_event") {
		return proposeCreateEvent(
			userId,
			conversationId,
			conn,
			input,
			ambiguous,
			connections,
		);
	}
	return proposeUpdateOrDeleteEvent(
		userId,
		conversationId,
		conn,
		input,
		action,
		ambiguous,
		connections,
		modelId,
	);
}

// Resolves the user's Calendar connection(s) — now spanning both google and
// apple providers (5.3) — and executes a list_events/check_availability
// lookup, or (6.1) proposes a create/update/delete_event write, degrading
// gracefully (never throwing) so a connection problem never aborts the chat
// turn: no connection, ambiguity, and adapter failures all resolve to a
// `{ success: false, message }`-shaped payload instead.
export async function runCalendarTool(
	userId: string,
	input: CalendarToolInput,
	modelId: string,
	conversationId?: string,
): Promise<CalendarToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "calendar");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Calendar connection set up yet. Connect your Google or Apple iCloud account in Settings to check your calendar.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Calendar connection set up yet. Connect your Google or Apple iCloud account in Settings to check your calendar.",
		});
	}

	// Write actions (6.1) are proposal-only and branch here — before the
	// read-side range resolution below — same posture as files.ts's "save"
	// branching ahead of its shared secret-fetch flow.
	if (isCalendarWriteAction(input.action)) {
		return calendarWriteOutcome(
			userId,
			conversationId,
			conn,
			input,
			input.action,
			ambiguous,
			connections,
			modelId,
		);
	}

	try {
		// list_calendars (Gap A5) needs no time range — discovery only. Kept
		// inside the try so an adapter failure degrades to a graceful note like
		// every other read.
		if (input.action === "list_calendars") {
			return await listCalendarsOutcome(userId, conn, connections);
		}

		const { timeMin, timeMax } = resolveRange(input);

		if (input.action === "list_events") {
			const events = await listEventsForConnection(userId, conn, {
				timeMin,
				timeMax,
				query: input.query,
				calendarId: input.calendarId,
			});
			const outcome = listEventsOutcome(
				conn,
				events,
				ambiguous,
				connections,
				appleCalendarIdIgnored(conn, input),
			);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		// check_availability has no CalDAV free/busy equivalent wired up yet
		// (5.3 scope) — it stays google-only. If the resolved connection isn't
		// google, look for any google connection among the user's Calendar
		// connections before giving up.
		const googleConnections = connections.filter(
			(c) => c.provider === "google",
		);
		const googleConn = googleConnections[0];
		if (!googleConn) {
			return buildPayload({
				success: false,
				action: "check_availability",
				message:
					"Checking availability needs a Google Calendar connection — Apple iCloud calendars don't support free/busy lookups yet. Connect a Google account in Settings, or ask me to list your Apple events instead.",
			});
		}
		const googleAmbiguous = needsDisambiguation(googleConnections);
		// Trap C1 fix: scope free/busy to a requested calendarId when given;
		// omitted -> undefined -> googleFreeBusy defaults to ["primary"],
		// preserving the prior default-primary behavior exactly.
		const busy = await googleFreeBusy(userId, googleConn.id, {
			timeMin,
			timeMax,
			...(input.calendarId ? { calendarIds: [input.calendarId] } : {}),
		});
		return freeBusyOutcome(
			googleConn,
			busy,
			googleAmbiguous,
			googleConnections,
		);
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
