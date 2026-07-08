import { z } from "zod";
import {
	GoogleCalendarError,
	googleFreeBusy,
	googleListEvents,
} from "$lib/server/services/connections/providers/google-calendar";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

export const calendarToolInputSchema = z.object({
	action: z.enum(["list_events", "check_availability"]),
	start: z.string().optional(),
	end: z.string().optional(),
	query: z.string().optional(),
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
};

export type CalendarToolOutcome = {
	modelPayload: CalendarToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

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
	return "I couldn't reach your calendar right now. Please try again in a moment.";
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

// Locality Option A: when the user has opted in to local distillation and the
// selected chat model is cloud, replace raw event text (summary/location —
// analogous to a file's body content) with a summary produced by a local
// model before it reaches the (cloud) model. Citations (event title + link,
// used for Sources-tab candidates) are metadata for this tool the same way a
// filename is for the files tool, and are left untouched by this gate — see
// files.ts's applyLocalDistillGate for the identical posture there.
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

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				events: strippedEvents,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"These events couldn't be privately summarized for a cloud model, so their details were withheld. Switch to a local model to view them, or try again.",
			events: strippedEvents,
		},
	};
}

// Resolves the user's Calendar connection(s) and executes a list_events/
// check_availability lookup against Google, degrading gracefully (never
// throwing) so a connection problem never aborts the chat turn: no
// connection, ambiguity, and adapter failures all resolve to a
// `{ success: false, message }`-shaped payload instead. Read-only — writes
// (creating/updating events) land in Phase 6.
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
				"You don't have a Calendar connection set up yet. Connect your Google account in Settings to check your calendar.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Calendar connection set up yet. Connect your Google account in Settings to check your calendar.",
		});
	}

	const { timeMin, timeMax } = resolveRange(input);

	try {
		if (input.action === "list_events") {
			const events = await googleListEvents(userId, conn.id, {
				timeMin,
				timeMax,
				q: input.query,
				maxResults: MAX_EVENTS,
			});
			const outcome = listEventsOutcome(conn, events, ambiguous, connections);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		const busy = await googleFreeBusy(userId, conn.id, { timeMin, timeMax });
		return freeBusyOutcome(conn, busy, ambiguous, connections);
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
