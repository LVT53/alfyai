/**
 * The chat home's greeting line.
 *
 * The screen used to draw one of seven fixed lines at random on every load,
 * which meant the greeting changed while you were reading it and never knew
 * anything about you. This picks one line from a weighted pool instead, and
 * the pool knows what the home screen already knows: the hour, the weekday,
 * whether the week has been quiet or busy, whether a job is still running,
 * what you were last talking about, whether this is your first visit today.
 *
 * Two properties matter more than the copy:
 *
 * 1. It is DETERMINISTIC per (user, calendar day, time-of-day slot). Reloading
 *    the page — or bouncing back from a chat — gives you the same line. The
 *    line changes when the part of the day changes, four times over, so the
 *    home screen is not frozen either.
 * 2. Context beats filler. A line that matched something real about today is
 *    only in the pool when it actually matches, and then it is weighted three
 *    to one against the generic lines. On a day with nothing to say the pool
 *    is just the generic eight and the greeting is the old behaviour, minus
 *    the reshuffle on every load.
 *
 * The module is pure: it takes a translate function and a context, and returns
 * a rendered line. localStorage is read and written by the two helpers at the
 * bottom, both of which swallow every failure — a greeting is not worth an
 * exception in a private window.
 */

import type { I18nKey } from "$lib/i18n";

export type GreetingGroup =
	| "generic"
	| "time"
	| "weekday"
	| "quiet"
	| "busy"
	| "continuity"
	| "running"
	| "firstVisit"
	| "connections";

export const GREETING_TIME_OF_DAY = [
	"morning",
	"afternoon",
	"evening",
	"night",
] as const;

export type GreetingTimeOfDay = (typeof GREETING_TIME_OF_DAY)[number];

export type GreetingWeekShape = "quiet" | "busy" | "steady";

/** A generic line: always in the pool, never the reason you noticed it. */
export const GREETING_GENERIC_WEIGHT = 1;

/** A line that matched something about today. Three to one against filler. */
export const GREETING_CONTEXT_WEIGHT = 3;

/**
 * The longest rendered greeting that still sits on one row.
 *
 * Measured, not estimated. The band is a 780px column holding the greeting and
 * the twelve weekly bars side by side; with the bars and the week's count
 * drawn, Chrome reports 556px left for the greeting. At 1.75rem in the serif
 * face the lines in this pool average a shade under 14.6px per character, so
 * 38 characters — with a ten-character display name substituted in — is the
 * ceiling that holds. Every authored line is inside it (a unit test says so);
 * the continuity lines are cut to it at runtime, because only they interpolate
 * a title the user chose.
 *
 * A name much longer than ten characters can still push the widest lines onto
 * a second row. That is what `text-wrap: balance` on the heading is for, and
 * it is the behaviour the screen already had.
 */
export const GREETING_MAX_LINE_CHARS = 38;

/** The reference name the authoring cap is measured against. */
export const GREETING_REFERENCE_NAME_CHARS = 10;

/** A recent conversation title is cut to its first six words before fitting. */
export const GREETING_TOPIC_MAX_WORDS = 6;

/**
 * Below this a truncated title is no longer a topic, it is a stub — and the
 * continuity line drops out of the pool rather than saying "Back to Quarterl…".
 */
export const GREETING_TOPIC_MIN_CHARS = 8;

/** At or under this many messages, the week reads as quiet outright. */
export const GREETING_QUIET_ABSOLUTE = 3;

/** At or over this many, it reads as busy outright. */
export const GREETING_BUSY_ABSOLUTE = 12;

/**
 * Between the two absolutes the week is judged against the user's own median
 * week, but only once there are enough past weeks for a median to mean
 * anything.
 */
export const GREETING_BASELINE_MIN_WEEKS = 3;

export interface GreetingWeekInput {
	/** Message counts per week, oldest first; the last entry is this week. */
	counts: number[];
	/** This week's count, as the summary reports it. */
	total: number;
}

