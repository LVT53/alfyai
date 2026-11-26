import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { getConnection } from "../store";
import type { WriteOperation } from "../write-guard";
import {
	executeOutlookCalendarWrite,
	outlookGetEvent,
} from "./outlook-calendar-writes";
import {
	outlookMailCount,
	outlookMailList,
	outlookMailMetadata,
	outlookReadMail,
} from "./outlook-mail";
import { executeOutlookMailWrite } from "./outlook-mail-writes";

vi.mock("../store", () => ({ getConnection: vi.fn() }));
vi.mock("./onedrive", async (importActual) => ({
	...(await importActual<typeof import("./onedrive")>()),
	onedriveGetAccessTokenForRead: vi.fn().mockResolvedValue("test-token"),
}));
const conn = {
	id: "acct",
	userId: "user",
	provider: "onedrive",
	status: "connected",
	allowWrites: true,
	capabilities: ["email", "calendar"],
	oauthScopes: ["Calendars.ReadWrite", "Mail.ReadWrite", "Mail.Send"],
} as ConnectionPublic;
const op = (action: string): WriteOperation => ({
	provider: "onedrive",
	connectionId: "acct",
	action,
	target: { id: "item", label: "Item" },
	summary: "Test",
	destructive: false,
	reversible: true,
});
const json = (value: unknown) => Response.json(value);
const message = {
	id: "opaque+id",
	subject: "Hello",
	from: { emailAddress: { address: "a@example.com", name: "Anna" } },
	receivedDateTime: "2026-12-01T12:00:00Z",
	isRead: false,
	bodyPreview: "Preview",
};
const fetch = vi.fn<typeof globalThis.fetch>();
beforeEach(() => {
	vi.clearAllMocks();
	fetch.mockReset();
	vi.mocked(getConnection).mockResolvedValue(conn);
});
describe("Outlook mail", () => {
	it("lists headers with opaque message IDs and reads text without changing read status", async () => {
		fetch
			.mockResolvedValueOnce(json({ value: [message] }))
			.mockResolvedValueOnce(
				json({
					...message,
					body: { contentType: "text", content: "full text" },
					hasAttachments: false,
				}),
			);
		expect((await outlookMailList(conn, {}, { fetch }))[0]).toMatchObject({
			uid: "opaque+id",
			seen: false,
			subject: "Hello",
		});
		expect(
			(await outlookReadMail(conn, "opaque+id", undefined, { fetch })).text,
		).toBe("full text");
		expect(
			fetch.mock.calls.every(
				([, init]) => !init?.method || init.method === "GET",
			),
		).toBe(true);
	});
	it("uses mailbox counts without scanning messages", async () => {
		fetch.mockResolvedValueOnce(json({ "@odata.count": 17, value: [] }));
		expect(await outlookMailCount(conn, { unseenOnly: true }, { fetch })).toBe(
			17,
		);
		const query = new URL(String(fetch.mock.calls[0][0]));
		expect(query.pathname).toMatch(/messages$/);
		expect(query.searchParams.get("$filter")).toBe("isRead eq false");
		expect(query.searchParams.get("$count")).toBe("true");
	});
	it("moves to Deleted Items and refuses send when only Mail.ReadWrite was granted", async () => {
		fetch.mockResolvedValueOnce(json({ id: "moved" }));
		expect(
			(
				await executeOutlookMailWrite(
					"user",
					"acct",
					op("email.trash"),
					JSON.stringify({ uid: "item" }),
					{ fetch },
				)
			).ok,
		).toBe(true);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
			destinationId: "deleteditems",
		});
		vi.mocked(getConnection).mockResolvedValue({
			...conn,
			oauthScopes: ["Mail.ReadWrite"],
		});
		expect(
			(
				await executeOutlookMailWrite(
					"user",
					"acct",
					op("email.send"),
					JSON.stringify({ to: "a@example.com", subject: "Hi", body: "text" }),
					{ fetch },
				)
			).ok,
		).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
describe("Outlook calendar writes", () => {
	it("creates only in the selected calendar, normalizing offset-aware times and binding retries", async () => {
		fetch.mockResolvedValueOnce(json({ id: "new" }));
		const result = await executeOutlookCalendarWrite(
			"user",
			"acct",
			op("calendar.create_event"),
			JSON.stringify({
				calendarId: "shared/calendar",
				event: {
					summary: "Call",
					start: "2026-12-01T15:00:00+02:00",
					end: "2026-12-01T16:00:00+02:00",
				},
			}),
			{ fetch },
		);
		expect(result.ok).toBe(true);
		expect(String(fetch.mock.calls[0][0])).toContain(
			"/me/calendars/shared%2Fcalendar/events",
		);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
			subject: "Call",
			start: { dateTime: "2026-12-01T13:00:00.000", timeZone: "UTC" },
			transactionId: expect.any(String),
		});
	});
});

