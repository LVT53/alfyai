import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateConnection } from "../store";
import { getWriteExecutor } from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";
import { GoogleOAuthError, googleRefreshAccessToken } from "./google";

// Issue 6.1 — the google write-executor: the ONLY code path allowed to issue
// a mutating request against Google Calendar. Importing this module runs its
// top-level registerWriteExecutor({ provider: "google", ... }) side effect
// (Issue 6.0's registry), exactly the way pending-writes.ts relies on it in
// production. Every test below dispatches through getWriteExecutor("google")
// rather than calling any internal function directly, so these tests double
// as proof the registration actually happens.
import "./google-calendar-write";

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

function makeCreateOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "google",
		connectionId: CONNECTION_ID,
		action: "calendar.create_event",
		summary: 'Create "Standup" on your Google Calendar',
		reversible: true,
		destructive: false,
		target: { label: "Standup" },
		payloadFingerprint: JSON.stringify({
			calendarId: "primary",
			summary: "Standup",
			start: "2026-07-10T09:00:00-04:00",
			end: "2026-07-10T09:30:00-04:00",
		}),
		...overrides,
	};
}

function makeUpdateOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "google",
		connectionId: CONNECTION_ID,
		action: "calendar.update_event",
		summary: 'Update "Standup" on your Google Calendar',
		reversible: true,
		destructive: true,
		target: { id: "evt-1", label: "Standup" },
		...overrides,
	};
}

function makeDeleteOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "google",
		connectionId: CONNECTION_ID,
		action: "calendar.delete_event",
		summary: 'Delete "Standup" from your Google Calendar',
		reversible: true,
		destructive: true,
		target: { id: "evt-1", label: "Standup" },
		...overrides,
	};
}

function expectedClientEventId(op: WriteOperation): string {
	// Mirrors googleEventIdForOp's own derivation (base32hex of sha256 of the
	// op's idempotencyKey) so tests assert the ACTUAL contract — "derived
	// deterministically from the idempotencyKey" — rather than importing the
	// executor's internal helper and trivially asserting it equals itself.
	const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
	const hash = createHash("sha256").update(idempotencyKey(op)).digest();
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of hash) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32HEX[(value >>> (bits - 5)) & 0x1f];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 0x1f];
	return out;
}

beforeEach(() => {
	googleRefreshAccessTokenMock.mockReset();
	updateConnectionMock.mockReset();
	googleRefreshAccessTokenMock.mockResolvedValue("fresh-access-token");
});

function executor() {
	const exec = getWriteExecutor("google");
	if (!exec) throw new Error('No "google" write executor registered');
	return exec;
}

describe("google write-executor — registration (Issue 6.0/6.1)", () => {
	it('is registered under provider "google" purely from importing the module', () => {
		expect(getWriteExecutor("google")).toBeDefined();
	});
});

