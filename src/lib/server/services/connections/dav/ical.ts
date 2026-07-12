// Provider-agnostic iCalendar (RFC 5545) + vCard (RFC 6350) toolkit (B3) —
// hand-rolled, no dependency, lifted verbatim out of providers/apple-caldav.ts.
// Only unfolds lines and extracts the handful of fields the calendar/tasks/
// contacts tools need; deliberately NOT a general-purpose iCal/vCard library.
// vCard reuses the iCal line-folding + "NAME;PARAM=VALUE:value" grammar as-is
// (RFC 6350 explicitly reuses RFC 5545 §3.1), so unfoldICalLines/
// parseICalProperty serve both.
import type { CalendarEvent } from "../providers/google-calendar";
import { CALDAV_NS, DAV_NS, firstNs, okPropOf, parseXml, textOf } from "./xml";

// RFC 5545 §3.1 line folding: a line that starts with a single space or tab is
// a continuation of the previous line (with that one leading whitespace
// character removed, NOT replaced — i.e. simple concatenation). Lines are
// terminated by CRLF, but a bare LF is tolerated.
export function unfoldICalLines(text: string): string[] {
	const rawLines = text.split(/\r\n|\r|\n/);
	const lines: string[] = [];
	for (const raw of rawLines) {
		if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
			lines[lines.length - 1] += raw.slice(1);
		} else {
			lines.push(raw);
		}
	}
	return lines;
}

// Reverses the RFC 5545 §3.3.11 TEXT escaping (\\, \;, \,, \N or \n) — only
// applied to free-text fields (SUMMARY/LOCATION/DESCRIPTION/FN), never to
// structured values like DTSTART.
function unescapeICalText(value: string): string {
	return value.replace(/\\(.)/g, (_match, ch: string) => {
		if (ch === "n" || ch === "N") return "\n";
		return ch;
	});
}

export type ICalProperty = {
	name: string;
	params: Record<string, string>;
	value: string;
};

// Splits a single unfolded content line ("NAME;PARAM=VALUE;...:value") into its
// property name, parameter map, and raw value. The split point is the FIRST
// unparametrized colon; everything before it (split on `;`) is the name
// followed by `PARAM=VALUE` pairs.
export function parseICalProperty(line: string): ICalProperty | null {
	const colonIndex = line.indexOf(":");
	if (colonIndex === -1) return null;
	const head = line.slice(0, colonIndex);
	const value = line.slice(colonIndex + 1);
	const [rawName, ...paramParts] = head.split(";");
	if (!rawName) return null;
	// RFC 6350 §3.3 (contentline = [group "."] name ...) lets a property carry a
	// leading group prefix — Apple Contacts labels grouped properties this way,
	// e.g. "item1.EMAIL;type=INTERNET:...". Strip that "group." prefix before
	// anything downstream compares the property name, or a labeled EMAIL/TEL
	// never matches its case arm. An iCalendar property name never contains a
	// '.', so this is a no-op for calendar data — only vCard grouping is
	// affected.
	const dotIndex = rawName.indexOf(".");
	const name = dotIndex === -1 ? rawName : rawName.slice(dotIndex + 1);
	if (!name) return null;
	const params: Record<string, string> = {};
	for (const part of paramParts) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
	}
	return { name: name.toUpperCase(), params, value };
}

