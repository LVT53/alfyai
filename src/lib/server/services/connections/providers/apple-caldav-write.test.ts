import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ConnectionPublic,
	getConnection,
	getConnectionSecret,
	updateConnection,
} from "../store";
import { getWriteExecutor } from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";

// Issue 6.2 — the apple write-executor: the ONLY code path allowed to issue
// a mutating request against Apple iCloud Calendar. Importing this module
// runs its top-level registerWriteExecutor({ provider: "apple", ... }) side
// effect (Issue 6.0's registry), exactly the way pending-writes.ts relies on
// it in production. Every test below dispatches through
// getWriteExecutor("apple") rather than calling any internal function
// directly, so these tests double as proof the registration actually
// happens.
import "./apple-caldav-write";

vi.mock("../store", () => ({
	getConnection: vi.fn(),
	getConnectionSecret: vi.fn(),
	updateConnection: vi.fn(),
}));

const getConnectionMock = vi.mocked(getConnection);
const getConnectionSecretMock = vi.mocked(getConnectionSecret);
const updateConnectionMock = vi.mocked(updateConnection);

const USER_ID = "user-1";
const CONNECTION_ID = "conn-1";
const CALENDAR_URL = "https://p12-caldav.icloud.com/12345/calendars/home/";

function makeConnection(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return {
		id: CONNECTION_ID,
		userId: USER_ID,
		provider: "apple",
		label: "Apple iCloud",
		accountIdentifier: "alice@icloud.com",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: true,
		writeAllowlist: [],
		capabilities: ["calendar"],
		config: { appleId: "alice@icloud.com", calendarUrls: [CALENDAR_URL] },
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeCreateOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "apple",
		connectionId: CONNECTION_ID,
		action: "calendar.create_event",
		summary: 'Create "Standup" on your Apple iCloud Calendar',
		reversible: false,
		destructive: false,
		target: { label: "Standup" },
		payloadFingerprint: JSON.stringify({
			calendarUrl: CALENDAR_URL,
			summary: "Standup",
			start: "2026-07-10T09:00:00Z",
			end: "2026-07-10T09:30:00Z",
		}),
		...overrides,
	};
}

function makeUpdateOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "apple",
		connectionId: CONNECTION_ID,
		action: "calendar.update_event",
		summary: 'Update "Standup" on your Apple iCloud Calendar',
		reversible: false,
		destructive: true,
		target: { id: "evt-1@icloud.com", label: "Standup" },
		...overrides,
	};
}

// A representative "original" resource text for the update tests below —
// mirrors what appleGetEventByUid/parseReportMultistatus's raw calendar-data
// would hand back for a pre-existing, non-recurring event. `extraLines` lets
// individual tests append properties/sub-components (ATTENDEE, VALARM,
// RRULE, X-*) to prove they survive an update untouched (the corruption-
// safety fix's whole point — see patchVevent's doc comment).
const ORIGINAL_UID = "evt-1@icloud.com";
function makeOriginalIcs(extraLines: string[] = []): string {
	return `${[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Apple Inc.//Mac OS X 10.15//EN",
		"BEGIN:VEVENT",
		`UID:${ORIGINAL_UID}`,
		"DTSTAMP:20260701T120000Z",
		"SUMMARY:Standup",
		"DTSTART:20260710T090000Z",
		"DTEND:20260710T093000Z",
		"LOCATION:Room A",
		...extraLines,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n")}\r\n`;
}

function makeDeleteOp(overrides: Partial<WriteOperation> = {}): WriteOperation {
	return {
		provider: "apple",
		connectionId: CONNECTION_ID,
		action: "calendar.delete_event",
		summary: 'Delete "Standup" from your Apple iCloud Calendar',
		reversible: false,
		destructive: true,
		target: { id: "evt-1@icloud.com", label: "Standup" },
		...overrides,
	};
}

function expectedUid(op: WriteOperation): string {
	// Mirrors appleEventUidForOp's own derivation so tests assert the ACTUAL
	// contract — "derived deterministically from the idempotencyKey" — rather
	// than importing the executor's internal helper and trivially asserting
	// it equals itself.
	const hash = createHash("sha256").update(idempotencyKey(op)).digest("hex");
	return `${hash}@alfyai.app`;
}