describe("Outlook account and mutation boundaries", () => {
	it("previews a message version without fetching its body or attachment bytes", async () => {
		fetch.mockResolvedValueOnce(
			json({ ...message, isDraft: true, "@odata.etag": "v1" }),
		);
		expect(
			await outlookMailMetadata(conn, "opaque+id", undefined, { fetch }),
		).toMatchObject({ etag: "v1", isDraft: true });
		expect(
			new URL(String(fetch.mock.calls[0][0])).searchParams
				.get("$select")
				?.split(","),
		).not.toContain("body");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("follows an Outlook folder alias continuation using only its query on the original account", async () => {
		fetch
			.mockResolvedValueOnce(
				json({
					value: [message],
					"@odata.nextLink":
						"https://graph.microsoft.com/v1.0/users/tenant-user/mailFolders/resolvedID/messages?$skip=1",
				}),
			)
			.mockResolvedValueOnce(json({ value: [{ ...message, id: "second" }] }));
		expect(
			(await outlookMailList(conn, { folder: "Inbox" }, { fetch })).map(
				(m) => m.uid,
			),
		).toEqual([message.id, "second"]);
		expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe(
			"/v1.0/me/mailFolders/inbox/messages",
		);
	});
	it("never follows an external continuation or reports a partial count", async () => {
		fetch.mockResolvedValueOnce(
			json({
				value: [message],
				"@odata.nextLink": "https://external.example/not-graph?$skip=1",
			}),
		);
		await expect(
			outlookMailCount(conn, { subject: "Hello" }, { fetch }),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([
		["seen", false, { isRead: false }],
		["flagged", true, { flag: { flagStatus: "flagged" } }],
	] as const)(
		"patches the selected %s flag without changing other properties",
		async (flag, value, expected) => {
			fetch.mockResolvedValueOnce(json({}));
			expect(
				(
					await executeOutlookMailWrite(
						"user",
						"acct",
						op("email.flag"),
						JSON.stringify({ uid: "item", flag, value }),
						{ fetch },
					)
				).ok,
			).toBe(true);
			expect(fetch.mock.calls[0][1]?.method).toBe("PATCH");
			expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(
				expected,
			);
		},
	);
	it("does not edit a draft with a changed version or send it", async () => {
		fetch.mockResolvedValueOnce(new Response(null, { status: 412 }));
		const result = await executeOutlookMailWrite(
			"user",
			"acct",
			op("email.edit_draft"),
			JSON.stringify({
				uid: "item",
				to: "a@example.com",
				subject: "New",
				body: "Text",
				etag: "old",
			}),
			{ fetch },
		);
		expect(result.ok).toBe(false);
		expect(new Headers(fetch.mock.calls[0][1]?.headers).get("If-Match")).toBe(
			"old",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("sends a threaded reply with the explicitly approved recipients and a separate Mail.Send permission", async () => {
		fetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
		const result = await executeOutlookMailWrite(
			"user",
			"acct",
			{ ...op("email.send"), target: { id: "original", label: "Reply" } },
			JSON.stringify({
				uid: "original",
				to: "a@example.com",
				cc: "b@example.com",
				subject: "Re: Hello",
				body: "Text",
			}),
			{ fetch },
		);
		expect(result.ok).toBe(true);
		expect(String(fetch.mock.calls[0][0])).toContain(
			"/me/messages/original/reply",
		);
		const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
		expect(sent.message.toRecipients).toEqual([
			{ emailAddress: { address: "a@example.com" } },
		]);
		expect(sent.message.ccRecipients).toEqual([
			{ emailAddress: { address: "b@example.com" } },
		]);
	});
	it("does not delete a newer event revision", async () => {
		fetch.mockResolvedValueOnce(new Response(null, { status: 412 }));
		const result = await executeOutlookCalendarWrite(
			"user",
			"acct",
			op("calendar.delete_event"),
			JSON.stringify({ eventId: "item", calendarId: "primary", etag: "old" }),
			{ fetch },
		);
		expect(result.ok).toBe(false);
		expect(new Headers(fetch.mock.calls[0][1]?.headers).get("If-Match")).toBe(
			"old",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it("reads meeting cancellation distribution without returning attendee addresses", async () => {
	const event = {
		id: "item",
		subject: "Meeting",
		start: { dateTime: "2026-11-30T09:00:00", timeZone: "UTC" },
		end: { dateTime: "2026-11-30T10:00:00", timeZone: "UTC" },
		type: "singleInstance",
		isAllDay: false,
		isOrganizer: true,
		isOnlineMeeting: true,
		attendees: [{ emailAddress: { address: "private@example.com" } }],
		"@odata.etag": "v1",
	};
	fetch
		.mockResolvedValueOnce(json(event))
		.mockResolvedValueOnce(json({ ...event, isOrganizer: false }));
	const organizer = await outlookGetEvent(conn, "primary", "item", { fetch });
	expect(organizer).toMatchObject({
		isOnlineMeeting: true,
		cancellationRecipients: 1,
	});
	expect(JSON.stringify(organizer)).not.toContain("private@example");
	expect(
		(await outlookGetEvent(conn, "primary", "item", { fetch }))
			?.cancellationRecipients,
	).toBe(0);
});
it("rejects a stored description edit unless the checked revision was an offline event", async () => {
	const result = await executeOutlookCalendarWrite(
		"user",
		"acct",
		op("calendar.update_event"),
		JSON.stringify({
			eventId: "item",
			calendarId: "primary",
			etag: "v1",
			isOnlineMeeting: true,
			event: { description: "Agenda" },
		}),
		{ fetch },
	);
	expect(result).toMatchObject({ ok: false });
	expect(fetch).not.toHaveBeenCalled();
});
describe("Outlook civil dates", () => {
	it("creates an all-day event from local midnight to local midnight across a daylight saving change", async () => {
		fetch.mockResolvedValueOnce(json({ id: "n" }));
		const result = await executeOutlookCalendarWrite(
			"user",
			"acct",
			op("calendar.create_event"),
			JSON.stringify({
				calendarId: "primary",
				event: {
					summary: "Away",
					start: "2027-03-27",
					end: "2027-03-30",
					timeZone: "Europe/Dublin",
				},
			}),
			{ fetch },
		);
		expect(result.ok).toBe(true);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
			isAllDay: true,
			start: { dateTime: "2027-03-27T00:00:00", timeZone: "Europe/Dublin" },
			end: { dateTime: "2027-03-30T00:00:00", timeZone: "Europe/Dublin" },
		});
	});
});

it("saves a subject-only draft edit without replacing recipients or body", async () => {
	fetch.mockResolvedValueOnce(json({ id: "item" }));
	const result = await executeOutlookMailWrite(
		"user",
		"acct",
		op("email.edit_draft"),
		JSON.stringify({ uid: "item", subject: "Revised", etag: "version" }),
		{ fetch },
	);
	expect(result.ok).toBe(true);
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
		subject: "Revised",
	});
});

describe("sending the saved Outlook draft in place", () => {
	const draft = {
		id: "item",
		isDraft: true,
		"@odata.etag": "v1",
		subject: "Quarterly",
		toRecipients: [{ emailAddress: { address: "a@example.com" } }],
		ccRecipients: [],
		bccRecipients: [{ emailAddress: { address: "b@example.com" } }],
		body: { contentType: "text", content: "Hello" },
	};
	const approved = {
		uid: "item",
		etag: "v1",
		to: "a@example.com",
		cc: "",
		bcc: "b@example.com",
		subject: "Quarterly",
		body: "Hello",
		attachments: [],
	};
	it("checks the stored draft and its recipients, then submits its immutable ID once", async () => {
		fetch
			.mockResolvedValueOnce(json(draft))
			.mockResolvedValueOnce(json({ value: [] }))
			.mockResolvedValueOnce(new Response(null, { status: 202 }));
		expect(
			await executeOutlookMailWrite(
				"user",
				"acct",
				op("email.send_draft"),
				JSON.stringify(approved),
				{ fetch },
			),
		).toMatchObject({ ok: true });
		const posts = fetch.mock.calls.filter(
			([, init]) => init?.method === "POST",
		);
		expect(posts).toHaveLength(1);
		expect(String(posts[0][0])).toMatch(/\/me\/messages\/item\/send$/);
		expect(posts[0][1]?.body).toBeUndefined();
		expect(new Headers(posts[0][1]?.headers).get("If-Match")).toBe("v1");
	});
	it.each([
		{ ...draft, "@odata.etag": "v2" },
		{ ...draft, isDraft: false },
		{ ...draft, bccRecipients: [] },
	])(
		"refuses a different revision, already-sent draft, or changed Bcc",
		async (row) => {
			fetch
				.mockResolvedValueOnce(json(row))
				.mockResolvedValueOnce(json({ value: [] }));
			expect(
				(
					await executeOutlookMailWrite(
						"user",
						"acct",
						op("email.send_draft"),
						JSON.stringify(approved),
						{ fetch },
					)
				).ok,
			).toBe(false);
			expect(
				fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
			).toHaveLength(0);
		},
	);
});

it("reports an uncertain Outlook send without repeating the POST", async () => {
	fetch.mockRejectedValueOnce(new TypeError("Connection closed"));
	const result = await executeOutlookMailWrite(
		"user",
		"acct",
		op("email.send"),
		JSON.stringify({ to: "a@example.com", subject: "Hi", body: "Hello" }),
		{ fetch },
	);
	expect(result).toMatchObject({
		ok: false,
		reason: "may_not_have_gone_through",
	});
	expect(fetch).toHaveBeenCalledTimes(1);
});