// Maps a raw DTSTART/DTEND/DUE value to an ISO-ish string. All-day
// (`;VALUE=DATE:YYYYMMDD` or a bare 8-digit value) becomes `YYYY-MM-DD`; a
// timed value (`YYYYMMDDTHHMMSS[Z]`) becomes `YYYY-MM-DDTHH:MM:SS` plus a
// trailing `Z` iff the raw value itself ended in Z. A TZID param's offset is
// deliberately NOT resolved — "ISO-ish is fine" for what these read tools need.
export function parseICalTimestamp(prop: ICalProperty): string | null {
	const value = prop.value.trim();
	const isDateOnly = prop.params.VALUE === "DATE" || /^\d{8}$/.test(value);
	if (isDateOnly) {
		const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
		if (!match) return null;
		return `${match[1]}-${match[2]}-${match[3]}`;
	}
	const match = value.match(
		/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/,
	);
	if (!match) return null;
	const [, year, month, day, hour, minute, second, zone] = match;
	return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone ?? ""}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Parses an RFC 5545 §3.3.6 DURATION value (e.g. "PT1H", "P1D", "P1DT2H30M",
// "PT45M", "P2W", optionally sign-prefixed) into signed milliseconds. Returns
// null for anything it can't parse or a bare "P" with no components — the
// caller then falls back to the RFC default end rather than a bogus zero.
function parseICalDuration(value: string): number | null {
	const m = value
		.trim()
		.match(
			/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
		);
	if (!m) return null;
	const [, sign, w, d, h, mi, s] = m;
	if (
		w === undefined &&
		d === undefined &&
		h === undefined &&
		mi === undefined &&
		s === undefined
	) {
		return null;
	}
	const total =
		((((Number(w ?? 0) * 7 + Number(d ?? 0)) * 24 + Number(h ?? 0)) * 60 +
			Number(mi ?? 0)) *
			60 +
			Number(s ?? 0)) *
		1000;
	return (sign === "-" ? -1 : 1) * total;
}

// Shifts an already-parsed ISO-ish DTSTART string (from parseICalTimestamp) by
// `ms` milliseconds, preserving its shape: a date-only "YYYY-MM-DD" stays
// date-only; a timed value keeps its trailing "Z" iff the original had one.
// Arithmetic runs through Date.UTC purely so day/month/year rollover is correct
// and server-timezone-independent — NOT a timezone conversion, just wall-clock
// addition of the requested offset.
function shiftICalTimestamp(parsed: string, ms: number): string | null {
	const p2 = (n: number) => String(n).padStart(2, "0");
	const dateOnly = parsed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const at = new Date(
			Date.UTC(
				Number(dateOnly[1]),
				Number(dateOnly[2]) - 1,
				Number(dateOnly[3]),
			) + ms,
		);
		return `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}`;
	}
	const timed = parsed.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z)?$/,
	);
	if (timed) {
		const at = new Date(
			Date.UTC(
				Number(timed[1]),
				Number(timed[2]) - 1,
				Number(timed[3]),
				Number(timed[4]),
				Number(timed[5]),
				Number(timed[6]),
			) + ms,
		);
		return `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}T${p2(at.getUTCHours())}:${p2(at.getUTCMinutes())}:${p2(at.getUTCSeconds())}${timed[7] ?? ""}`;
	}
	return null;
}

export type ParsedICalEvent = {
	uid: string;
	summary?: string;
	location?: string;
	description?: string;
	dtstart: string;
	dtend: string;
	// Raw RRULE value (e.g. "FREQ=WEEKLY;..."), present iff this VEVENT block
	// carries one. Not parsed further — consumers only need "is this event
	// recurring at all", never the rule's actual frequency/interval.
	recurrenceRule?: string;
};

