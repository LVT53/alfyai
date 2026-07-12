// Toolkit-level tests for the provider-agnostic WebDAV/CalDAV/CardDAV +
// iCal/vCard module (B3). These cover the XML multistatus parsing / propstat
// selection, the redirect-following PROPFIND/REPORT transport (expect-207) and
// its non-207 write-capable sibling, and the RFC 5545/6350 iCal/vCard parsers
// and query-body builders — all lifted out of providers/apple-caldav.ts, which
// used to double as the de-facto shared DAV library. Provider-specific
// behavior (iCloud discovery, needs_reauth flagging, connection storage) stays
// in the provider suites.
import { describe, expect, it, vi } from "vitest";
import {
	caldavRequest,
	caldavWriteRequest,
	calendarQueryBody,
	DAV_NS,
	DavError,
	firstNs,
	okPropOf,
	parseICalEvents,
	parseICalProperty,
	parseICalTimestamp,
	parseReportMultistatus,
	parseVCards,
	parseXml,
	textOf,
	uidQueryBody,
	unfoldICalLines,
} from "./index";

function xmlResponse(status: number, xml: string): Response {
	return new Response(xml, {
		status,
		headers: { "Content-Type": "application/xml" },
	});
}

function redirectResponse(status: number, location: string): Response {
	return new Response("", { status, headers: { Location: location } });
}

// ---------------------------------------------------------------------------
// XML layer: parseXml / textOf / firstNs / okPropOf
// ---------------------------------------------------------------------------

describe("okPropOf (propstat-200 selection)", () => {
	it("selects the propstat with a 200 status even when a 404 propstat precedes it", () => {
		const doc = parseXml(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/x/</d:href>
		<d:propstat>
			<d:prop><d:getcontenttype/></d:prop>
			<d:status>HTTP/1.1 404 Not Found</d:status>
		</d:propstat>
		<d:propstat>
			<d:prop><d:displayname>Home</d:displayname></d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`);
		const responseEl = firstNs(doc, DAV_NS, "response");
		expect(responseEl).not.toBeNull();
		const prop = okPropOf(responseEl as Element);
		expect(prop).not.toBeNull();
		expect(textOf(firstNs(prop as Element, DAV_NS, "displayname"))).toBe(
			"Home",
		);
	});

	it("falls back to the first propstat when none is explicitly 200", () => {
		const doc = parseXml(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
	<d:response>
		<d:href>/x/</d:href>
		<d:propstat>
			<d:prop><d:displayname>Only</d:displayname></d:prop>
			<d:status>HTTP/1.1 207 Multi-Status</d:status>
		</d:propstat>
	</d:response>
</d:multistatus>`);
		const responseEl = firstNs(doc, DAV_NS, "response") as Element;
		const prop = okPropOf(responseEl);
		expect(textOf(firstNs(prop as Element, DAV_NS, "displayname"))).toBe(
			"Only",
		);
	});
});

