// Issue 8.1 — proactive in-chat calendar/email context.
//
// When the user's calendar and/or email capability is ACTIVE for this turn
// AND the message plausibly relates to it (fetch-on-relevance), this module
// builds a small, FRESH, EPHEMERAL markdown block — upcoming events, a
// recent-unread summary — for the normal-chat-context-preparation
// pipeline's `proactive_connector_context` stage to splice into the outbound
// prompt (see normal-chat-context.ts's runProactiveConnectorContextStage).
// In-chat only:
//   - NEVER written to persistent Memory or any DB row — this module only
//     reads connector data and returns a string. It must never be passed to
//     anything under chat-turn/finalize.ts, memory-judge/,
//     memory-consolidation/, or memory-profile/dirty-ledger, and must never
//     schedule the conversation judge or record a memory event. The caller
//     (normal-chat-context.ts) only ever splices the returned block into
//     `inputValue` for this one outbound request.
//   - Works in incognito: `isConversationIncognito` is consulted ONLY to
//     suppress the ephemeral in-memory cache WRITE below (an optional
//     perf/rate-limit aid, not persistence or telemetry) — it never gates
//     whether the block is built or injected. Functionality is preserved in
//     incognito, matching how memory RECALL already behaves.
//   - Locality (Option A): every capability's raw text is routed through
//     `decideLocalDistill` (reused verbatim from
//     normal-chat-tools/connector-distill.ts — the same gate the calendar/
//     email tools themselves use) before it can be part of the returned
//     block. If Option A is active for a cloud model and distillation comes
//     back `unavailable`, that capability's section is WITHHELD entirely —
//     never the raw text.
//   - Budget-bounded: the combined block is truncated to
//     deriveProactiveConnectorContextBudget's token budget before being
//     returned, on top of a short-TTL fetch cache (proactive-connector-
//     cache.ts) so repeated relevant turns don't re-hit the provider.
//   - A broken/needs_reauth/slow connector is silently skipped (never
//     throws, never breaks the turn, never logs a secret).
import { isConversationIncognito } from "$lib/server/services/memory-controls";
import { decideLocalDistill } from "$lib/server/services/normal-chat-tools/connector-distill";
import { truncateToTokenBudget } from "$lib/server/utils/prompt-context";
import { appleListEvents } from "../connections/providers/apple-caldav";
import {
	type CalendarEvent,
	googleListEvents,
} from "../connections/providers/google-calendar";
import {
	type EmailHeader,
	imapListRecent,
} from "../connections/providers/imap";
import type { Capability } from "../connections/registry";
import { resolveConnectionsForCapability } from "../connections/resolve";
import type { ConnectionPublic } from "../connections/store";
import { deriveProactiveConnectorContextBudget } from "./context-budget";
import {
	readProactiveConnectorContextCache,
	writeProactiveConnectorContextCache,
} from "./proactive-connector-cache";

const LOG_PREFIX = "[PROACTIVE_CONNECTOR_CONTEXT]";

// Fetch-on-relevance gate — bilingual (en + hu), deliberately loose (mirrors
// WEB_INTENT_RE/DEEP_CONTEXT_INTENT_RE's own posture in normal-chat-context
// .ts/context-selection.ts: an intent regex only needs to avoid fetching on
// every turn, not achieve perfect precision). A short generic "what's on my
// plate / my day" style fallback is included so a vague proactive-feeling
// prompt still triggers the calendar section.
export const CALENDAR_INTENT_RE =
	/\b(meeting|meetings|schedule|scheduled|scheduling|calendar|event|events|appointment|appointments|free|busy|today|tomorrow|tonight|this week|on my plate|my day|my schedule|találkozó|találkozóm|találkozók|naptár(am)?|időpont(om)?|időpontok|esemény(em)?|események|szabad vagyok|foglalt vagyok|\bma\b|holnap|ezen a héten|mai napom|napirendem)\b/i;