// Scans unfolded lines for BEGIN:VEVENT..END:VEVENT blocks and extracts the
// fields the calendar tool needs. A block missing UID or DTSTART is dropped
// rather than surfaced half-populated — but a block with DTSTART and no DTEND is
// NOT dropped: per RFC 5545 §3.6.1 an event's end is derived from DURATION when
// present, and otherwise defaults (VALUE=DATE start -> start + 1 day; a timed
// start -> zero duration, i.e. end == start).
export function parseICalEvents(icsText: string): ParsedICalEvent[] {
	const lines = unfoldICalLines(icsText);
	const events: ParsedICalEvent[] = [];

	let inEvent = false;
	let uid: string | undefined;
	let summary: string | undefined;
	let location: string | undefined;
	let description: string | undefined;
	let dtstart: string | undefined;
	let dtend: string | undefined;
	let duration: string | undefined;
	let recurrenceRule: string | undefined;

	for (const line of lines) {
		if (line === "BEGIN:VEVENT") {
			inEvent = true;
			uid = undefined;
			summary = undefined;
			location = undefined;
			description = undefined;
			dtstart = undefined;
			dtend = undefined;
			duration = undefined;
			recurrenceRule = undefined;
			continue;
		}
		if (line === "END:VEVENT") {
			if (inEvent && uid && dtstart) {
				let end = dtend;
				if (end === undefined && duration !== undefined) {
					const ms = parseICalDuration(duration);
					if (ms !== null) end = shiftICalTimestamp(dtstart, ms) ?? undefined;
				}
				if (end === undefined) {
					// RFC 5545 §3.6.1 defaults: an all-day (VALUE=DATE, so no "T")
					// event lasts one day; a timed event has zero duration.
					const dtstartDateOnly = !dtstart.includes("T");
					end = dtstartDateOnly
						? (shiftICalTimestamp(dtstart, ONE_DAY_MS) ?? dtstart)
						: dtstart;
				}
				events.push({
					uid,
					dtstart,
					dtend: end,
					...(summary !== undefined ? { summary } : {}),
					...(location !== undefined ? { location } : {}),
					...(description !== undefined ? { description } : {}),
					...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
				});
			}
			inEvent = false;
			continue;
		}
		if (!inEvent) continue;

		const prop = parseICalProperty(line);
		if (!prop) continue;
		switch (prop.name) {
			case "UID":
				uid = prop.value;
				break;
			case "SUMMARY":
				summary = unescapeICalText(prop.value);
				break;
			case "LOCATION":
				location = unescapeICalText(prop.value);
				break;
			case "DESCRIPTION":
				description = unescapeICalText(prop.value);
				break;
			case "RRULE":
				recurrenceRule = prop.value;
				break;
			case "DURATION":
				duration = prop.value.trim();
				break;
			case "DTSTART": {
				const parsed = parseICalTimestamp(prop);
				if (parsed) dtstart = parsed;
				break;
			}
			case "DTEND": {
				const parsed = parseICalTimestamp(prop);
				if (parsed) dtend = parsed;
				break;
			}
			default:
				break;
		}
	}

	return events;
}

export type ParsedVCard = {
	fn?: string;
	emails: string[];
	phones: string[];
};

// Scans unfolded lines for BEGIN:VCARD..END:VCARD blocks — deliberately
// mirroring parseICalEvents. Only extracts what the contacts resolver needs
// (FN, EMAIL, TEL).
export function parseVCards(vcardText: string): ParsedVCard[] {
	const lines = unfoldICalLines(vcardText);
	const cards: ParsedVCard[] = [];

	let inCard = false;
	let fn: string | undefined;
	let emails: string[] = [];
	let phones: string[] = [];

	for (const line of lines) {
		if (line === "BEGIN:VCARD") {
			inCard = true;
			fn = undefined;
			emails = [];
			phones = [];
			continue;
		}
		if (line === "END:VCARD") {
			if (inCard)
				cards.push({ ...(fn !== undefined ? { fn } : {}), emails, phones });
			inCard = false;
			continue;
		}
		if (!inCard) continue;

		const prop = parseICalProperty(line);
		if (!prop) continue;
		switch (prop.name) {
			case "FN":
				fn = unescapeICalText(prop.value);
				break;
			case "EMAIL": {
				const value = unescapeICalText(prop.value.trim());
				if (value) emails.push(value);
				break;
			}
			case "TEL": {
				const value = unescapeICalText(prop.value.trim());
				if (value) phones.push(value);
				break;
			}
			default:
				break;
		}
	}

	return cards;
}

// ---------------------------------------------------------------------------
// REPORT query-body builders + the calendar-query multistatus parser.
// ---------------------------------------------------------------------------

// CalDAV time-range filters use iCal's "basic" UTC form (no dashes/colons,
// always Z) regardless of what format the caller's ISO timestamp used.
function toICalUtcTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid timeMin/timeMax value: ${iso}`);
	}
	return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

export function calendarQueryBody(timeMin: string, timeMax: string): string {
	const start = toICalUtcTimestamp(timeMin);
	const end = toICalUtcTimestamp(timeMax);
	// The CALDAV:expand (RFC 4791 §9.6.5) inside calendar-data asks the server to
	// MATERIALIZE each recurrence instance that overlaps [start, end) as its own
	// single-occurrence VEVENT, instead of returning the recurring master
	// verbatim. Without it, a weekly series with a long-past DTSTART came back as
	// one VEVENT carrying that original (out-of-window) start, so the whole
	// in-window series collapsed to a single wrongly-dated entry. The expand
	// window MUST match the time-range filter below. This is read-side only — the
	// write path's UID lookup (uidQueryBody) deliberately does NOT expand.
	return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:getetag/>
		<c:calendar-data>
			<c:expand start="${start}" end="${end}"/>
		</c:calendar-data>
	</d:prop>
	<c:filter>
		<c:comp-filter name="VCALENDAR">
			<c:comp-filter name="VEVENT">
				<c:time-range start="${start}" end="${end}"/>
			</c:comp-filter>
		</c:comp-filter>
	</c:filter>
</c:calendar-query>`;
}