describe("textOf", () => {
	it("trims and returns null for empty/whitespace-only text", () => {
		const doc = parseXml(`<r xmlns="DAV:"><a>  hi  </a><b>   </b></r>`);
		expect(textOf(firstNs(doc, DAV_NS, "a"))).toBe("hi");
		expect(textOf(firstNs(doc, DAV_NS, "b"))).toBeNull();
		expect(textOf(null)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Transport: caldavRequest (read, expect-207, redirect-following)
// ---------------------------------------------------------------------------

describe("caldavRequest", () => {
	const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href></d:response></d:multistatus>`;

	it("follows a 3xx redirect, re-sending the same method/body/auth at the new Location, and returns the 207 body + finalUrl", async () => {
		const calls: { url: string; method?: string; auth: string | null }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				calls.push({
					url,
					method: init?.method,
					auth: headers.get("Authorization"),
				});
				if (url === "https://caldav.example.com/start") {
					return redirectResponse(301, "https://p1.example.com/start");
				}
				return xmlResponse(207, MULTISTATUS);
			},
		);

		const { xml, finalUrl } = await caldavRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/start",
			"Basic abc",
			"PROPFIND",
			"0",
			"<body/>",
		);

		expect(xml).toContain("multistatus");
		expect(finalUrl).toBe("https://p1.example.com/start");
		expect(calls).toEqual([
			{
				url: "https://caldav.example.com/start",
				method: "PROPFIND",
				auth: "Basic abc",
			},
			{
				url: "https://p1.example.com/start",
				method: "PROPFIND",
				auth: "Basic abc",
			},
		]);
	});

	it("throws a DavError(invalid_credentials) on 401, using the caller's credentialsRejectedMessage without leaking the auth", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
		const promise = caldavRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/",
			"Basic secret",
			"PROPFIND",
			"0",
			"<body/>",
			{ credentialsRejectedMessage: "The server rejected the credentials" },
		);
		await expect(promise).rejects.toBeInstanceOf(DavError);
		await expect(promise).rejects.toMatchObject({
			code: "invalid_credentials",
		});
		await expect(promise).rejects.toThrow(
			"The server rejected the credentials",
		);
	});

	it("throws a DavError(request_failed) when the final status is not 207", async () => {
		const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
		const promise = caldavRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/",
			"Basic abc",
			"REPORT",
			"1",
			"<body/>",
		);
		await expect(promise).rejects.toBeInstanceOf(DavError);
		await expect(promise).rejects.toMatchObject({ code: "request_failed" });
	});

	it("routes its 401/error branding through an injected makeError factory", async () => {
		class MyError extends Error {
			constructor(
				message: string,
				public readonly code: string,
			) {
				super(message);
			}
		}
		const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
		const promise = caldavRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/",
			"Basic abc",
			"PROPFIND",
			"0",
			"<body/>",
			{ makeError: (m, c) => new MyError(m, c) },
		);
		await expect(promise).rejects.toBeInstanceOf(MyError);
		await expect(promise).rejects.toMatchObject({
			code: "invalid_credentials",
		});
	});
});

// ---------------------------------------------------------------------------
// Transport: caldavWriteRequest (write, NON-207, redirect-following)
// ---------------------------------------------------------------------------

describe("caldavWriteRequest", () => {
	it("returns the Response on a non-207 success (201) without throwing", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("If-None-Match")).toBe("*");
				return new Response(null, { status: 201, headers: { ETag: '"e"' } });
			},
		);
		const response = await caldavWriteRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/evt.ics",
			"Basic abc",
			"PUT",
			{ name: "If-None-Match", value: "*" },
			"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("ETag")).toBe('"e"');
	});

	it("returns a 412 Response (conflict) without throwing — the caller decides what it means", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 412 }));
		const response = await caldavWriteRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/evt.ics",
			"Basic abc",
			"PUT",
			{ name: "If-Match", value: '"etag-1"' },
			"BODY",
		);
		expect(response.status).toBe(412);
	});

	it("returns a 404/410 DELETE Response without throwing", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
		const response = await caldavWriteRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/evt.ics",
			"Basic abc",
			"DELETE",
			{ name: "If-Match", value: '"etag-1"' },
		);
		expect(response.status).toBe(404);
	});

	it("follows a 3xx redirect, re-sending the SAME conditional header at the new Location", async () => {
		const calls: { url: string; ifMatch: string | null }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				calls.push({
					url: String(input),
					ifMatch: headers.get("If-Match"),
				});
				if (calls.length === 1) {
					return redirectResponse(302, "https://p2.example.com/evt.ics");
				}
				return new Response(null, { status: 204 });
			},
		);
		const response = await caldavWriteRequest(
			fetchMock as unknown as typeof fetch,
			"https://caldav.example.com/evt.ics",
			"Basic abc",
			"DELETE",
			{ name: "If-Match", value: '"etag-1"' },
		);
		expect(response.status).toBe(204);
		expect(calls).toEqual([
			{ url: "https://caldav.example.com/evt.ics", ifMatch: '"etag-1"' },
			{ url: "https://p2.example.com/evt.ics", ifMatch: '"etag-1"' },
		]);
	});

	it("throws when a redirect is missing a Location header", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 302 }));
		await expect(
			caldavWriteRequest(
				fetchMock as unknown as typeof fetch,
				"https://caldav.example.com/evt.ics",
				"Basic abc",
				"PUT",
				{ name: "If-None-Match", value: "*" },
				"BODY",
			),
		).rejects.toBeInstanceOf(Error);
	});
});

// ---------------------------------------------------------------------------
// iCal line unfolding + property parsing + timestamps
// ---------------------------------------------------------------------------

describe("unfoldICalLines", () => {
	it("joins continuation lines (leading space or tab) onto the previous line", () => {
		const text = ["FN:This is a long na", " me that wraps", "\ttoo"].join(
			"\r\n",
		);
		expect(unfoldICalLines(text)).toEqual([
			"FN:This is a long name that wrapstoo",
		]);
	});

	it("tolerates bare LF as a line terminator", () => {
		expect(unfoldICalLines("A:1\nB:2")).toEqual(["A:1", "B:2"]);
	});
});

describe("parseICalProperty", () => {
	it("splits NAME;PARAM=VALUE:value into name/params/value", () => {
		const prop = parseICalProperty(
			"DTSTART;TZID=America/New_York:20260709T090000",
		);
		expect(prop).toEqual({
			name: "DTSTART",
			params: { TZID: "America/New_York" },
			value: "20260709T090000",
		});
	});

	it("strips an RFC 6350 group prefix (item1.EMAIL -> EMAIL)", () => {
		const prop = parseICalProperty("item1.EMAIL;type=INTERNET:jane@work.com");
		expect(prop?.name).toBe("EMAIL");
		expect(prop?.value).toBe("jane@work.com");
	});

	it("returns null for a line with no colon", () => {
		expect(parseICalProperty("BEGIN")).toBeNull();
	});
});

describe("parseICalTimestamp", () => {
	it("maps an all-day VALUE=DATE to YYYY-MM-DD", () => {
		const prop = parseICalProperty("DTSTART;VALUE=DATE:20260710");
		expect(prop).not.toBeNull();
		expect(parseICalTimestamp(prop as NonNullable<typeof prop>)).toBe(
			"2026-07-10",
		);
	});

	it("preserves the trailing Z of a UTC timed value", () => {
		const prop = parseICalProperty("DTSTART:20260709T130000Z");
		expect(parseICalTimestamp(prop as NonNullable<typeof prop>)).toBe(
			"2026-07-09T13:00:00Z",
		);
	});

	it("returns null for an unparseable value", () => {
		const prop = parseICalProperty("DTSTART:not-a-date");
		expect(parseICalTimestamp(prop as NonNullable<typeof prop>)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseICalEvents (VEVENT)
// ---------------------------------------------------------------------------

describe("parseICalEvents", () => {
	it("unfolds a folded SUMMARY line per RFC 5545", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:evt-fold@icloud.com",
			"SUMMARY:This is a very long summary that wraps",
			"  across a continuation line",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		const events = parseICalEvents(ics);
		expect(events).toHaveLength(1);
		expect(events[0]?.summary).toBe(
			"This is a very long summary that wraps across a continuation line",
		);
	});

	it("parses an all-day event distinctly from a timed event", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:allday@icloud.com",
			"SUMMARY:Holiday",
			"DTSTART;VALUE=DATE:20260710",
			"DTEND;VALUE=DATE:20260711",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)).toEqual([
			expect.objectContaining({
				uid: "allday@icloud.com",
				summary: "Holiday",
				dtstart: "2026-07-10",
				dtend: "2026-07-11",
			}),
		]);
	});

	it("handles missing optional fields (no LOCATION, no SUMMARY)", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:bare@icloud.com",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		const events = parseICalEvents(ics);
		expect(events[0]?.summary).toBeUndefined();
		expect(events[0]?.location).toBeUndefined();
	});

	it("captures DESCRIPTION, unescaping RFC 5545 TEXT escapes", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:desc@icloud.com",
			"SUMMARY:Standup",
			"DESCRIPTION:Line one\\nLine two\\, with a comma\\; and a semicolon",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)[0]?.description).toBe(
			"Line one\nLine two, with a comma; and a semicolon",
		);
	});

	it("computes DTEND from DURATION when DTEND is absent", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:dur@icloud.com",
			"DTSTART:20260709T090000Z",
			"DURATION:PT1H30M",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)).toEqual([
			expect.objectContaining({
				uid: "dur@icloud.com",
				dtstart: "2026-07-09T09:00:00Z",
				dtend: "2026-07-09T10:30:00Z",
			}),
		]);
	});

	it("a timed DTSTART with neither DTEND nor DURATION defaults to zero duration", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:nodtend@icloud.com",
			"DTSTART:20260709T090000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)).toEqual([
			expect.objectContaining({
				uid: "nodtend@icloud.com",
				dtstart: "2026-07-09T09:00:00Z",
				dtend: "2026-07-09T09:00:00Z",
			}),
		]);
	});

	it("an all-day DTSTART with neither DTEND nor DURATION defaults to a one-day event", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:allday-nodtend@icloud.com",
			"DTSTART;VALUE=DATE:20260731",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)).toEqual([
			expect.objectContaining({
				uid: "allday-nodtend@icloud.com",
				dtstart: "2026-07-31",
				dtend: "2026-08-01",
			}),
		]);
	});

	it("captures a bare RRULE presence as recurrenceRule", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:recur@icloud.com",
			"SUMMARY:Standup",
			"RRULE:FREQ=WEEKLY;BYDAY=MO",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)[0]?.recurrenceRule).toBe(
			"FREQ=WEEKLY;BYDAY=MO",
		);
	});

	it("a VEVENT with no RRULE leaves recurrenceRule undefined", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:non-recur@icloud.com",
			"DTSTART:20260709T090000Z",
			"DTEND:20260709T093000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		expect(parseICalEvents(ics)[0]?.recurrenceRule).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// parseVCards (vCard)
// ---------------------------------------------------------------------------

describe("parseVCards", () => {
	it("unfolds a folded FN line and collects multiple EMAIL/TEL", () => {
		const vcard = [
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:This is a very long display na",
			" me that wraps",
			"EMAIL:ann@example.com",
			"EMAIL:ann.work@example.com",
			"TEL:+1-555-1000",
			"TEL:+1-555-2000",
			"END:VCARD",
			"",
		].join("\r\n");
		expect(parseVCards(vcard)).toEqual([
			{
				fn: "This is a very long display name that wraps",
				emails: ["ann@example.com", "ann.work@example.com"],
				phones: ["+1-555-1000", "+1-555-2000"],
			},
		]);
	});

	it("handles a vCard with no TEL", () => {
		const vcard = [
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:Bob Smith",
			"EMAIL:bob@example.com",
			"END:VCARD",
			"",
		].join("\r\n");
		expect(parseVCards(vcard)).toEqual([
			{ fn: "Bob Smith", emails: ["bob@example.com"], phones: [] },
		]);
	});

	it("strips an RFC 6350 group prefix so grouped item1.EMAIL / item2.TEL are collected", () => {
		const vcard = [
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:Jane Work",
			"item1.EMAIL;type=INTERNET:jane@work.com",
			"item1.X-ABLabel:Work",
			"item2.TEL:+1-555-9000",
			"item2.X-ABLabel:Mobile",
			"END:VCARD",
			"",
		].join("\r\n");
		expect(parseVCards(vcard)).toEqual([
			{ fn: "Jane Work", emails: ["jane@work.com"], phones: ["+1-555-9000"] },
		]);
	});

	it("parses multiple VCARDs in one address-data blob", () => {
		const vcard = [
			"BEGIN:VCARD",
			"FN:Ann",
			"EMAIL:ann@example.com",
			"END:VCARD",
			"BEGIN:VCARD",
			"FN:Bob",
			"EMAIL:bob@example.com",
			"END:VCARD",
			"",
		].join("\r\n");
		expect(parseVCards(vcard)).toEqual([
			{ fn: "Ann", emails: ["ann@example.com"], phones: [] },
			{ fn: "Bob", emails: ["bob@example.com"], phones: [] },
		]);
	});
});

// ---------------------------------------------------------------------------
// Query bodies + parseReportMultistatus
// ---------------------------------------------------------------------------

describe("calendarQueryBody", () => {
	it("emits a C:expand window matching the time-range filter (both UTC basic form)", () => {
		const body = calendarQueryBody(
			"2026-07-08T00:00:00.000Z",
			"2026-07-20T00:00:00.000Z",
		);
		expect(body).toContain("expand");
		expect(body).toContain('start="20260708T000000Z"');
		expect(body).toContain('end="20260720T000000Z"');
	});
});

describe("uidQueryBody", () => {
	it("XML-escapes a UID with special characters and never emits a time-range", () => {
		const body = uidQueryBody(`x"]]></c:text-match>&`);
		expect(body).not.toContain('"]]>');
		expect(body).toContain("&quot;");
		expect(body).toContain("&amp;");
		expect(body).not.toContain("time-range");
		expect(body).toContain("prop-filter");
	});
});

describe("parseReportMultistatus", () => {
	function report(entries: { href: string; etag: string; ics: string }[]) {
		const responses = entries
			.map(
				(entry) => `
	<d:response>
		<d:href>${entry.href}</d:href>
		<d:propstat>
			<d:prop>
				<d:getetag>${entry.etag}</d:getetag>
				<c:calendar-data>${entry.ics
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;")}</c:calendar-data>
			</d:prop>
			<d:status>HTTP/1.1 200 OK</d:status>
		</d:propstat>
	</d:response>`,
			)
			.join("");
		return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}
</d:multistatus>`;
	}

	it("maps a REPORT multistatus into CalendarEvents, resolving hrefs against finalUrl and capturing etag + rawIcs", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:evt-1@icloud.com",
			"SUMMARY:Team sync",
			"DTSTART:20260709T130000Z",
			"DTEND:20260709T133000Z",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		const events = parseReportMultistatus(
			report([{ href: "/cal/evt-1.ics", etag: '"etag-1"', ics }]),
			"https://p1.example.com/cal/",
		);
		expect(events).toEqual([
			expect.objectContaining({
				id: "evt-1@icloud.com",
				summary: "Team sync",
				start: "2026-07-09T13:00:00Z",
				end: "2026-07-09T13:30:00Z",
				htmlLink: "https://p1.example.com/cal/evt-1.ics",
				etag: '"etag-1"',
			}),
		]);
		expect(events[0]?.rawIcs).toContain("BEGIN:VEVENT");
	});
});
