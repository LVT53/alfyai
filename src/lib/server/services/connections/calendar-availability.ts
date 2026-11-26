import { davFreeBusy } from "./dav/free-busy";
import { ConnectionHttpError } from "./provider-http";
import { googleFreeBusy } from "./providers/google-calendar";
import { outlookBusyIntervals } from "./providers/outlook-calendar";
import type { ConnectionPublic } from "./store";

type TimeRange = { start: string; end: string };
type BusyCalendar = { calendarId: string; busy: TimeRange[] };

export async function readConnectionBusy(
	conn: ConnectionPublic,
	range: { timeMin: string; timeMax: string; calendarId?: string },
): Promise<BusyCalendar[]> {
	if (conn.status !== "connected") {
		throw new ConnectionHttpError(
			"Calendar connection is unavailable",
			conn.status === "needs_reauth" ? "needs_reauth" : "request_failed",
		);
	}
	switch (conn.provider) {
		case "google":
			return googleFreeBusy(conn.userId, conn.id, {
				timeMin: range.timeMin,
				timeMax: range.timeMax,
				...(range.calendarId ? { calendarIds: [range.calendarId] } : {}),
			});
		case "apple":
		case "caldav":
			return davFreeBusy(conn, range);
		case "onedrive":
			return [
				{
					calendarId: range.calendarId ?? "primary",
					busy: await outlookBusyIntervals(conn, range),
				},
			];
		default:
			throw new Error("Calendar connection does not support availability");
	}
}

// Merge overlapping or touching blocks across accounts. Date.parse compares
// instants correctly even when different providers return different offsets.
export function combinedBusy(
	calendars: BusyCalendar[],
	range: { timeMin: string; timeMax: string },
): BusyCalendar[] {
	const min = Date.parse(range.timeMin),
		max = Date.parse(range.timeMax);
	const intervals = calendars
		.flatMap((cal) => cal.busy)
		.filter(
			(period) =>
				Date.parse(period.end) > min && Date.parse(period.start) < max,
		)
		.map((period) => ({
			start: Date.parse(period.start) < min ? range.timeMin : period.start,
			end: Date.parse(period.end) > max ? range.timeMax : period.end,
		}))
		.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
	const busy: TimeRange[] = [];
	for (const interval of intervals) {
		const prev = busy.at(-1);
		if (!prev || Date.parse(interval.start) > Date.parse(prev.end))
			busy.push({ ...interval });
		else if (Date.parse(interval.end) > Date.parse(prev.end))
			prev.end = interval.end;
	}
	return [{ calendarId: "combined", busy }];
}