// Minimal XML-text escaping for interpolating a caller-supplied value (an
// eventId, ultimately model-controlled) into a REPORT request body — this is
// the one CalDAV request body built from untrusted input, so escaping here
// keeps it from breaking out of the <c:text-match> element (or injecting
// sibling filter elements) rather than merely failing to match.
function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function uidQueryBody(uid: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
	<d:prop>
		<d:getetag/>
		<c:calendar-data/>
	</d:prop>
	<c:filter>
		<c:comp-filter name="VCALENDAR">
			<c:comp-filter name="VEVENT">
				<c:prop-filter name="UID">
					<c:text-match collation="i;octet" match-type="equals">${escapeXmlText(uid)}</c:text-match>
				</c:prop-filter>
			</c:comp-filter>
		</c:comp-filter>
	</c:filter>
</c:calendar-query>`;
}

// PROPFIND body enumerating addressbook collections (resourcetype + name),
// used by the CardDAV discovery paths.
export const ADDRESSBOOK_COLLECTIONS_PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<d:resourcetype/>
		<d:displayname/>
	</d:prop>
</d:propfind>`;

// RFC 6352 §10.3 defines addressbook-query as
// `((allprop|propname|prop)?, filter, limit?)` — the CARDDAV:filter element is
// MANDATORY. Omitting it made a strict iCloud endpoint 400 the REPORT, which
// surfaced upstream as "no contacts". We match/rank client-side (CardDAV has no
// reliable cross-server free-text primitive), so this filter must select EVERY
// card: with the default `test="anyof"` (logical OR), a bare `prop-filter
// name="UID"` matches any card that HAS a UID and the `is-not-defined` arm
// matches any card that does NOT — together a tautology, i.e. all cards.
export const ADDRESSBOOK_QUERY_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
	<d:prop>
		<d:getetag/>
		<card:address-data/>
	</d:prop>
	<card:filter test="anyof">
		<card:prop-filter name="UID"/>
		<card:prop-filter name="UID">
			<card:is-not-defined/>
		</card:prop-filter>
	</card:filter>
</card:addressbook-query>`;

// Parses a calendar-query REPORT multistatus response into CalendarEvent[] —
// the XML shape is standard CalDAV, not provider-specific. `rawIcs` captures the
// exact `calendar-data` text verbatim (for the write path's preserve-and-patch
// update), NOT a re-serialization of the parsed fields.
export function parseReportMultistatus(
	xml: string,
	finalUrl: string,
): CalendarEvent[] {
	const doc = parseXml(xml);
	const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));

	const events: CalendarEvent[] = [];
	for (const responseEl of responses) {
		const href = textOf(firstNs(responseEl, DAV_NS, "href"));
		if (!href) continue;
		const prop = okPropOf(responseEl);
		if (!prop) continue;

		const etag = textOf(firstNs(prop, DAV_NS, "getetag")) ?? undefined;
		const calendarData = textOf(firstNs(prop, CALDAV_NS, "calendar-data"));
		if (!calendarData) continue;

		const absoluteHref = new URL(href, finalUrl).toString();
		for (const parsed of parseICalEvents(calendarData)) {
			events.push({
				id: parsed.uid,
				summary: parsed.summary ?? "",
				start: parsed.dtstart,
				end: parsed.dtend,
				...(parsed.location ? { location: parsed.location } : {}),
				...(parsed.description ? { description: parsed.description } : {}),
				htmlLink: absoluteHref,
				...(etag ? { etag } : {}),
				rawIcs: calendarData,
				...(parsed.recurrenceRule
					? { recurrence: [parsed.recurrenceRule] }
					: {}),
			});
		}
	}
	return events;
}
