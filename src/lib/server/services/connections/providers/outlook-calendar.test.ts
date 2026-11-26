import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { onedriveGetAccessTokenForRead } from "./onedrive";
import {
	outlookBusyIntervals,
	outlookListCalendars,
	outlookListEvents,
} from "./outlook-calendar";

vi.mock("./onedrive", async (importOriginal) => ({
	...(await importOriginal<typeof import("./onedrive")>()),
	onedriveGetAccessTokenForRead: vi.fn(),
}));
const conn: ConnectionPublic = {
	id: "conn",
	userId: "person",
	provider: "onedrive",
	label: "Work",
	accountIdentifier: "me@example.test",
	status: "connected",
	statusDetail: null,
	defaultOn: true,
	allowWrites: false,
	writeAllowlist: [],
	capabilities: ["calendar"],
	config: {},
	oauthScopes: ["Calendars.ReadBasic"],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 0,
	updatedAt: 0,
};
const range = {
	timeMin: "2026-06-01T00:00:00Z",
	timeMax: "2026-06-02T00:00:00Z",
};
const event = {
	id: "instance-1",
	subject: "Weekly planning",
	start: { dateTime: "2026-06-01T10:00:00.0000000", timeZone: "UTC" },
	end: { dateTime: "2026-06-01T11:00:00.0000000", timeZone: "UTC" },
	location: { displayName: "Room 1" },
	webLink: "https://outlook.office.com/calendar/item/1",
	showAs: "busy",
	isCancelled: false,
};
const interval = {
	start: "2026-06-01T10:00:00.000Z",
	end: "2026-06-01T11:00:00.000Z",
};
function pages(...results: unknown[]) {
	const fetcher = vi.fn<typeof fetch>();
	for (const page of results)
		fetcher.mockResolvedValueOnce(Response.json(page));
	return fetcher;
}
const next =
	"https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=page2";

