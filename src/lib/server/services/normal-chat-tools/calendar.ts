import { z } from "zod";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	AppleCalDavError,
	appleListEvents,
} from "$lib/server/services/connections/providers/apple-caldav";
import {
	type CalendarEvent,
	GoogleCalendarError,
	googleFreeBusy,
	googleGetEvent,
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

export type CalendarToolModelPayload = {
	success: boolean;
	name: "calendar";
	sourceType: "tool";
	action: CalendarToolInput["action"];
	message: string;
	events: CalendarToolEventItem[];
	busy: CalendarToolBusyItem[];
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

function resolveRange(input: CalendarToolInput): {
	timeMin: string;
	timeMax: string;
} {
	const fallback = defaultRange();
	return {
		timeMin: input.start ?? fallback.timeMin,
		timeMax: input.end ?? fallback.timeMax,
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
	params: { timeMin: string; timeMax: string; query?: string },
): Promise<CalendarToolEventItem[]> {
	if (conn.provider === "apple") {
		const events = await appleListEvents(userId, conn.id, {
			timeMin: params.timeMin,
			timeMax: params.timeMax,
		});
		return events.slice(0, MAX_EVENTS).map(toToolEventItem);
	}
	const events = await googleListEvents(userId, conn.id, {
		timeMin: params.timeMin,
		timeMax: params.timeMax,
		q: params.query,
		maxResults: MAX_EVENTS,
	});
	return events.map(toToolEventItem);
}

function listEventsOutcome(
	conn: ConnectionPublic,
	events: CalendarToolEventItem[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): CalendarToolOutcome {
	const citations: CalendarCitation[] = events.map((event) => ({
		label:
			event.summary && event.summary.length > 0
				? event.summary
				: "(untitled event)",
		url: event.htmlLink,
	}));
	const message =
		events.length === 0
			? "No events found in that range."
			: `Found ${events.length} ${events.length === 1 ? "event" : "events"}.`;
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

async function proposeCreateEvent(
	userId: string,
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

async function calendarWriteOutcome(
	userId: string,
	conn: ConnectionPublic,
	input: CalendarToolInput,
	action: CalendarWriteAction,
	ambiguous: boolean,
	connections: ConnectionPublic[],
	modelId: string,
): Promise<CalendarToolOutcome> {
	// Google-only for v1 (6.2 handles Apple). No pending write for a
	// connection this tool can't act on.
	if (conn.provider !== "google") {
		return buildPayload({
			success: false,
			action,
			message: "Calendar writes to Apple are handled separately.",
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

	if (!hasCalendarWriteScope(conn)) {
		return buildPayload({
			success: false,
			action,
			message:
				"I don't have permission to make changes to your Google Calendar yet — please reconnect Google and grant calendar write access, then try again.",
		});
	}

	if (action === "create_event") {
		return proposeCreateEvent(userId, conn, input, ambiguous, connections);
	}
	return proposeUpdateOrDeleteEvent(
		userId,
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
			conn,
			input,
			input.action,
			ambiguous,
			connections,
			modelId,
		);
	}

	const { timeMin, timeMax } = resolveRange(input);

	try {
		if (input.action === "list_events") {
			const events = await listEventsForConnection(userId, conn, {
				timeMin,
				timeMax,
				query: input.query,
			});
			const outcome = listEventsOutcome(conn, events, ambiguous, connections);
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
		const busy = await googleFreeBusy(userId, googleConn.id, {
			timeMin,
			timeMax,
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