export const EMAIL_INTENT_RE =
	/\b(email|emails|e-mail|e-mails|inbox|unread|mail|mails|reply|replies|message|messages|leveleim|levelem|levél|levelek|olvasatlan|postafiók(om)?|postaláda|válasz(om)?|válaszok)\b/i;

const CALENDAR_LOOKAHEAD_HOURS = 48;
const CALENDAR_MAX_EVENTS = 10;
const EMAIL_RECENT_LIMIT = 5;
// A proactive nudge must never stall the turn waiting on a slow connector —
// bounded well under the request's own overall timeout.
const CONNECTOR_FETCH_TIMEOUT_MS = 5_000;

const PROACTIVE_CONTEXT_HEADING = "## Your calendar & mail (live)";

export type ProactiveConnectorContextParams = {
	userId: string;
	conversationId: string;
	modelId: string;
	message: string;
	activeCapabilities: ReadonlySet<Capability>;
	targetConstructedContextTokens: number;
	now?: number;
};

export type ProactiveConnectorContextResult = {
	block: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("proactive_connector_context_fetch_timeout"));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// defaultOn first (stable sort preserves resolveConnectionsForCapability's
// existing alphabetical order among ties) — same "pick the primary
// connection, note the rest" posture as calendar.ts/email.ts's own
// needsDisambiguation handling, just without a full ambiguity sentence (this
// is a passive nudge, not a tool result the model needs to caveat).
function pickConnection(
	connections: ConnectionPublic[],
): { conn: ConnectionPublic; ambiguous: boolean } | null {
	if (connections.length === 0) return null;
	const sorted = [...connections].sort((a, b) => {
		if (a.defaultOn === b.defaultOn) return 0;
		return a.defaultOn ? -1 : 1;
	});
	const conn = sorted[0];
	if (!conn) return null;
	return { conn, ambiguous: connections.length > 1 };
}

function formatInstant(value: string): string {
	const date = new Date(value);
	// toISOString is always UTC — deterministic across test/server timezones,
	// unlike toLocaleString. "YYYY-MM-DD HH:MM".
	return Number.isNaN(date.getTime())
		? value
		: date.toISOString().replace("T", " ").slice(0, 16);
}

async function fetchCalendarLines(
	userId: string,
	conn: ConnectionPublic,
	now: number,
): Promise<string[]> {
	const timeMin = new Date(now).toISOString();
	const timeMax = new Date(
		now + CALENDAR_LOOKAHEAD_HOURS * 60 * 60 * 1000,
	).toISOString();
	const events: CalendarEvent[] =
		conn.provider === "apple"
			? (await appleListEvents(userId, conn.id, { timeMin, timeMax })).slice(
					0,
					CALENDAR_MAX_EVENTS,
				)
			: await googleListEvents(userId, conn.id, {
					timeMin,
					timeMax,
					maxResults: CALENDAR_MAX_EVENTS,
				});
	return events.map((event) => {
		const title =
			event.summary && event.summary.length > 0
				? event.summary
				: "(untitled event)";
		const parts = [
			`${formatInstant(event.start)}–${formatInstant(event.end)}`,
			title,
		];
		if (event.location) parts.push(event.location);
		return `- ${parts.join(" — ")}`;
	});
}

async function fetchEmailLines(
	userId: string,
	conn: ConnectionPublic,
): Promise<string[]> {
	const headers: EmailHeader[] = await imapListRecent(userId, conn.id, {
		limit: EMAIL_RECENT_LIMIT,
		unseenOnly: true,
	});
	return headers.map((header) => {
		const from =
			header.from && header.from.length > 0 ? header.from : "(unknown sender)";
		const subject =
			header.subject && header.subject.length > 0
				? header.subject
				: "(no subject)";
		return `- ${from} — "${subject}"`;
	});
}

function sectionHeading(
	base: string,
	ambiguous: boolean,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	return ambiguous
		? `${base} (using "${conn.label}" of ${connections.length} connections)`
		: base;
}