beforeEach(() => {
	getConnectionMock.mockReset();
	getConnectionSecretMock.mockReset();
	updateConnectionMock.mockReset();
	getConnectionMock.mockResolvedValue(makeConnection());
	getConnectionSecretMock.mockResolvedValue("app-specific-pw");
});

function executor() {
	const exec = getWriteExecutor("apple");
	if (!exec) throw new Error('No "apple" write executor registered');
	return exec;
}

describe("apple write-executor — registration (Issue 6.0/6.2)", () => {
	it('is registered under provider "apple" purely from importing the module', () => {
		expect(getWriteExecutor("apple")).toBeDefined();
	});
});

describe("apple write-executor — calendar.create_event", () => {
	it("PUTs a well-formed VEVENT ICS with If-None-Match: * to a UID derived from the idempotencyKey, and returns the etag on success", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
				location: "Zoom",
			},
		});
		const uid = expectedUid(op);

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(`${CALENDAR_URL}${uid}.ics`);
				expect(init?.method).toBe("PUT");
				const headers = new Headers(init?.headers);
				expect(headers.get("If-None-Match")).toBe("*");
				expect(headers.get("If-Match")).toBeNull();
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from("alice@icloud.com:app-specific-pw").toString("base64")}`,
				);
				const body = String(init?.body);
				// The 64-hex-char UID line itself exceeds 75 octets and is folded —
				// unfold (strip "\r\n " continuations) before asserting its exact
				// value, the same way a real CalDAV client/server would read it back.
				const unfolded = body.replace(/\r\n /g, "");
				expect(unfolded).toContain(`UID:${uid}`);
				expect(body).toContain("SUMMARY:Standup");
				expect(body).toContain("LOCATION:Zoom");
				expect(body).toContain("DTSTART:20260710T090000Z");
				expect(body).toContain("DTEND:20260710T093000Z");
				expect(body).toContain("BEGIN:VCALENDAR");
				expect(body).toContain("BEGIN:VEVENT");
				expect(body).toContain("DTSTAMP:");
				return new Response(null, {
					status: 201,
					headers: { ETag: '"etag-created"' },
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

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			ok: true,
			etag: '"etag-created"',
			detail: "created",
		});
	});

	it("an all-day event's YYYY-MM-DD start/end become DTSTART/DTEND;VALUE=DATE, not a UTC timestamp", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: { summary: "Holiday", start: "2026-07-10", end: "2026-07-11" },
		});

		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = String(init?.body);
			expect(body).toContain("DTSTART;VALUE=DATE:20260710");
			expect(body).toContain("DTEND;VALUE=DATE:20260711");
			return new Response(null, { status: 201 });
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

	it("escapes commas/semicolons/backslashes/newlines in SUMMARY per RFC 5545", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: "Comma, semi; back\\slash\nnewline",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});

		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = String(init?.body);
			expect(body).toContain(
				"SUMMARY:Comma\\, semi\\; back\\\\slash\\nnewline",
			);
			return new Response(null, { status: 201 });
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

	it("folds a long SUMMARY line at 75 octets per RFC 5545 §3.1, continuation lines prefixed with a single space", async () => {
		const op = makeCreateOp();
		const longSummary = "A".repeat(120);
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: longSummary,
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});

		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = String(init?.body);
			const lines = body.split("\r\n");
			// No content line (folded or not) may exceed 75 octets.
			for (const line of lines) {
				expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
			}
			// A continuation line exists and starts with exactly one space.
			expect(lines.some((line) => /^ A+$/.test(line))).toBe(true);
			// Unfolding (strip "\r\n " continuations) recovers the exact original
			// summary text.
			const unfolded = body.replace(/\r\n /g, "");
			expect(unfolded).toContain(`SUMMARY:${longSummary}`);
			return new Response(null, { status: 201 });
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

	it("a 412 (resource already exists) is treated as idempotent SUCCESS, not an error — no fallback to an unconditional PUT", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 412 }));

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
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("re-confirming the SAME create (same idempotencyKey) PUTs the same resource path both times", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});
		const seenUrls: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			seenUrls.push(String(input));
			return seenUrls.length === 1
				? new Response(null, { status: 201, headers: { ETag: '"e1"' } })
				: new Response(null, { status: 412 });
		});

		await executor().execute(USER_ID, CONNECTION_ID, op, content, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		await executor().execute(USER_ID, CONNECTION_ID, op, content, {
			fetch: fetchMock as unknown as typeof fetch,
		});

		expect(seenUrls[0]).toBe(seenUrls[1]);
	});

	it("a 401 flags the connection needs_reauth and returns {ok:false, reason:'needs_reauth'} without leaking the app password", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

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
		const [, , patch] = updateConnectionMock.mock.calls[0] ?? [];
		expect(JSON.stringify(patch)).not.toContain("app-specific-pw");
	});

	it("no stored app-specific password: refused as needs_reauth without ever calling fetch", async () => {
		getConnectionSecretMock.mockResolvedValue(null);
		const op = makeCreateOp();
		const fetchMock = vi.fn();

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ calendarUrl: CALENDAR_URL, event: { summary: "x" } }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "needs_reauth" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("connection not found: refused without calling fetch", async () => {
		getConnectionMock.mockResolvedValue(null);
		const op = makeCreateOp();
		const fetchMock = vi.fn();

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ calendarUrl: CALENDAR_URL, event: { summary: "x" } }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({ ok: false, reason: "connection_not_found" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("malformed content (not valid JSON) is refused as unsupported_operation without ever calling fetch", async () => {
		const op = makeCreateOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			"{not json",
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("missing calendarUrl in content is refused without calling fetch", async () => {
		const op = makeCreateOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ event: { summary: "x" } }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "missing_calendar_url" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("follows iCloud's undocumented partition redirect, re-sending Basic auth and the SAME conditional header at the new location", async () => {
		const op = makeCreateOp();
		const content = JSON.stringify({
			calendarUrl: CALENDAR_URL,
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
			},
		});
		const uid = expectedUid(op);
		const calls: { url: string; ifNoneMatch: string | null }[] = [];
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				calls.push({
					url: String(input),
					ifNoneMatch: headers.get("If-None-Match"),
				});
				if (calls.length === 1) {
					return new Response(null, {
						status: 302,
						headers: { Location: `https://p50-caldav.icloud.com/x/${uid}.ics` },
					});
				}
				return new Response(null, { status: 201, headers: { ETag: '"e"' } });
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
			{ url: `${CALENDAR_URL}${uid}.ics`, ifNoneMatch: "*" },
			{ url: `https://p50-caldav.icloud.com/x/${uid}.ics`, ifNoneMatch: "*" },
		]);
		expect(result.ok).toBe(true);
	});
});

