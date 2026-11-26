import {
	basicAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "../provider-http";
import { type ConnectionPublic, getConnectionSecret } from "../store";
import {
	parseICalDuration,
	parseICalProperty,
	parseICalTimestamp,
	toICalUtcTimestamp,
	unfoldICalLines,
} from "./ical";

function invalidReport(): never {
	throw new ConnectionHttpError(
		"The calendar server returned an incomplete free/busy report",
		"request_failed",
	);
}

function utcInstant(value: string): number {
	if (!/^\d{8}T\d{6}Z$/.test(value)) return invalidReport();
	const iso = parseICalTimestamp({ name: "FREEBUSY", params: {}, value });
	if (!iso || !Number.isFinite(Date.parse(iso))) return invalidReport();
	return Date.parse(iso);
}

// RFC 4791 §7.10 asks the server to expand recurrences and compute busy time
// in UTC. Only periods are returned; event titles and attendees stay upstream.
function readPeriods(
	text: string,
	requestedStart: string,
	requestedEnd: string,
) {
	const lines = unfoldICalLines(text.trim());
	if (lines[0] !== "BEGIN:VCALENDAR" || lines.at(-1) !== "END:VCALENDAR")
		return invalidReport();
	const periods: { start: string; end: string }[] = [];
	let blocks = 0;
	let inside = false;
	for (const line of lines) {
		if (line === "BEGIN:VFREEBUSY") {
			if (inside) return invalidReport();
			inside = true;
			blocks++;
			continue;
		}
		if (line === "END:VFREEBUSY") {
			if (!inside) return invalidReport();
			inside = false;
			continue;
		}
		if (!inside) continue;
		const prop = parseICalProperty(line);
		if (!prop) return invalidReport();
		if (
			prop.name === "DTSTART" &&
			utcInstant(prop.value) > Date.parse(requestedStart)
		)
			return invalidReport();
		if (
			prop.name === "DTEND" &&
			utcInstant(prop.value) < Date.parse(requestedEnd)
		)
			return invalidReport();
		if (
			prop.name !== "FREEBUSY" ||
			prop.params.FBTYPE?.toUpperCase() === "FREE"
		)
			continue;
		for (const period of prop.value.split(",")) {
			const [from, until, extra] = period.split("/");
			if (!until || extra !== undefined) return invalidReport();
			const start = utcInstant(from);
			const duration = parseICalDuration(until);
			const end = duration === null ? utcInstant(until) : start + duration;
			if (!(start < end)) return invalidReport();
			periods.push({
				start: new Date(start).toISOString(),
				end: new Date(end).toISOString(),
			});
		}
	}
	if (!blocks || inside) return invalidReport();
	return periods;
}

export async function davFreeBusy(
	conn: ConnectionPublic,
	range: { timeMin: string; timeMax: string; calendarId?: string },
	fetchImpl: typeof fetch = fetch,
) {
	const login =
		conn.provider === "apple" ? conn.config.appleId : conn.config.username;
	const user = typeof login === "string" ? login : conn.accountIdentifier;
	const stored = conn.config.calendarUrls;
	if (
		!user ||
		!Array.isArray(stored) ||
		!stored.length ||
		!stored.every((url): url is string => typeof url === "string" && !!url)
	) {
		throw new ConnectionHttpError(
			"Calendar discovery is incomplete",
			"invalid_config",
		);
	}
	// Only discovered URLs may receive the account's credential.
	const urls = range.calendarId
		? stored.filter((url) => url === range.calendarId)
		: stored;
	if (!urls.length)
		throw new ConnectionHttpError(
			"Calendar ID was not discovered for this account",
			"not_found",
		);
	const secret = await getConnectionSecret(conn.userId, conn.id);
	if (!secret)
		throw new ConnectionHttpError(
			"Missing calendar credential",
			"needs_reauth",
		);
	const start = toICalUtcTimestamp(range.timeMin);
	const end = toICalUtcTimestamp(
		new Date(Math.ceil(Date.parse(range.timeMax) / 1000) * 1000).toISOString(),
	);
	const body = `<c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${start}" end="${end}"/></c:free-busy-query>`;
	const results = [];
	for (const url of urls) {
		const res = await providerFetch(url, {
			method: "REPORT",
			redirect: "error",
			headers: {
				Authorization: basicAuthHeader(user, secret),
				Depth: "1",
				"Content-Type": "application/xml; charset=utf-8",
				Accept: "text/calendar",
			},
			body,
			fetch: fetchImpl,
		});
		if (res.status === 401)
			throw new ConnectionHttpError(
				"Calendar credential was rejected",
				"needs_reauth",
			);
		if (res.status !== 200)
			throw new ConnectionHttpError(
				"Calendar free/busy report failed",
				"request_failed",
			);
		results.push({
			calendarId: url,
			busy: readPeriods(await res.text(), range.timeMin, range.timeMax),
		});
	}
	return results;
}