async function buildCapabilitySection(params: {
	userId: string;
	modelId: string;
	message: string;
	capability: "calendar" | "email";
	incognito: boolean;
	now: number;
}): Promise<string | null> {
	const { userId, modelId, message, capability, incognito, now } = params;

	const connections = await resolveConnectionsForCapability(
		userId,
		capability,
	).catch(() => [] as ConnectionPublic[]);
	const picked = pickConnection(connections);
	if (!picked) return null;
	const { conn, ambiguous } = picked;

	const cacheKeyParams = { userId, connectionId: conn.id, capability };
	let lines = readProactiveConnectorContextCache(cacheKeyParams, now);
	if (lines === null) {
		try {
			lines = await withTimeout(
				capability === "calendar"
					? fetchCalendarLines(userId, conn, now)
					: fetchEmailLines(userId, conn),
				CONNECTOR_FETCH_TIMEOUT_MS,
			);
		} catch (error) {
			// Silently skip — a broken/needs_reauth/slow connector must never
			// break the turn. `error.message` on these adapters' typed errors
			// (GoogleCalendarError/AppleCalDavError/ImapError) is always a
			// generic, non-secret description (mirrors mapAdapterError in
			// calendar.ts/email.ts); nothing token-bearing is ever logged here.
			console.warn(`${LOG_PREFIX} Connector fetch skipped`, {
				userId,
				capability,
				connectionId: conn.id,
				provider: conn.provider,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		if (!incognito) {
			writeProactiveConnectorContextCache(cacheKeyParams, lines, now);
		}
	}

	const heading = sectionHeading(
		capability === "calendar"
			? `Calendar (next ${CALENDAR_LOOKAHEAD_HOURS}h)`
			: "Recent unread email",
		ambiguous,
		conn,
		connections,
	);

	if (lines.length === 0) {
		const emptyNote =
			capability === "calendar"
				? "No events in this window."
				: "No unread messages.";
		return `${heading}:\n${emptyNote}`;
	}

	const rawText = lines.join("\n");
	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability,
		userQuestion: message,
		rawText,
	});

	if (!decision.shouldDistill) {
		return `${heading}:\n${rawText}`;
	}
	if ("distilled" in decision) {
		return `${heading} (privately summarized for a cloud model):\n${decision.distilled}`;
	}
	// unavailable — fail-safe withhold. Never fall back to the raw text.
	return null;
}

export async function buildProactiveConnectorContext(
	params: ProactiveConnectorContextParams,
): Promise<ProactiveConnectorContextResult | null> {
	const wantsCalendar =
		params.activeCapabilities.has("calendar") &&
		CALENDAR_INTENT_RE.test(params.message);
	const wantsEmail =
		params.activeCapabilities.has("email") &&
		EMAIL_INTENT_RE.test(params.message);
	if (!wantsCalendar && !wantsEmail) return null;

	const now = params.now ?? Date.now();
	const incognito = await isConversationIncognito(params.conversationId).catch(
		() => false,
	);

	const sections: string[] = [];
	if (wantsCalendar) {
		const section = await buildCapabilitySection({
			userId: params.userId,
			modelId: params.modelId,
			message: params.message,
			capability: "calendar",
			incognito,
			now,
		});
		if (section) sections.push(section);
	}
	if (wantsEmail) {
		const section = await buildCapabilitySection({
			userId: params.userId,
			modelId: params.modelId,
			message: params.message,
			capability: "email",
			incognito,
			now,
		});
		if (section) sections.push(section);
	}

	if (sections.length === 0) return null;

	const budget = deriveProactiveConnectorContextBudget({
		contextBudget: {
			targetConstructedContext: params.targetConstructedContextTokens,
		},
	});
	const body = truncateToTokenBudget(sections.join("\n\n"), budget.totalBudget);
	if (!body.trim()) return null;

	return { block: [PROACTIVE_CONTEXT_HEADING, body].join("\n\n") };
}