describe("Outlook Calendar", () => {
	beforeEach(() => {
		vi.mocked(onedriveGetAccessTokenForRead)
			.mockReset()
			.mockResolvedValue("example-token");
	});
	it("reads the occurrence window in UTC and follows pagination until enough matching events are found", async () => {
		const fetch = pages(
			{
				value: [
					{ ...event, isCancelled: true },
					{ ...event, subject: "Unrelated" },
				],
				"@odata.nextLink": next,
			},
			{ value: [event], "@odata.nextLink": "https://unused.invalid" },
		);
		const events = await outlookListEvents(
			conn,
			{ ...range, query: "PLAN", maxResults: 1 },
			{ fetch },
		);
		expect(events).toEqual([
			{
				id: event.id,
				summary: event.subject,
				...interval,
				location: "Room 1",
				htmlLink: event.webLink,
			},
		]);
		expect(onedriveGetAccessTokenForRead).toHaveBeenCalledTimes(1);
		expect(onedriveGetAccessTokenForRead).toHaveBeenCalledWith(
			conn,
			{ fetch },
			"calendar",
		);
		const [first, init] = fetch.mock.calls[0];
		const url = new URL(String(first));
		expect(url.pathname).toBe("/v1.0/me/calendarView");
		expect(url.searchParams.get("startDateTime")).toBe(range.timeMin);
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("Prefer")).toContain(
			'outlook.timezone="UTC"',
		);
		expect(fetch.mock.calls).toHaveLength(2);
	});
	it("uses a specific calendar, or the default for primary", async () => {
		const fetch = pages({ value: [] }, { value: [] });
		for (const calendarId of ["specific/id", "primary"])
			await outlookListEvents(
				conn,
				{ ...range, maxResults: 4, calendarId },
				{ fetch },
			);
		expect(
			fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
		).toEqual([
			"/v1.0/me/calendars/specific%2Fid/calendarView",
			"/v1.0/me/calendarView",
		]);
	});
	it("reads all pages for availability, skips free, working elsewhere and cancelled events and requests no titles", async () => {
		const fetch = pages(
			{
				value: [
					{ ...event, showAs: "free" },
					{ ...event, showAs: "workingElsewhere" },
					{ ...event, isCancelled: true },
				],
				"@odata.nextLink": next,
			},
			{ value: [{ ...event, showAs: "tentative" }] },
		);
		expect(await outlookBusyIntervals(conn, range, { fetch })).toEqual([
			interval,
		]);
		expect(
			new URL(String(fetch.mock.calls[0][0])).searchParams.get("$select"),
		).not.toContain("subject");
	});
	it.each([
		"https://other.test/v1.0/me/calendarView",
		"https://graph.microsoft.com/v1.0/me/messages",
		"https://other@graph.microsoft.com/v1.0/me/calendarView",
	])(
		"rejects an out-of-scope continuation without another fetch",
		async (link) => {
			const fetch = pages({ value: [], "@odata.nextLink": link });
			await expect(
				outlookBusyIntervals(conn, range, { fetch }),
			).rejects.toThrow();
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("refuses a malformed or incomplete calendar response instead of reporting available", async () => {
		for (const page of [
			{},
			{ value: [{ ...event, start: null }] },
			{
				value: [
					{
						...event,
						start: {
							dateTime: "2026-06-01T12:34:56",
							timeZone: "Europe/Budapest",
						},
					},
				],
			},
		]) {
			await expect(
				outlookBusyIntervals(conn, range, { fetch: pages(page) }),
			).rejects.toThrow();
		}
		await expect(
			outlookBusyIntervals(conn, range, {
				fetch: pages(
					{ value: [], "@odata.nextLink": next },
					{ value: [], "@odata.nextLink": next },
				),
			}),
		).rejects.toThrow();
	});
	it("uses the attendee's explicit decline even if Outlook leaves showAs busy", async () => {
		const fetch = pages({
			value: [{ ...event, responseStatus: { response: "declined" } }],
		});
		expect(await outlookBusyIntervals(conn, range, { fetch })).toEqual([]);
		expect(
			new URL(String(fetch.mock.calls[0][0])).searchParams.get("$select"),
		).toContain("responseStatus");
	});
	it("accepts Graph's differently cased resource name without changing the calendar ID or mailbox", async () => {
		const prefix = "https://graph.microsoft.com/v1.0";
		const fetch = pages(
			{
				value: [],
				"@odata.nextLink": `${prefix}/users/some-id/Calendars/AbC/calendarview?$skip=50`,
			},
			{ value: [event] },
		);
		expect(
			await outlookBusyIntervals(
				conn,
				{ ...range, calendarId: "AbC" },
				{ fetch },
			),
		).toEqual([interval]);
		expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe(
			"/v1.0/me/calendars/AbC/calendarView",
		);
		const bad = pages({
			value: [],
			"@odata.nextLink": `${prefix}/me/calendars/abc/calendarView?$skip=1`,
		});
		await expect(
			outlookBusyIntervals(
				conn,
				{ ...range, calendarId: "AbC" },
				{ fetch: bad },
			),
		).rejects.toThrow();
		expect(bad).toHaveBeenCalledTimes(1);
	});
	it("rejects a truncated schedule instead of returning the partial intervals", async () => {
		const fetch = pages(
			...Array.from({ length: 10 }, (_, index) => ({
				value: [event],
				"@odata.nextLink": next + index,
			})),
		);
		await expect(
			outlookBusyIntervals(conn, range, { fetch }),
		).rejects.toMatchObject({ code: "too_large" });
		expect(fetch).toHaveBeenCalledTimes(10);
	});
	it("lists calendar ids and identifies the default", async () => {
		const fetch = pages({
			value: [
				{ id: "a", name: "Home", isDefaultCalendar: true },
				{ id: "b", name: "Holidays", isDefaultCalendar: false },
			],
		});
		expect(await outlookListCalendars(conn, { fetch })).toEqual([
			{ id: "a", summary: "Home", primary: true },
			{ id: "b", summary: "Holidays" },
		]);
	});
});
