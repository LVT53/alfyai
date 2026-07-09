// Apple iCloud CalDAV WRITE executor (Issue 6.2) — the ONLY code path that
// ever issues a mutating (PUT/DELETE) request against a user's Apple iCloud
// Calendar. Registered via registerWriteExecutor (Issue 6.0) so
// confirmPendingWrite (pending-writes.ts) dispatches "apple" pending writes
// here, and only after the user has explicitly confirmed — the calendar chat
// tool (normal-chat-tools/calendar.ts) never imports this module; it only
// ever proposes a PENDING write via createPendingWrite. Every network call
// accepts an injectable `fetch` so this module is fully testable against
// mocked iCloud endpoints — nothing here ever talks to live iCloud in tests.
//
// CalDAV has no server-enforced idempotent-create or optimistic-concurrency
// primitive beyond plain HTTP conditional requests, and iCloud's own CalDAV
// implementation is undocumented and fragile — so EVERY mutating request here
// carries a conditional header, with no exceptions:
//   - create -> `If-None-Match: *`   (only succeeds if nothing exists yet)
//   - update/delete -> `If-Match: {etag}` (only succeeds if unchanged since read)
// A 412 on create means "already created" (idempotent success, not an error);
// a 412 on update/delete means the resource changed since it was last read,
// which is surfaced as `conflict_changed` and NEVER retried/overwritten
// unconditionally. This is the whole "can't corrupt files" guarantee for this
// provider — see apple-caldav.ts's module doc comment for why iCloud's CalDAV
// behavior can't be trusted to be safe any other way.
import { createHash } from "node:crypto";
import { getConnection, getConnectionSecret, updateConnection } from "../store";
import {
	registerWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import { idempotencyKey, type WriteOperation } from "../write-guard";
import { basicAuthHeader } from "./apple-caldav";

type FetchOpt = { fetch?: typeof fetch };

const REQUEST_TIMEOUT_MS = 15_000;
// Bounds how many 3xx hops a single write request will follow — mirrors
// apple-caldav.ts's own MAX_REDIRECTS for reads (iCloud's undocumented
// partition redirect, see that module's doc comment).
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// content parsing — the calendar tool (normal-chat-tools/calendar.ts) is the
// only producer of this shape; this module is the only consumer.
// ---------------------------------------------------------------------------

type AppleCalendarWriteEventFields = {
	summary?: string;
	start?: string;
	end?: string;
	location?: string;
	description?: string;
};

export type AppleCalendarWriteContent = {
	// Required for create_event — the collection a new .ics resource is PUT
	// into.
	calendarUrl?: string;
	// Required for update_event/delete_event — the exact resource identified
	// by the tool's propose-time fetch (appleGetEventByUid).
	resourceHref?: string;
	etag?: string;
	// Required for update_event — carried through so the regenerated VEVENT
	// keeps the SAME UID rather than the executor having to guess it back out
	// of resourceHref (which may not follow this module's own `{uid}.ics`
	// naming convention for an event that pre-dates this connection, e.g. one
	// created from a Mac/iPhone).
	uid?: string;
	event?: AppleCalendarWriteEventFields;
	// Set by the tool at propose time (via appleGetEventByUid's `recurrence`)
	// when the target event carries an RRULE. update_event refuses outright
	// whenever this is true — see the module doc comment on
	// executeUpdate below for why. This is a defense-in-depth check (the
	// primary guardrail lives in the calendar tool, which never even creates
	// a pending write for a recurring update): staleness between propose and
	// confirm time is still caught by the mandatory If-Match/etag check
	// above, which would 412 if the event's RRULE-ness itself changed
	// server-side in between.
	recurring?: boolean;
};

function parseContent(content: string): AppleCalendarWriteContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<AppleCalendarWriteContent>;
		return {
			...(typeof parsed.calendarUrl === "string"
				? { calendarUrl: parsed.calendarUrl }
				: {}),
			...(typeof parsed.resourceHref === "string"
				? { resourceHref: parsed.resourceHref }
				: {}),
			...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
			...(typeof parsed.uid === "string" ? { uid: parsed.uid } : {}),
			...(parsed.event && typeof parsed.event === "object"
				? { event: parsed.event as AppleCalendarWriteEventFields }
				: {}),
			...(typeof parsed.recurring === "boolean"
				? { recurring: parsed.recurring }
				: {}),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Deterministic client-derived UID (create idempotency) — mirrors
// google-calendar-write.ts's googleEventIdForOp: deriving the UID from the
// pending write's idempotencyKey (a pure function of the WriteOperation) so
// re-attempting the SAME create (a retried confirm after a crash, or a
// second pending write proposed from byte-identical tool input) always PUTs
// the exact same resource path. `If-None-Match: *` then turns iCloud's own
// 412 on that re-PUT into idempotent success rather than a silent duplicate
// event — no persisted state of its own needed, the determinism is the whole
// mechanism.
export function appleEventUidForOp(op: WriteOperation): string {
	const hash = createHash("sha256").update(idempotencyKey(op)).digest("hex");
	return `${hash}@alfyai.app`;
}

// ---------------------------------------------------------------------------
// Minimal iCalendar (RFC 5545) VEVENT serializer — hand-rolled, no
// dependency, mirroring apple-caldav.ts's parseICalEvents in reverse. Only
// emits the handful of fields the calendar tool writes
// (UID/DTSTAMP/DTSTART/DTEND/SUMMARY/LOCATION/DESCRIPTION); anything else a
// pre-existing event might carry (ATTENDEE/ORGANIZER/VALARM/CATEGORIES/...)
// is NOT round-tripped by an update — a known v1 limitation of "regenerate
// the VEVENT" rather than "patch it in place" (CalDAV's PUT replaces the
// whole resource; there is no partial-update primitive).
// ---------------------------------------------------------------------------

const ALL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINE_OCTETS = 75;

// Reverses apple-caldav.ts's unescapeICalText — RFC 5545 §3.3.11 TEXT
// escaping. Backslash MUST be escaped first, before the other three
// replacements introduce new backslashes of their own; escaping it again
// afterwards would double-escape them.
function escapeICalText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/,/g, "\\,")
		.replace(/;/g, "\\;");
}