export interface GreetingContext {
	/** Display name, already trimmed. Empty means the nameless forms are shown. */
	name: string;
	/** Stable per-user seed component — the user id, not the name. */
	userKey: string;
	/** The user's local clock. */
	now: Date;
	/** Interface language, so the picker can render what the page will render. */
	language: "en" | "hu";
	/** False until /api/home/summary lands; keeps summary-fed groups out. */
	summaryLoaded: boolean;
	week: GreetingWeekInput;
	running: { kind: "atlas" | "file" } | null;
	/** Title of the most recently touched conversation, if any. */
	topTitle: string | null;
	/** Provider ids of the user's connected accounts. */
	connectedKinds: string[];
	/** True on the first load of a new calendar day for this user. */
	firstVisitToday: boolean;
	/** Yesterday's line, which today's pick must avoid. */
	excludeKey: string | null;
	translate: (key: I18nKey, params?: Record<string, string>) => string;
}

export interface GreetingVariant {
	/** Stable id. This is what is remembered so tomorrow does not repeat it. */
	key: string;
	group: GreetingGroup;
	/** The form carrying {name}. */
	named: I18nKey;
	/** The form without it — what the 390px layout shows instead. */
	plain: I18nKey;
	/** True when the line interpolates {topic} and must be length-fitted. */
	topic?: true;
	/** Absent on generic lines; otherwise the line's whole reason to exist. */
	match?: (facts: GreetingFacts) => boolean;
}

export interface GreetingFacts {
	timeOfDay: GreetingTimeOfDay;
	/** 0 = Sunday, as Date#getDay reports it. */
	weekday: number;
	weekShape: GreetingWeekShape;
	/**
	 * Whether /api/home/summary has answered. Every group the summary feeds —
	 * the week's shape, continuity, the running job, connected accounts — is
	 * gated on it, so the first paint can never assert something about the
	 * user's week on the strength of EMPTY_HOME_SUMMARY.
	 */
	summaryLoaded: boolean;
	running: { kind: "atlas" | "file" } | null;
	hasTopic: boolean;
	connectedCount: number;
	firstVisitToday: boolean;
}