describe("google write-executor — calendar.create_event", () => {
	it("POSTs with a client-supplied id derived from the idempotencyKey, and returns the etag on success", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00-04:00",
				end: "2026-07-10T09:30:00-04:00",
				location: "Zoom",
			},
		});
		const clientId = expectedClientEventId(op);

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://www.googleapis.com/calendar/v3/calendars/primary/events",
				);
				expect(init?.method).toBe("POST");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer fresh-access-token",
				);
				const body = JSON.parse(String(init?.body));
				expect(body).toEqual({
					id: clientId,
					summary: "Standup",
					location: "Zoom",
					start: { dateTime: "2026-07-10T09:00:00-04:00" },
					end: { dateTime: "2026-07-10T09:30:00-04:00" },
				});
				return jsonResponse(200, { etag: '"etag-created"' });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			ok: true,
			etag: '"etag-created"',
			detail: "created",
		});
	});

	it("treats an all-day event's YYYY-MM-DD start/end as {date: ...} not {dateTime: ...}", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			event: { summary: "Holiday", start: "2026-07-10", end: "2026-07-11" },
		});

		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body.start).toEqual({ date: "2026-07-10" });
			expect(body.end).toEqual({ date: "2026-07-11" });
			return jsonResponse(200, {});
		});

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result.ok).toBe(true);
	});

	it("a 409 (duplicate client id) is treated as idempotent SUCCESS, not an error — no double-create", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00-04:00",
				end: "2026-07-10T09:30:00-04:00",
			},
		});
		const fetchMock = vi.fn(async () =>
			jsonResponse(409, {
				error: { message: "The requested identifier already exists." },
			}),
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ ok: true, detail: "already created" });
	});

	it("re-confirming the SAME create (same idempotencyKey) issues the same client event id both times", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00-04:00",
				end: "2026-07-10T09:30:00-04:00",
			},
		});
		const seenIds: string[] = [];
		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			seenIds.push(body.id);
			return seenIds.length === 1
				? jsonResponse(200, { etag: '"e1"' })
				: jsonResponse(409, { error: "duplicate" });
		});

		const first = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		const second = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: true, detail: "already created" });
		expect(seenIds[0]).toBe(seenIds[1]);
	});

	it("a post-refresh 401 flags the connection needs_reauth and returns {ok:false, reason:'needs_reauth'}", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});
		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { error: "invalid" }),
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
	});

	it("a refresh failure (needs_reauth before any write attempt) never issues a fetch call", async () => {
		googleRefreshAccessTokenMock.mockRejectedValue(
			new GoogleOAuthError("No refresh token stored", "needs_reauth"),
		);
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});
		const fetchMock = vi.fn();

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("malformed content (not valid JSON, or missing calendarId) is refused as unsupported_operation without ever calling fetch", async () => {
		const op = makeCreateOp();
		const fetchMock = vi.fn();

		const malformedJson = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			"{not json",
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(malformedJson).toEqual({
			ok: false,
			reason: "unsupported_operation",
		});

		const missingCalendarId = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ event: { summary: "x" } }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(missingCalendarId).toEqual({
			ok: false,
			reason: "unsupported_operation",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("google write-executor — calendar.update_event", () => {
	it("scope 'this_event' on a genuine instance: GETs first to confirm the id isn't the series master, then PATCHes that SAME id with only the changed fields", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-1",
			event: { location: "New Room" },
			recurringScope: "this_event",
		});

		const calls: { method: string; url: string }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({ method, url: String(input) });
				if (method === "GET") {
					// A genuine instance: recurringEventId points at its master, and
					// it carries no `recurrence` of its own.
					return jsonResponse(200, {
						id: "evt-1",
						recurringEventId: "evt-1-master",
					});
				}
				expect(JSON.parse(String(init?.body))).toEqual({
					location: "New Room",
				});
				return jsonResponse(200, { etag: '"e2"' });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(calls).toEqual([
			{
				method: "GET",
				url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
			},
			{
				method: "PATCH",
				url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
			},
		]);
		expect(result).toEqual({ ok: true, etag: '"e2"', detail: "event updated" });
	});

	it("no recurringScope at all: PATCHes the given eventId directly with no GET (non-recurring targets never reach the executor with a scope)", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-1",
			event: { location: "New Room" },
		});

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
				);
				expect(init?.method).toBe("PATCH");
				expect(JSON.parse(String(init?.body))).toEqual({
					location: "New Room",
				});
				return jsonResponse(200, { etag: '"e2"' });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ ok: true, etag: '"e2"', detail: "event updated" });
	});

	it("scope 'this_event' where the given eventId is actually the series MASTER (carries `recurrence`): refuses without ever PATCHing, so a \"this event only\" request can never clobber the whole series", async () => {
		const op = makeUpdateOp({ target: { id: "evt-master", label: "Standup" } });
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-master",
			event: { location: "New Room" },
			recurringScope: "this_event",
		});

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.method ?? "GET").toBe("GET");
				return jsonResponse(200, {
					id: "evt-master",
					recurrence: ["RRULE:FREQ=WEEKLY"],
				});
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({
			ok: false,
			reason: "recurring_instance_ambiguous",
		});
		// Only the GET happened — no PATCH was ever issued against the master.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("scope 'series': resolves the instance's recurringEventId via GET first, then PATCHes the MASTER id — never the instance id", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-1-instance",
			event: { location: "New Room" },
			recurringScope: "series",
		});

		const calls: { method: string; url: string }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({ method, url: String(input) });
				if (method === "GET") {
					return jsonResponse(200, {
						id: "evt-1-instance",
						recurringEventId: "evt-1-master",
					});
				}
				expect(String(input)).toBe(
					"https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1-master",
				);
				return jsonResponse(200, { etag: '"e3"' });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(calls).toEqual([
			{
				method: "GET",
				url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1-instance",
			},
			{
				method: "PATCH",
				url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1-master",
			},
		]);
		expect(result).toEqual({
			ok: true,
			etag: '"e3"',
			detail: "series updated",
		});
	});

	it("scope 'series' where the fetched event has no recurringEventId (it's already the master) patches that id as-is", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-master",
			event: { location: "New Room" },
			recurringScope: "series",
		});

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PATCH") {
					expect(String(input)).toContain("/events/evt-master");
					return jsonResponse(200, {});
				}
				return jsonResponse(200, { id: "evt-master" });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result.ok).toBe(true);
	});

	it("a post-refresh 401 on the PATCH flags needs_reauth", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-1",
			event: { location: "New Room" },
		});
		const fetchMock = vi.fn(async () =>
			jsonResponse(403, { error: "forbidden" }),
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
	});

	it("missing eventId in content is refused without calling fetch", async () => {
		const op = makeUpdateOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ calendarId: "primary", event: { location: "x" } }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "missing_event_id" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("google write-executor — calendar.delete_event", () => {
	it("DELETEs the given eventId and succeeds on 204", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({ calendarId: "primary", eventId: "evt-1" });

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
				);
				expect(init?.method).toBe("DELETE");
				return new Response(null, { status: 204 });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result).toEqual({ ok: true, detail: "deleted" });
	});

	it("a 410 (already gone) is treated as idempotent SUCCESS", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({ calendarId: "primary", eventId: "evt-1" });
		const fetchMock = vi.fn(async () => new Response(null, { status: 410 }));

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result).toEqual({ ok: true, detail: "already deleted" });
	});

	it("scope 'series' resolves the master id via GET before DELETEing", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-1-instance",
			recurringScope: "series",
		});

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "DELETE") {
					expect(String(input)).toContain("/events/evt-1-master");
					return new Response(null, { status: 204 });
				}
				return jsonResponse(200, { recurringEventId: "evt-1-master" });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result).toEqual({ ok: true, detail: "deleted" });
	});

	it("scope 'this_event' where the given eventId is actually the series MASTER (carries `recurrence`): refuses without ever DELETEing, so a \"this event only\" request can never destroy the whole series", async () => {
		const op = makeDeleteOp({ target: { id: "evt-master", label: "Standup" } });
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-master",
			recurringScope: "this_event",
		});

		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.method ?? "GET").toBe("GET");
				return jsonResponse(200, {
					id: "evt-master",
					recurrence: ["RRULE:FREQ=WEEKLY"],
				});
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({
			ok: false,
			reason: "recurring_instance_ambiguous",
		});
		// Only the GET happened — no DELETE was ever issued against the master.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("scope 'this_event' on a genuine instance: GETs first to confirm the id isn't the series master, then DELETEs that SAME id", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			calendarId: "primary",
			eventId: "evt-1",
			recurringScope: "this_event",
		});

		const calls: { method: string; url: string }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({ method, url: String(input) });
				if (method === "GET") {
					return jsonResponse(200, {
						id: "evt-1",
						recurringEventId: "evt-1-master",
					});
				}
				return new Response(null, { status: 204 });
			},
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(calls).toEqual([
			{
				method: "GET",
				url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
			},
			{
				method: "DELETE",
				url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
			},
		]);
		expect(result).toEqual({ ok: true, detail: "deleted" });
	});

	it("a post-refresh 401 on the DELETE flags needs_reauth", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({ calendarId: "primary", eventId: "evt-1" });
		const fetchMock = vi.fn(async () =>
			jsonResponse(401, { error: "invalid" }),
		);

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(updateConnectionMock).toHaveBeenCalledWith(
			USER_ID,
			CONNECTION_ID,
			expect.objectContaining({ status: "needs_reauth" }),
		);
	});

	it("missing eventId in content is refused without calling fetch", async () => {
		const op = makeDeleteOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ calendarId: "primary" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "missing_event_id" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("google write-executor — unsupported action", () => {
	it("an op.action this executor doesn't recognize is refused as unsupported_operation", async () => {
		const op: WriteOperation = {
			provider: "google",
			connectionId: CONNECTION_ID,
			action: "files.put",
			summary: "n/a",
			reversible: true,
			destructive: false,
		};
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ calendarId: "primary" }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