describe("apple write-executor — calendar.update_event", () => {
	it("PATCHES the original ICS's LOCATION line in place at resourceHref with If-Match: {etag}, and returns the new etag", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
			uid: ORIGINAL_UID,
			originalIcs: makeOriginalIcs(),
			event: {
				summary: "Standup",
				start: "2026-07-10T09:00:00Z",
				end: "2026-07-10T09:30:00Z",
				location: "New Room",
			},
			recurring: false,
		});

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(`${CALENDAR_URL}evt-1.ics`);
				expect(init?.method).toBe("PUT");
				const headers = new Headers(init?.headers);
				expect(headers.get("If-Match")).toBe('"etag-1"');
				expect(headers.get("If-None-Match")).toBeNull();
				const body = String(init?.body);
				// The original UID/DTSTAMP lines are preserved VERBATIM — never
				// regenerated — proving this is a patch of the original resource,
				// not a freshly serialized VEVENT.
				expect(body).toContain(`UID:${ORIGINAL_UID}`);
				expect(body).toContain("DTSTAMP:20260701T120000Z");
				expect(body).toContain("LOCATION:New Room");
				expect(body).not.toContain("LOCATION:Room A");
				return new Response(null, {
					status: 200,
					headers: { ETag: '"etag-2"' },
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
			ok: true,
			etag: '"etag-2"',
			detail: "event updated",
		});
	});

	it("anti-corruption proof: ATTENDEE, an intact VALARM block, RRULE, and an X-CUSTOM property all survive an update that only changes the start time", async () => {
		const op = makeUpdateOp();
		const originalIcs = makeOriginalIcs([
			"ATTENDEE:mailto:alice@example.com",
			"RRULE:FREQ=WEEKLY;COUNT=5",
			"X-CUSTOM:keep-me",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"DESCRIPTION:Reminder",
			"TRIGGER:-PT15M",
			"END:VALARM",
		]);
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
			uid: ORIGINAL_UID,
			originalIcs,
			// Only `start` supplied — summary/end/location/description are NOT
			// in this payload at all, proving the patch leaves every property it
			// wasn't told to touch completely alone (not just the ones this
			// module doesn't model).
			event: { start: "2026-07-10T10:00:00Z" },
			recurring: false,
		});

		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = String(init?.body);
			expect(body).toContain("ATTENDEE:mailto:alice@example.com");
			expect(body).toContain("RRULE:FREQ=WEEKLY;COUNT=5");
			expect(body).toContain("X-CUSTOM:keep-me");
			expect(body).toContain("BEGIN:VALARM");
			expect(body).toContain("ACTION:DISPLAY");
			expect(body).toContain("DESCRIPTION:Reminder");
			expect(body).toContain("TRIGGER:-PT15M");
			expect(body).toContain("END:VALARM");
			// The one field actually supplied DID change.
			expect(body).toContain("DTSTART:20260710T100000Z");
			// Everything not supplied is untouched.
			expect(body).toContain("SUMMARY:Standup");
			expect(body).toContain("DTEND:20260710T093000Z");
			expect(body).toContain("LOCATION:Room A");
			return new Response(null, { status: 200, headers: { ETag: '"e2"' } });
		});

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.ok).toBe(true);
	});

	it("anti-injection: a description containing an embedded CR/LF cannot inject a second property line, and a line-breaking uid is refused rather than written", async () => {
		const originalIcs = makeOriginalIcs();

		// (a) A field value with an embedded CRLF is escaped into a single
		// SUMMARY/DESCRIPTION content line, never split into a real second
		// line the way an unescaped "\r\nSUMMARY:injected" would be.
		const injectedDescription = "Notes\r\nSUMMARY:injected";
		const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
			const body = String(init?.body);
			const unfolded = body.replace(/\r\n /g, "");
			expect(unfolded).toContain("DESCRIPTION:Notes\\nSUMMARY:injected");
			// The only two real SUMMARY/DESCRIPTION content lines are the
			// original SUMMARY and the escaped DESCRIPTION — no bare injected
			// "SUMMARY:injected" line exists on its own.
			const lines = body.split("\r\n");
			const summaryLines = lines.filter((line) => /^SUMMARY:/.test(line));
			expect(summaryLines).toEqual(["SUMMARY:Standup"]);
			return new Response(null, { status: 200, headers: { ETag: '"e"' } });
		});

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			makeUpdateOp(),
			JSON.stringify({
				resourceHref: `${CALENDAR_URL}evt-1.ics`,
				etag: '"etag-1"',
				uid: ORIGINAL_UID,
				originalIcs,
				event: { description: injectedDescription },
				recurring: false,
			}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// (b) A `uid` that itself carries an embedded line break is rejected
		// outright — never used to build/match a content line — rather than
		// risking a malformed or injected PUT body.
		const injectingFetchMock = vi.fn();
		const rejected = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			makeUpdateOp(),
			JSON.stringify({
				resourceHref: `${CALENDAR_URL}evt-1.ics`,
				etag: '"etag-1"',
				uid: `${ORIGINAL_UID}\r\nSUMMARY:injected`,
				originalIcs,
				event: { summary: "x" },
				recurring: false,
			}),
			{ fetch: injectingFetchMock as unknown as typeof fetch },
		);
		expect(rejected).toEqual({ ok: false, reason: "invalid_ical_value" });
		expect(injectingFetchMock).not.toHaveBeenCalled();
	});

	it("a 412 (changed since read) is refused as conflict_changed — NEVER retried/overwritten unconditionally", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"stale-etag"',
			uid: ORIGINAL_UID,
			originalIcs: makeOriginalIcs(),
			event: { summary: "Standup" },
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 412 }));

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);

		expect(result).toEqual({ ok: false, reason: "conflict_changed" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("recurring: true is refused as recurring_update_unsupported without ever issuing a PUT (defense-in-depth; the tool itself never proposes this)", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
			uid: "evt-1@icloud.com",
			event: { summary: "Standup" },
			recurring: true,
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

		expect(result).toEqual({
			ok: false,
			reason: "recurring_update_unsupported",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("missing resourceHref/etag/uid is refused as missing_target without calling fetch", async () => {
		const op = makeUpdateOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({ event: { summary: "x" } }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "missing_target" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("missing originalIcs is refused as missing_target without calling fetch — regenerating from scratch would corrupt unmodeled properties", async () => {
		const op = makeUpdateOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({
				resourceHref: `${CALENDAR_URL}evt-1.ics`,
				etag: '"etag-1"',
				uid: ORIGINAL_UID,
				event: { summary: "x" },
			}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "missing_target" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a 401 on the PUT flags needs_reauth", async () => {
		const op = makeUpdateOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
			uid: ORIGINAL_UID,
			originalIcs: makeOriginalIcs(),
			event: { summary: "x" },
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

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
});

describe("apple write-executor — calendar.delete_event", () => {
	it("DELETEs resourceHref with If-Match: {etag} and succeeds on 204", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
		});

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(`${CALENDAR_URL}evt-1.ics`);
				expect(init?.method).toBe("DELETE");
				const headers = new Headers(init?.headers);
				expect(headers.get("If-Match")).toBe('"etag-1"');
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

	it("a 404/410 (already gone) is treated as idempotent SUCCESS", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
		});
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

	it("a 412 (changed since read) is refused as conflict_changed", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"stale-etag"',
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 412 }));

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result).toEqual({ ok: false, reason: "conflict_changed" });
	});

	it("a recurring series delete reports 'series deleted' in its detail", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
			recurring: true,
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			content,
			{
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		expect(result).toEqual({ ok: true, detail: "series deleted" });
	});

	it("missing resourceHref/etag is refused as missing_target without calling fetch", async () => {
		const op = makeDeleteOp();
		const fetchMock = vi.fn();
		const result = await executor().execute(
			USER_ID,
			CONNECTION_ID,
			op,
			JSON.stringify({}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "missing_target" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a 401 on the DELETE flags needs_reauth", async () => {
		const op = makeDeleteOp();
		const content = JSON.stringify({
			resourceHref: `${CALENDAR_URL}evt-1.ics`,
			etag: '"etag-1"',
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

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
});

describe("apple write-executor — conditional-header invariant", () => {
	it("EVERY PUT/DELETE issued by this executor carries either If-None-Match or If-Match — never an unconditional write", async () => {
		const seenHeaders: (string | null)[] = [];
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				seenHeaders.push(
					headers.get("If-None-Match") ?? headers.get("If-Match"),
				);
				return new Response(null, { status: 200, headers: { ETag: '"e"' } });
			},
		);

		const createOp = makeCreateOp();
		await executor().execute(
			USER_ID,
			CONNECTION_ID,
			createOp,
			JSON.stringify({
				calendarUrl: CALENDAR_URL,
				event: {
					summary: "x",
					start: "2026-07-10T09:00:00Z",
					end: "2026-07-10T09:30:00Z",
				},
			}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await executor().execute(
			USER_ID,
			CONNECTION_ID,
			makeUpdateOp(),
			JSON.stringify({
				resourceHref: `${CALENDAR_URL}evt-1.ics`,
				etag: '"etag-1"',
				uid: ORIGINAL_UID,
				originalIcs: makeOriginalIcs(),
				event: { summary: "x" },
			}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await executor().execute(
			USER_ID,
			CONNECTION_ID,
			makeDeleteOp(),
			JSON.stringify({
				resourceHref: `${CALENDAR_URL}evt-1.ics`,
				etag: '"etag-1"',
			}),
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(seenHeaders).toEqual(["*", '"etag-1"', '"etag-1"']);
		expect(seenHeaders.every((h) => h !== null)).toBe(true);
	});
});

describe("apple write-executor — unsupported action", () => {
	it("an op.action this executor doesn't recognize is refused as unsupported_operation", async () => {
		const op: WriteOperation = {
			provider: "apple",
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
			JSON.stringify({ calendarUrl: CALENDAR_URL }),
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result).toEqual({ ok: false, reason: "unsupported_operation" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