export interface PickedGreeting {
	key: string;
	group: GreetingGroup;
	/** Rendered line with the name in it. */
	named: string;
	/** Rendered line without it. */
	plain: string;
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/**
 * Thirty-eight lines in nine groups. Declaration order is the tie-break order
 * of the weighted pick, so entries are never reordered casually — a shuffle
 * here changes which line a given user sees on a given afternoon.
 */
export const GREETING_POOL: readonly GreetingVariant[] = [
	// Generic — the eight that are always eligible.
	g("generic.help"),
	g("generic.mind"),
	g("generic.ready"),
	g("generic.work"),
	g("generic.ask"),
	g("generic.start"),
	g("generic.listening"),
	g("generic.where"),

	// Time of day.
	c("time.morning", "time", (f) => f.timeOfDay === "morning"),
	c("time.earlyStart", "time", (f) => f.timeOfDay === "morning"),
	c("time.afternoon", "time", (f) => f.timeOfDay === "afternoon"),
	c("time.midday", "time", (f) => f.timeOfDay === "afternoon"),
	c("time.evening", "time", (f) => f.timeOfDay === "evening"),
	c("time.eveningWrap", "time", (f) => f.timeOfDay === "evening"),
	c("time.lateOne", "time", (f) => f.timeOfDay === "night"),
	c("time.stillUp", "time", (f) => f.timeOfDay === "night"),

	// Weekday.
	c("weekday.monday", "weekday", (f) => f.weekday === 1),
	c("weekday.midweek", "weekday", (f) => f.weekday >= 2 && f.weekday <= 4),
	c("weekday.wednesday", "weekday", (f) => f.weekday === 3),
	c("weekday.friday", "weekday", (f) => f.weekday === 5),
	c("weekday.weekend", "weekday", (f) => f.weekday === 0 || f.weekday === 6),

	// The week's shape. Both need the summary.
	c("quiet.soFar", "quiet", (f) => f.summaryLoaded && f.weekShape === "quiet"),
	c(
		"quiet.slowStart",
		"quiet",
		(f) => f.summaryLoaded && f.weekShape === "quiet",
	),
	c(
		"quiet.beenAWhile",
		"quiet",
		(f) => f.summaryLoaded && f.weekShape === "quiet",
	),
	c(
		"busy.whereWereWe",
		"busy",
		(f) => f.summaryLoaded && f.weekShape === "busy",
	),
	c("busy.moving", "busy", (f) => f.summaryLoaded && f.weekShape === "busy"),
	c(
		"busy.plentyDone",
		"busy",
		(f) => f.summaryLoaded && f.weekShape === "busy",
	),

	// Continuity — the only lines that interpolate something the user wrote.
	topical("continuity.backTo"),
	topical("continuity.stillOn"),
	topical("continuity.leftOpen"),

	// A job still in flight.
	c(
		"running.report",
		"running",
		(f) => f.summaryLoaded && f.running?.kind === "atlas",
	),
	c(
		"running.file",
		"running",
		(f) => f.summaryLoaded && f.running?.kind === "file",
	),
	c("running.any", "running", (f) => f.summaryLoaded && f.running !== null),

	// First load of the day. The only context group the summary does not feed,
	// so it is available on the first paint.
	c("firstVisit.firstToday", "firstVisit", (f) => f.firstVisitToday),
	c("firstVisit.plan", "firstVisit", (f) => f.firstVisitToday),
	c("firstVisit.newDay", "firstVisit", (f) => f.firstVisitToday),

	// Connected accounts.
	c(
		"connections.ready",
		"connections",
		(f) => f.summaryLoaded && f.connectedCount >= 2,
	),
	c(
		"connections.reach",
		"connections",
		(f) => f.summaryLoaded && f.connectedCount >= 1,
	),
];

function g(key: string): GreetingVariant {
	return {
		key,
		group: "generic",
		named: `landing.${key}.named` as I18nKey,
		plain: `landing.${key}.plain` as I18nKey,
	};
}

function c(
	key: string,
	group: GreetingGroup,
	match: (facts: GreetingFacts) => boolean,
): GreetingVariant {
	return {
		key,
		group,
		named: `landing.${key}.named` as I18nKey,
		plain: `landing.${key}.plain` as I18nKey,
		match,
	};
}

function topical(key: string): GreetingVariant {
	return {
		key,
		group: "continuity",
		named: `landing.${key}.named` as I18nKey,
		plain: `landing.${key}.plain` as I18nKey,
		topic: true,
		match: (f) => f.summaryLoaded && f.hasTopic,
	};
}

// ---------------------------------------------------------------------------
// Reading the context
// ---------------------------------------------------------------------------

export function timeOfDayFor(hour: number): GreetingTimeOfDay {
	if (hour >= 5 && hour < 12) return "morning";
	if (hour >= 12 && hour < 18) return "afternoon";
	if (hour >= 18 && hour < 23) return "evening";
	return "night";
}

/** The local calendar day, as the seed and the visit memory both key on it. */
export function dayKeyFor(now: Date): string {
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Quiet, busy, or neither.
 *
 * The two absolutes carry a new account, where there is no history to compare
 * against; the median of the past weeks carries everyone else, so a user whose
 * normal week is forty messages still gets "quiet week" at eight. Weeks with
 * no history at all (`counts` empty — the summary draws no bars) are "steady":
 * telling someone their first week has been quiet is not an observation.
 */
export function classifyWeek(week: GreetingWeekInput): GreetingWeekShape {
	if (week.counts.length === 0) return "steady";
	if (week.total <= GREETING_QUIET_ABSOLUTE) return "quiet";
	if (week.total >= GREETING_BUSY_ABSOLUTE) return "busy";

	const past = week.counts.slice(0, -1);
	if (past.length < GREETING_BASELINE_MIN_WEEKS) return "steady";
	const sorted = [...past].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? (sorted[middle - 1] + sorted[middle]) / 2
			: sorted[middle];
	if (median <= 0) return "steady";
	if (week.total * 2 <= median) return "quiet";
	if (week.total >= median * 1.5) return "busy";
	return "steady";
}

export function greetingFactsFor(context: GreetingContext): GreetingFacts {
	return {
		timeOfDay: timeOfDayFor(context.now.getHours()),
		weekday: context.now.getDay(),
		weekShape: classifyWeek(context.week),
		summaryLoaded: context.summaryLoaded,
		running: context.running,
		hasTopic: Boolean(context.topTitle?.trim()),
		connectedCount: context.connectedKinds.length,
		firstVisitToday: context.firstVisitToday,
	};
}

// ---------------------------------------------------------------------------
// Fitting a conversation title into the line
// ---------------------------------------------------------------------------

/**
 * Cuts a recent conversation title down until the rendered line fits one row.
 *
 * Six words first, because a title is a sentence and the first six words of it
 * are the subject; then whole words off the end; then, only if a single word
 * is still too long, a hard cut with an ellipsis. Returns null when there is no
 * room left worth using — the caller drops the variant instead of printing a
 * stub.
 */
export function fitTopic(
	title: string,
	render: (topic: string) => string,
	max = GREETING_MAX_LINE_CHARS,
): string | null {
	const cleaned = title.replace(/\s+/g, " ").trim();
	if (cleaned === "") return null;

	const words = cleaned.split(" ").slice(0, GREETING_TOPIC_MAX_WORDS);
	for (let count = words.length; count >= 1; count -= 1) {
		const candidate = words.slice(0, count).join(" ");
		// A two-word title cut to "The" is not a topic. Short titles are exempt:
		// "Taxes" is the whole thing the user named, not a fragment of it.
		if (candidate.length < GREETING_TOPIC_MIN_CHARS && candidate !== cleaned) {
			continue;
		}
		if (render(candidate).length <= max) return candidate;
	}

	// Nothing survives on a word boundary. Measure the line with the topic
	// removed — rather than guessing at the template — and give the title
	// whatever room is left.
	const overhead = render("").length;
	const budget = max - overhead - 1; // the ellipsis costs one
	if (budget < GREETING_TOPIC_MIN_CHARS) return null;
	return `${cleaned.slice(0, budget).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit, with an avalanche finaliser. Small, stable across engines,
 * and emphatically not a hash for secrets.
 *
 * The finaliser is not decoration. Raw FNV-1a moves by a fixed multiple of the
 * prime when only the last byte of the input changes, so seed keys that differ
 * in one character — two user ids from the same sequence, or the same user on
 * consecutive days — land a fixed stride apart after the modulo and can keep
 * picking the same line. Mixing the bits down first makes neighbouring keys
 * independent, which is what "different users get different greetings" rests
 * on.
 */
export function greetingSeed(input: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x7feb352d) >>> 0;
	hash ^= hash >>> 15;
	hash = Math.imul(hash, 0x846ca68b) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/**
 * What the pick is keyed on, exported so a test can assert it directly.
 *
 * User, calendar day and time-of-day slot are the three the design asks for.
 * The language is a fourth because the pools are not translations of each
 * other line for line — switching the interface language is a good moment for
 * a fresh draw rather than the same key rendered in the other tongue.
 */
export function greetingSeedKey(context: GreetingContext): string {
	return `${context.userKey}|${dayKeyFor(context.now)}|${timeOfDayFor(
		context.now.getHours(),
	)}|${context.language}`;
}

interface Candidate {
	variant: GreetingVariant;
	weight: number;
	topic: string | null;
}

function candidatesFor(context: GreetingContext): Candidate[] {
	const facts = greetingFactsFor(context);
	const title = context.topTitle?.trim() ?? "";
	const candidates: Candidate[] = [];

	for (const variant of GREETING_POOL) {
		if (variant.match && !variant.match(facts)) continue;

		let topic: string | null = null;
		if (variant.topic) {
			// Fit against the form the page will actually show: with a name, the
			// named line is the long one; without, the plain line is all there is.
			const key = context.name ? variant.named : variant.plain;
			topic = fitTopic(title, (value) =>
				context.translate(key, { name: context.name, topic: value }),
			);
			if (topic === null) continue;
		}

		candidates.push({
			variant,
			weight: variant.match ? GREETING_CONTEXT_WEIGHT : GREETING_GENERIC_WEIGHT,
			topic,
		});
	}

	return candidates;
}

function weightedPick(candidates: Candidate[], seed: number): Candidate {
	const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
	let cursor = seed % total;
	for (const candidate of candidates) {
		if (cursor < candidate.weight) return candidate;
		cursor -= candidate.weight;
	}
	return candidates[candidates.length - 1];
}

/**
 * One line, chosen once per (user, day, time-of-day slot).
 *
 * `excludeKey` is yesterday's line. It is removed before the pick rather than
 * re-rolled after it, so the result stays a single deterministic draw — a
 * re-roll would make the line depend on how many times the page had been
 * opened, which is exactly what this is trying to stop.
 */
export function pickGreeting(context: GreetingContext): PickedGreeting {
	// candidatesFor always yields the eight generic lines — they carry no
	// `match` — so `all` is never empty, and dropping one key cannot empty it.
	const all = candidatesFor(context);
	const kept = all.filter((entry) => entry.variant.key !== context.excludeKey);
	const eligible = kept.length > 0 ? kept : all;

	const chosen = weightedPick(eligible, greetingSeed(greetingSeedKey(context)));
	const params: Record<string, string> = { name: context.name };
	if (chosen.topic !== null) params.topic = chosen.topic;

	return {
		key: chosen.variant.key,
		group: chosen.variant.group,
		named: context.translate(chosen.variant.named, params),
		plain: context.translate(chosen.variant.plain, params),
	};
}

// ---------------------------------------------------------------------------
// What the browser remembers between days
// ---------------------------------------------------------------------------

export const GREETING_MEMORY_STORAGE_KEY = "alfy.home.greeting";

export interface GreetingMemory {
	/** The local calendar day the remembered line was shown on. */
	day: string;
	/**
	 * The time-of-day slot the day's FIRST visit landed in — not the slot of
	 * the most recent one. This is what makes "First one today" survive a
	 * reload: see resolveGreetingMemory.
	 */
	firstSlot: GreetingTimeOfDay;
	/** The variant key shown that day. */
	key: string;
}

export interface ResolvedGreetingMemory {
	firstVisitToday: boolean;
	excludeKey: string | null;
	/** Carried back into the next write so the day's first slot survives. */
	firstSlot: GreetingTimeOfDay;
}

function defaultStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * Reads the last line shown and the day it was shown on.
 *
 * Every failure mode here — no storage, quota, a private window that throws on
 * read, a value someone else wrote — resolves to null, which the caller reads
 * as "first visit, nothing to avoid". That is the correct degradation: the
 * greeting is still picked, it just cannot promise it differs from yesterday's.
 */
export function readGreetingMemory(
	storage: Storage | null = defaultStorage(),
): GreetingMemory | null {
	try {
		const raw = storage?.getItem(GREETING_MEMORY_STORAGE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const { day, firstSlot, key } = parsed as Record<string, unknown>;
		if (typeof day !== "string" || typeof key !== "string") return null;
		if (!GREETING_TIME_OF_DAY.includes(firstSlot as GreetingTimeOfDay)) {
			return null;
		}
		return { day, firstSlot: firstSlot as GreetingTimeOfDay, key };
	} catch {
		return null;
	}
}

export function writeGreetingMemory(
	memory: GreetingMemory,
	storage: Storage | null = defaultStorage(),
): void {
	try {
		storage?.setItem(GREETING_MEMORY_STORAGE_KEY, JSON.stringify(memory));
	} catch {
		// A greeting is not worth an exception.
	}
}

/**
 * Turns what the browser remembers into what the picker needs from it.
 *
 * Two rules, and the second one is subtler than it looks:
 *
 * `excludeKey` only applies ACROSS days. Within one day the remembered key IS
 * today's line, and excluding it would hand a different greeting to every
 * reload — the opposite of the point.
 *
 * `firstVisitToday` holds for the whole time-of-day slot the day's first visit
 * landed in, not for one page load. A naive "have I been here today" flag
 * breaks the determinism the rest of this module is built on: the first load
 * of the day would draw from a pool containing "First one today", and the
 * second load, ten minutes later, would draw from a pool without it and print
 * something else. Tying it to the slot keeps the line stable across reloads
 * and still stops it being claimed in the afternoon, because the slot has
 * moved on by then and the seed has moved with it.
 */
export function resolveGreetingMemory(
	memory: GreetingMemory | null,
	today: string,
	slot: GreetingTimeOfDay,
): ResolvedGreetingMemory {
	if (!memory || memory.day !== today) {
		return {
			firstVisitToday: true,
			excludeKey: memory?.key ?? null,
			firstSlot: slot,
		};
	}
	return {
		firstVisitToday: memory.firstSlot === slot,
		excludeKey: null,
		firstSlot: memory.firstSlot,
	};
}
