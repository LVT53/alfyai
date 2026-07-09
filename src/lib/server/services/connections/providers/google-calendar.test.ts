import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateConnection } from "../store";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";
import {
	GoogleCalendarError,
	googleFreeBusy,
	googleListCalendars,
	googleListEvents,
} from "./google-calendar";

vi.mock("./google", async () => {
	const actual = await vi.importActual<typeof import("./google")>("./google");
	return {
		...actual,
		googleRefreshAccessToken: vi.fn(),
	};
});
vi.mock("../store", () => ({
	updateConnection: vi.fn(),
}));

const googleRefreshAccessTokenMock = vi.mocked(googleRefreshAccessToken);
const updateConnectionMock = vi.mocked(updateConnection);

const USER_ID = "user-1";
const CONNECTION_ID = "conn-1";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	googleRefreshAccessTokenMock.mockReset();
	updateConnectionMock.mockReset();
	googleRefreshAccessTokenMock.mockResolvedValue("fresh-access-token");
});

describe("googleListCalendars", () => {
	it("parses calendar list items into {id, summary, primary}", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toContain(
					"https://www.googleapis.com/calendar/v3/users/me/calendarList",
				);
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer fresh-access-token",
				);
				return jsonResponse(200, {
					items: [
						{ id: "primary", summary: "Alice", primary: true },
						{ id: "team@group.calendar.google.com", summary: "Team" },
					],
				});
			},
		);

		const calendars = await googleListCalendars(USER_ID, CONNECTION_ID, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(calendars).toEqual([
			{ id: "primary", summary: "Alice", primary: true },
			{ id: "team@group.calendar.google.com", summary: "Team" },
		]);
	});
});

describe("googleListEvents", () => {
	it("parses timed events (dateTime) into CalendarEvent", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
			expect(url.searchParams.get("singleEvents")).toBe("true");
			expect(url.searchParams.get("orderBy")).toBe("startTime");
			expect(url.searchParams.get("timeMin")).toBe("2026-07-08T00:00:00.000Z");
			expect(url.searchParams.get("timeMax")).toBe("2026-07-15T00:00:00.000Z");
			return jsonResponse(200, {
				items: [
					{
						id: "evt-1",
						summary: "Standup",
						start: { dateTime: "2026-07-09T09:00:00-04:00" },
						end: { dateTime: "2026-07-09T09:30:00-04:00" },
						location: "Zoom",
						htmlLink: "https://calendar.google.com/event?eid=evt-1",
					},
				],
			});
		});

		const events = await googleListEvents(
			USER_ID,
			CONNECTION_ID,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(events).toEqual([
			{
				id: "evt-1",
				summary: "Standup",
				start: "2026-07-09T09:00:00-04:00",
				end: "2026-07-09T09:30:00-04:00",
				location: "Zoom",
				htmlLink: "https://calendar.google.com/event?eid=evt-1",
			},
		]);
	});

	it("parses all-day events (date) into CalendarEvent", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(200, {
				items: [
					{
						id: "evt-2",
						summary: "Company Holiday",
						start: { date: "2026-07-10" },
						end: { date: "2026-07-11" },
						htmlLink: "https://calendar.google.com/event?eid=evt-2",
					},
				],
			}),
		);

		const events = await googleListEvents(
			USER_ID,
			CONNECTION_ID,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(events).toEqual([
			{
				id: "evt-2",
				summary: "Company Holiday",
				start: "2026-07-10",
				end: "2026-07-11",
				htmlLink: "https://calendar.google.com/event?eid=evt-2",
			},
		]);
	});

	it("a post-refresh 401 throws a typed needs_reauth error and flags the connection", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { error: "invalid" }),
		);

		const promise = googleListEvents(
			USER_ID,
			CONNECTION_ID,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(GoogleCalendarError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });

		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
	});

	it("a refresh failure (needs_reauth) is surfaced as a typed GoogleCalendarError without ever calling fetch", async () => {
		googleRefreshAccessTokenMock.mockRejectedValue(
			new GoogleOAuthError(
				"No refresh token stored for this Google connection",
				"needs_reauth",
			),
		);
		const fetchMock = vi.fn();

		const promise = googleListEvents(
			USER_ID,
			CONNECTION_ID,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(GoogleCalendarError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("googleFreeBusy", () => {
	it("parses busy intervals per calendar", async () => {
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://www.googleapis.com/calendar/v3/freeBusy",
				);
				expect(init?.method).toBe("POST");
				const body = JSON.parse(String(init?.body));
				expect(body).toEqual({
					timeMin: "2026-07-08T00:00:00.000Z",
					timeMax: "2026-07-15T00:00:00.000Z",
					items: [{ id: "primary" }],
				});
				return jsonResponse(200, {
					calendars: {
						primary: {
							busy: [
								{
									start: "2026-07-09T09:00:00Z",
									end: "2026-07-09T09:30:00Z",
								},
							],
						},
					},
				});
			},
		);

		const result = await googleFreeBusy(
			USER_ID,
			CONNECTION_ID,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual([
			{
				calendarId: "primary",
				busy: [{ start: "2026-07-09T09:00:00Z", end: "2026-07-09T09:30:00Z" }],
			},
		]);
	});

	it("a post-refresh 401 throws a typed needs_reauth error and flags the connection", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { error: "invalid" }),
		);

		const promise = googleFreeBusy(
			USER_ID,
			CONNECTION_ID,
			{
				timeMin: "2026-07-08T00:00:00.000Z",
				timeMax: "2026-07-15T00:00:00.000Z",
			},
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		await expect(promise).rejects.toBeInstanceOf(GoogleCalendarError);
		await expect(promise).rejects.toMatchObject({ code: "needs_reauth" });

		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
	});
});
