import { appleListEvents } from "./providers/apple-caldav";
import { caldavListEvents } from "./providers/caldav-tasks";
import { googleListEvents } from "./providers/google-calendar";
import { outlookListEvents } from "./providers/outlook-calendar";
import type { ConnectionPublic } from "./store";

export async function listConnectionEvents(
	userId: string,
	conn: ConnectionPublic,
	options: {
		timeMin: string;
		timeMax: string;
		maxResults: number;
		query?: string;
		calendarId?: string;
	},
) {
	const { timeMin, timeMax, maxResults, query, calendarId } = options;
	switch (conn.provider) {
		case "apple":
		case "caldav": {
			const list =
				conn.provider === "apple" ? appleListEvents : caldavListEvents;
			const events = await list(userId, conn.id, { timeMin, timeMax });
			return events.slice(0, maxResults);
		}
		case "onedrive":
			return outlookListEvents(conn, options);
		case "google":
			return googleListEvents(userId, conn.id, {
				timeMin,
				timeMax,
				maxResults,
				q: query,
				...(calendarId ? { calendarId } : {}),
			});
		default:
			throw new Error("Connection does not support calendar event lookup");
	}
}
