import { z } from "zod";
import { microsoftCanWrite } from "$lib/shared/microsoft-permissions";
import { type ConnectionPublic, getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import { idempotencyKey } from "../write-guard";
import { type CalendarEvent, validGoogleEventTimes } from "./google-calendar";
import { microsoftGraphRequest } from "./microsoft-graph";
import { OneDriveError, onedriveGetAccessTokenForRead } from "./onedrive";

type Options = { fetch?: typeof fetch };
const id = z
	.string()
	.min(1)
	.refine((value) => value !== "." && value !== "..");
function eventsPath(calendar: string) {
	return `${
		calendar === "primary"
			? "/me/calendar"
			: `/me/calendars/${encodeURIComponent(id.parse(calendar))}`
	}/events`;
}
const timed = z.object({ dateTime: z.string(), timeZone: z.literal("UTC") });
const details = z.object({
	id,
	subject: z.string().nullish(),
	start: timed,
	end: timed,
	location: z.object({ displayName: z.string().nullish() }).nullish(),
	type: z.enum(["singleInstance", "occurrence", "exception", "seriesMaster"]),
	seriesMasterId: z.string().nullish(),
	isAllDay: z.boolean(),
	isOnlineMeeting: z.boolean(),
	isOrganizer: z.boolean(),
	attendees: z.array(z.unknown()),
	originalStartTimeZone: z.string().optional(),
	"@odata.etag": z.string().min(1),
});
export async function outlookGetEvent(
	conn: ConnectionPublic,
	calendar: string,
	eventId: string,
	opts?: Options,
): Promise<
	| (CalendarEvent & {
			allDayTimeZone?: string;
			isOnlineMeeting?: boolean;
			cancellationRecipients?: number;
	  })
	| null
> {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "calendar");
	const path = `${eventsPath(calendar)}/${encodeURIComponent(id.parse(eventId))}`;
	const res = await microsoftGraphRequest(
		token,
		"GET",
		path +
			"?$select=id,subject,start,end,location,type,seriesMasterId,isAllDay,originalStartTimeZone,isOnlineMeeting,isOrganizer,attendees",
		{ ...opts, headers: { Prefer: 'outlook.timezone="UTC"' } },
	);
	if (res.status === 404) return null;
	if (!res.ok)
		throw new OneDriveError(
			"Outlook event was unavailable",
			res.status === 403 || res.status === 401
				? "needs_reauth"
				: "request_failed",
		);
	const e = details.parse(await res.json());
	if (e.id !== eventId)
		throw new OneDriveError(
			"Unexpected Outlook event identifier",
			"request_failed",
		);
	if ((e.type === "occurrence" || e.type === "exception") && !e.seriesMasterId)
		throw new OneDriveError("Missing Outlook series ID", "request_failed");
	let start = e.start.dateTime,
		end = e.end.dateTime;
	const zone = e.originalStartTimeZone;
	if (e.isAllDay && zone && zone !== "UTC") {
		// Graph's UTC projection may place midnight on the previous civil day.
		// Read both local dates from the same revision, in Graph's original zone.
		if (!/^[a-zA-Z0-9 _+./:()-]{1,100}$/.test(zone))
			throw new OneDriveError("Invalid Outlook time zone", "request_failed");
		const local = await microsoftGraphRequest(
			token,
			"GET",
			`${path}?$select=start,end`,
			{ ...opts, headers: { Prefer: `outlook.timezone="${zone}"` } },
		);
		if (!local.ok)
			throw new OneDriveError(
				"Outlook all-day dates unavailable",
				"request_failed",
			);
		const localTime = z.object({
			dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?$/),
			timeZone: z.string(),
		});
		const localEvent = z
			.object({
				start: localTime,
				end: localTime,
				"@odata.etag": z.literal(e["@odata.etag"]),
			})
			.parse(await local.json());
		if (localEvent.start.timeZone !== zone || localEvent.end.timeZone !== zone)
			throw new OneDriveError(
				"Outlook returned dates in an unexpected zone",
				"request_failed",
			);
		start = localEvent.start.dateTime;
		end = localEvent.end.dateTime;
	}
	const outputTime = (value: string) =>
		e.isAllDay
			? value.slice(0, 10)
			: new Date(value.endsWith("Z") ? value : `${value}Z`).toISOString();
	return {
		id: e.id,
		isOnlineMeeting: e.isOnlineMeeting,
		cancellationRecipients: e.isOrganizer ? e.attendees.length : 0,
		summary: e.subject ?? "",
		start: outputTime(start),
		end: outputTime(end),
		...(e.isAllDay ? { allDayTimeZone: zone ?? "UTC" } : {}),
		location: e.location?.displayName ?? undefined,
		etag: e["@odata.etag"],
		htmlLink: "",
		...(e.type === "seriesMaster" ? { recurrence: ["seriesMaster"] } : {}),
		...(e.seriesMasterId ? { recurringEventId: e.seriesMasterId } : {}),
	};
}
const fields = z.object({
	timeZone: z.string().min(1).max(100).optional(),
	summary: z.string().optional(),
	start: z.string().optional(),
	end: z.string().optional(),
	location: z.string().optional(),
	description: z.string().optional(),
});
const contentSchema = z.object({
	calendarId: id,
	isOnlineMeeting: z.boolean().optional(),
	eventId: id.optional(),
	event: fields.optional(),
	etag: z.string().min(1).optional(),
	recurringScope: z.enum(["series", "this_event"]).optional(),
});
function graphEvent(event: z.infer<typeof fields>) {
	const stamp = (value: string) =>
		value.length === 10
			? { dateTime: `${value}T00:00:00`, timeZone: event.timeZone ?? "UTC" }
			: {
					dateTime: new Date(value).toISOString().slice(0, -1),
					timeZone: "UTC",
				};

	return {
		...(event.summary !== undefined ? { subject: event.summary } : {}),
		...(event.location !== undefined
			? { location: { displayName: event.location } }
			: {}),
		...(event.description !== undefined
			? { body: { contentType: "Text", content: event.description } }
			: {}),
		...(event.start ? { start: stamp(event.start) } : {}),
		...(event.end ? { end: stamp(event.end) } : {}),
		...(event.start || event.end
			? { isAllDay: (event.start ?? event.end)?.length === 10 }
			: {}),
	};
}
export const executeOutlookCalendarWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts,
) => {
	const conn = await getConnection(userId, connectionId);
	if (
		conn?.provider !== "onedrive" ||
		conn.status !== "connected" ||
		!conn.allowWrites ||
		!conn.capabilities.includes("calendar") ||
		!microsoftCanWrite(conn, "calendar")
	)
		return { ok: false, reason: "writes_not_allowed" };
	try {
		const p = contentSchema.parse(JSON.parse(content));
		if (!validGoogleEventTimes(p.event?.start, p.event?.end))
			return { ok: false, reason: "invalid_event_time" };
		const path = eventsPath(p.calendarId);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		let endpoint = path,
			method: "POST" | "PATCH" | "DELETE",
			body: unknown;
		if (op.action === "calendar.create_event") {
			if (!p.event?.summary || !p.event.start || !p.event.end)
				return { ok: false, reason: "invalid_event_time" };
			body = { ...graphEvent(p.event), transactionId: idempotencyKey(op) };
			method = "POST";
		} else {
			if (!p.eventId || !p.etag || op.target?.id !== p.eventId)
				return { ok: false, reason: "invalid_target" };
			headers["If-Match"] = p.etag;
			endpoint += `/${encodeURIComponent(p.eventId)}`;
			if (op.action === "calendar.update_event" && p.event) {
				if (p.event.description !== undefined && p.isOnlineMeeting !== false)
					return { ok: false, reason: "online_meeting_notes" };
				method = "PATCH";
				body = graphEvent(p.event);
			} else if (op.action === "calendar.delete_event") method = "DELETE";
			else return { ok: false, reason: "unsupported_operation" };
		}
		const token = await onedriveGetAccessTokenForRead(conn, opts, "calendar");
		const response = await microsoftGraphRequest(token, method, endpoint, {
			...opts,
			headers,
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		return response.ok
			? { ok: true }
			: {
					ok: false,
					reason:
						response.status === 412
							? "target_changed"
							: response.status === 403 || response.status === 401
								? "needs_reauth"
								: "provider_error",
				};
	} catch {
		return { ok: false, reason: "provider_error" };
	}
};