function icalDateOnly(value: string): string {
	return value.replace(/-/g, "");
}

// Always emits the UTC "basic" form (YYYYMMDDTHHMMSSZ) regardless of what
// offset/zone the input ISO string carried — this module never writes a
// TZID, mirroring parseICalTimestamp's read-side stance that resolving
// timezone offsets precisely isn't worth the complexity for this connector.
function icalUtcTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid event date/time value: ${JSON.stringify(value)}`);
	}
	return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function toICalDtProperty(name: "DTSTART" | "DTEND", value: string): string {
	return ALL_DAY_PATTERN.test(value)
		? `${name};VALUE=DATE:${icalDateOnly(value)}`
		: `${name}:${icalUtcTimestamp(value)}`;
}

// RFC 5545 §3.1 line folding: no content line may exceed 75 octets
// (UTF-8 bytes, NOT characters); continuation lines are introduced by a
// CRLF followed by a single space, and that leading space itself counts
// toward the next line's 75-octet budget. Splits on octet boundaries only —
// never inside a multi-byte UTF-8 character — by backing off while the byte
// at the candidate split point is a UTF-8 continuation byte (0b10xxxxxx).
function foldICalLine(line: string): string {
	const bytes = Buffer.from(line, "utf8");
	if (bytes.length <= MAX_LINE_OCTETS) return line;

	const chunks: string[] = [];
	let start = 0;
	let limit = MAX_LINE_OCTETS;
	while (start < bytes.length) {
		let end = Math.min(start + limit, bytes.length);
		while (end > start + 1 && (bytes[end] as number) >>> 6 === 0b10) end--;
		chunks.push(bytes.subarray(start, end).toString("utf8"));
		start = end;
		// Every continuation line after the first starts with one leading
		// space, which itself occupies one of the 75 octets.
		limit = MAX_LINE_OCTETS - 1;
	}
	return chunks.join("\r\n ");
}

function serializeVevent(
	uid: string,
	event: AppleCalendarWriteEventFields,
): string {
	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//AlfyAI//Calendar Write 1.0//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:${icalUtcTimestamp(new Date().toISOString())}`,
	];
	if (event.start !== undefined)
		lines.push(toICalDtProperty("DTSTART", event.start));
	if (event.end !== undefined) lines.push(toICalDtProperty("DTEND", event.end));
	if (event.summary !== undefined) {
		lines.push(`SUMMARY:${escapeICalText(event.summary)}`);
	}
	if (event.location !== undefined) {
		lines.push(`LOCATION:${escapeICalText(event.location)}`);
	}
	if (event.description !== undefined) {
		lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
	}
	lines.push("END:VEVENT", "END:VCALENDAR");
	return `${lines.map(foldICalLine).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// fetch plumbing
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(
				`Apple CalDAV write request timed out after ${REQUEST_TIMEOUT_MS}ms`,
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

type ConditionalHeader =
	| { name: "If-None-Match"; value: "*" }
	| { name: "If-Match"; value: string };

// Issues a PUT/DELETE with Basic auth and the caller's mandatory conditional
// header, manually following iCloud's undocumented partition redirect the
// same way apple-caldav.ts's caldavRequest does for PROPFIND/REPORT —
// reimplemented here (rather than reused) because caldavRequest hard-codes
// "expect a 207 multistatus XML body", which does not hold for a write
// response (200/201/204/404/410/412, no XML body).
async function caldavWriteRequest(
	fetchImpl: typeof fetch,
	url: string,
	auth: string,
	method: "PUT" | "DELETE",
	conditional: ConditionalHeader,
	body?: string,
): Promise<Response> {
	let currentUrl = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetchWithTimeout(fetchImpl, currentUrl, {
			method,
			redirect: "manual",
			headers: {
				Authorization: auth,
				[conditional.name]: conditional.value,
				...(body !== undefined
					? { "Content-Type": "text/calendar; charset=utf-8" }
					: {}),
			},
			...(body !== undefined ? { body } : {}),
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("Location");
			if (!location) {
				throw new Error(
					`Apple CalDAV write redirected without a Location header (status ${response.status})`,
				);
			}
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		return response;
	}
	throw new Error("Too many redirects while writing to Apple CalDAV");
}

// A 401 here means iCloud rejected the (stored) app-specific password for
// this specific request. Never logs/surfaces the password itself — only a
// generic detail, same posture as apple-caldav.ts's own read-side flagging.
async function flagNeedsReauth(
	userId: string,
	connectionId: string,
): Promise<void> {
	await updateConnection(userId, connectionId, {
		status: "needs_reauth",
		statusDetail:
			"Apple rejected the write request for this Calendar connection",
	});
}

async function getAuthOrReauth(
	userId: string,
	connectionId: string,
): Promise<
	{ ok: true; auth: string } | { ok: false; result: WriteExecutionResult }
> {
	const conn = await getConnection(userId, connectionId);
	if (!conn) {
		return { ok: false, result: { ok: false, reason: "connection_not_found" } };
	}
	const appPassword = await getConnectionSecret(userId, connectionId);
	if (!appPassword) {
		return { ok: false, result: { ok: false, reason: "needs_reauth" } };
	}
	const appleId =
		typeof conn.config.appleId === "string"
			? conn.config.appleId
			: conn.accountIdentifier;
	return { ok: true, auth: basicAuthHeader(appleId, appPassword) };
}

// ---------------------------------------------------------------------------
// create / update / delete
// ---------------------------------------------------------------------------

async function executeCreate(
	userId: string,
	connectionId: string,
	auth: string,
	op: WriteOperation,
	content: AppleCalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.calendarUrl)
		return { ok: false, reason: "missing_calendar_url" };

	const uid = appleEventUidForOp(op);
	const resourceHref = `${content.calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
	const ics = serializeVevent(uid, content.event ?? {});

	const response = await caldavWriteRequest(
		fetchImpl,
		resourceHref,
		auth,
		"PUT",
		{ name: "If-None-Match", value: "*" },
		ics,
	);

	if (response.status === 401) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	if (response.status === 412) {
		// The client-derived resource already exists — idempotent success, NOT
		// a double-create. Never falls back to an unconditional PUT.
		return { ok: true, detail: "already created" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	return { ok: true, etag: response.headers.get("ETag"), detail: "created" };
}

// Recurring events are refused here unconditionally (regardless of any
// scope) — CalDAV has no "this occurrence only" primitive equivalent to
// Google's expanded-instance ids, and regenerating a recurring master's whole
// VEVENT (RRULE/EXDATE/RECURRENCE-ID overrides) from this tool's minimal
// event fields would risk silently destroying the series definition. The
// calendar tool itself already refuses to even create a pending write for a
// recurring update (see normal-chat-tools/calendar.ts) — this check is
// defense-in-depth for any pending write that reaches this executor anyway.
async function executeUpdate(
	userId: string,
	connectionId: string,
	auth: string,
	content: AppleCalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.resourceHref || !content.etag || !content.uid) {
		return { ok: false, reason: "missing_target" };
	}
	if (content.recurring) {
		return { ok: false, reason: "recurring_update_unsupported" };
	}

	const ics = serializeVevent(content.uid, content.event ?? {});
	const response = await caldavWriteRequest(
		fetchImpl,
		content.resourceHref,
		auth,
		"PUT",
		{ name: "If-Match", value: content.etag },
		ics,
	);

	if (response.status === 401) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	if (response.status === 412) {
		// The resource changed since it was read — NEVER retried/overwritten
		// unconditionally.
		return { ok: false, reason: "conflict_changed" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	return {
		ok: true,
		etag: response.headers.get("ETag"),
		detail: "event updated",
	};
}

async function executeDelete(
	userId: string,
	connectionId: string,
	auth: string,
	content: AppleCalendarWriteContent,
	opts?: FetchOpt,
): Promise<WriteExecutionResult> {
	const fetchImpl = opts?.fetch ?? fetch;
	if (!content.resourceHref || !content.etag) {
		return { ok: false, reason: "missing_target" };
	}

	const response = await caldavWriteRequest(
		fetchImpl,
		content.resourceHref,
		auth,
		"DELETE",
		{ name: "If-Match", value: content.etag },
	);

	if (response.status === 401) {
		await flagNeedsReauth(userId, connectionId);
		return { ok: false, reason: "needs_reauth" };
	}
	// 404/410 means the resource is already gone — idempotent success, not a
	// failure to surface a second time.
	if (response.status === 404 || response.status === 410) {
		return { ok: true, detail: "already deleted" };
	}
	if (response.status === 412) {
		return { ok: false, reason: "conflict_changed" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	// Deleting a recurring event's resource removes the WHOLE series (CalDAV
	// has only one resource per series, master + overrides together) — the
	// calendar tool's preview already surfaces this before confirm; `detail`
	// here just reflects it back for anything that logs/displays the result.
	return { ok: true, detail: content.recurring ? "series deleted" : "deleted" };
}

// ---------------------------------------------------------------------------
// registration (Issue 6.0) — imported for its side effect by pending-writes
// .ts, the same way providers/google-calendar-write.ts is (see the comment
// above that import for why this needs to happen on that exact import path).
// ---------------------------------------------------------------------------

registerWriteExecutor({
	provider: "apple",
	async execute(userId, connectionId, op, content, opts) {
		const parsed = parseContent(content);
		if (!parsed) return { ok: false, reason: "unsupported_operation" };

		try {
			const authResult = await getAuthOrReauth(userId, connectionId);
			if (!authResult.ok) return authResult.result;

			switch (op.action) {
				case "calendar.create_event":
					return executeCreate(
						userId,
						connectionId,
						authResult.auth,
						op,
						parsed,
						opts,
					);
				case "calendar.update_event":
					return executeUpdate(
						userId,
						connectionId,
						authResult.auth,
						parsed,
						opts,
					);
				case "calendar.delete_event":
					return executeDelete(
						userId,
						connectionId,
						authResult.auth,
						parsed,
						opts,
					);
				default:
					return { ok: false, reason: "unsupported_operation" };
			}
		} catch {
			// caldavWriteRequest throws on a timeout/redirect-loop/missing
			// Location header — none of those are the user's fault, and none of
			// them should ever leak internals (or the app-specific password,
			// which never appears in these error messages to begin with) back
			// through the confirm response.
			return { ok: false, reason: "request_failed" };
		}
	},
});
