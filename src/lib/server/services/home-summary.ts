// Everything the chat home (HomeV4A "Compact") reads, in one per-user payload:
// the twelve weekly bars and the week's count, the three most recent
// conversations, the one job in flight, and the Try suggestion pool.
//
// All four strips are read-only, per user, and small. The whole thing is cached
// for 30 seconds per user, which is the point of assembling it here rather than
// letting the home screen fan out to four endpoints.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import chatDict from "$lib/i18n/chat";
import { db } from "$lib/server/db";
import {
	atlasJobs,
	conversations,
	fileProductionJobs,
	messages,
	usageEvents,
	users,
} from "$lib/server/db/schema";
import {
	getHomeSuggestions,
	type HomeSuggestion,
	type HomeSuggestionLocale,
	recordHomeSuggestionsShown,
} from "$lib/server/services/home-suggestions";

export const HOME_SUMMARY_DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * How long a user's assembled summary is held.
 *
 * Configurable rather than constant so an environment that writes the
 * underlying rows out-of-band — the e2e suite seeds conversations and jobs
 * straight into SQLite, behind this process's back — can run with the cache
 * off and still see what it just wrote. Unset means the 30 seconds the screen
 * is designed around.
 */
export function homeSummaryCacheTtlMs(): number {
	const raw = process.env.HOME_SUMMARY_CACHE_TTL_MS;
	if (raw === undefined) return HOME_SUMMARY_DEFAULT_CACHE_TTL_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: HOME_SUMMARY_DEFAULT_CACHE_TTL_MS;
}

export const HOME_WEEKLY_BAR_COUNT = 12;
export const HOME_RECENT_LIMIT = 3;

export interface HomeWeeklyBucket {
	/** ISO week label, e.g. "2026-W37". */
	isoWeek: string;
	/** Monday 00:00 of that week in the reporting zone, epoch seconds. */
	startedAt: number;
	count: number;
}

export interface HomeRecentConversation {
	id: string;
	title: string;
	updatedAt: number;
	messageCount: number;
	/** True when an Atlas run in this conversation produced a report. */
	atlasFinished: boolean;
}

export interface HomeRunningJob {
	id: string;
	kind: "atlas" | "file";
	conversationId: string;
	title: string;
	/** The stage in words, already translated. */
	phase: string;
	progressPercent: number;
	startedAt: number;
}

export interface HomeSummary {
	weekly: HomeWeeklyBucket[];
	weeklyTotal: number;
	recent: HomeRecentConversation[];
	running: HomeRunningJob | null;
	suggestions: HomeSuggestion[];
	generatedAt: number;
}

// ---------------------------------------------------------------------------
// Weekly bucketing
// ---------------------------------------------------------------------------

/**
 * The zone every home figure is computed in. There is no per-user timezone
 * column in this schema, so "the server's configured timezone" is the process
 * zone (TZ / the host's), resolved once per call so a test can pass its own.
 */
export function reportingTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(instant);
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value ?? "0");
	// en-US renders midnight as "24" in some ICU versions.
	const hour = get("hour");
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: hour === 24 ? 0 : hour,
		minute: get("minute"),
		second: get("second"),
	};
}

/**
 * The UTC instant at which the given wall-clock time occurs in `timeZone`.
 *
 * Solved rather than looked up: guess the instant as if the wall clock were
 * UTC, measure how far that lands from the target in the zone, correct, and
 * measure once more. Two passes settle every real zone including the hour a
 * DST transition adds or removes — and on a spring-forward gap (a local
 * midnight that does not exist, which no European zone has but some do) the
 * second pass lands on the instant the clock jumps to, which is the correct
 * start of that day.
 */
function instantForZonedWallClock(
	wall: { year: number; month: number; day: number },
	timeZone: string,
): Date {
	const target = Date.UTC(wall.year, wall.month - 1, wall.day, 0, 0, 0);
	let guess = target;
	for (let pass = 0; pass < 2; pass += 1) {
		const seen = zonedParts(new Date(guess), timeZone);
		const seenAsUtc = Date.UTC(
			seen.year,
			seen.month - 1,
			seen.day,
			seen.hour,
			seen.minute,
			seen.second,
		);
		const drift = seenAsUtc - target;
		if (drift === 0) return new Date(guess);
		guess -= drift;
	}
	return new Date(guess);
}

/** 1 = Monday … 7 = Sunday, in the reporting zone. */
function isoWeekday(instant: Date, timeZone: string): number {
	const name = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
	}).format(instant);
	const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name);
	return index === -1 ? 1 : index + 1;
}

/**
 * Monday 00:00 of the ISO week containing `instant`, as a UTC instant, with
 * week boundaries drawn in `timeZone` rather than in UTC. A Sunday 23:30 event
 * belongs to the week that is ending, not to the one about to start.
 */
export function isoWeekStart(instant: Date, timeZone: string): Date {
	const weekday = isoWeekday(instant, timeZone);
	const local = zonedParts(instant, timeZone);
	const midnight = instantForZonedWallClock(local, timeZone);
	// Stepping back in whole days from local midnight and re-solving keeps the
	// result at midnight across a DST change inside the week.
	const back = new Date(midnight.getTime() - (weekday - 1) * 86_400_000);
	const backLocal = zonedParts(back, timeZone);
	return instantForZonedWallClock(backLocal, timeZone);
}

/** The ISO-8601 week label ("2026-W37") of the week starting at `weekStart`. */
export function isoWeekLabel(weekStart: Date, timeZone: string): string {
	// ISO: the week's Thursday decides which year the week belongs to.
	const thursday = new Date(weekStart.getTime() + 3 * 86_400_000);
	const thursdayLocal = zonedParts(thursday, timeZone);
	const yearStart = Date.UTC(thursdayLocal.year, 0, 1);
	const thursdayUtc = Date.UTC(
		thursdayLocal.year,
		thursdayLocal.month - 1,
		thursdayLocal.day,
	);
	const dayOfYear = Math.round((thursdayUtc - yearStart) / 86_400_000) + 1;
	const week = Math.ceil(dayOfYear / 7);
	return `${thursdayLocal.year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Twelve consecutive ISO weeks ending with the week that contains `now`, each
 * carrying how many of the given turn timestamps fell inside it.
 *
 * A week with no turns is a bucket with a zero count, not a missing bucket —
 * the board draws it as a 1px tick, and dropping it would silently compress the
 * timeline.
 */
export function bucketWeeklyCounts(params: {
	/** Turn timestamps, epoch milliseconds, in any order. */
	timestampsMs: number[];
	now: Date;
	timeZone: string;
	weeks?: number;
}): HomeWeeklyBucket[] {
	const weeks = params.weeks ?? HOME_WEEKLY_BAR_COUNT;
	const currentStart = isoWeekStart(params.now, params.timeZone);

	const starts: Date[] = [currentStart];
	for (let i = 1; i < weeks; i += 1) {
		const previous = starts[0];
		if (!previous) break;
		// Step back 7 days and re-solve, so a DST change inside the window
		// cannot walk the boundary off midnight.
		starts.unshift(
			isoWeekStart(
				new Date(previous.getTime() - 4 * 86_400_000),
				params.timeZone,
			),
		);
	}

	const buckets: HomeWeeklyBucket[] = starts.map((start) => ({
		isoWeek: isoWeekLabel(start, params.timeZone),
		startedAt: Math.floor(start.getTime() / 1000),
		count: 0,
	}));

	const windowStart = starts[0]?.getTime() ?? 0;
	for (const timestamp of params.timestampsMs) {
		if (timestamp < windowStart) continue;
		// Walk from the newest bucket down: the newest weeks hold most of the
		// rows, so this is a handful of comparisons per turn.
		for (let i = buckets.length - 1; i >= 0; i -= 1) {
			const bucket = buckets[i];
			if (!bucket) continue;
			if (timestamp >= bucket.startedAt * 1000) {
				bucket.count += 1;
				break;
			}
		}
	}
	return buckets;
}

// ---------------------------------------------------------------------------
// The running job's phase, in words
// ---------------------------------------------------------------------------

type PhraseKey = keyof (typeof chatDict)["en"];

/**
 * v2 and v3 pipeline phases mapped onto the i18n labels that already exist.
 * v3 named four phases v2 never had (`ask`, `outline`, `answer`, `critic`); each
 * takes the existing label closest to what it does rather than inventing a
 * string the rest of the app does not use.
 */
const PHASE_LABEL_KEYS: Record<string, PhraseKey> = {
	plan: "atlasActivity.phase.plan",
	ask: "atlasActivity.phase.plan",
	outline: "atlasActivity.phase.plan",
	research: "atlasActivity.phase.research",
	index: "atlasActivity.phase.index",
	answer: "atlasActivity.phase.write",
	write: "atlasActivity.phase.write",
	critic: "atlasActivity.phase.verify",
	verify: "atlasActivity.phase.verify",
	render: "atlasActivity.phase.render",
};

/** v1 pipeline stages, the same map AtlasActivityBody uses. */
const STAGE_LABEL_KEYS: Record<string, PhraseKey> = {
	decompose: "atlas.stage.decompose",
	search: "atlas.stage.search",
	curate: "atlas.stage.curate",
	"coverage-review": "atlas.stage.coverageReview",
	"gap-fill": "atlas.stage.gapFill",
	synthesize: "atlas.stage.synthesize",
	integrate: "atlas.stage.integrate",
	assemble: "atlas.stage.assemble",
	audit: "atlas.stage.audit",
	render: "atlas.stage.render",
};

function label(locale: HomeSuggestionLocale, key: PhraseKey): string {
	const table = chatDict[locale] ?? chatDict.en;
	return (
		(table as Record<string, string>)[key] ??
		(chatDict.en as Record<string, string>)[key] ??
		key
	);
}

/**
 * Resolves the running job's stage into words.
 *
 * The phase comes from `progress_details_json` — the pipeline's own account of
 * where it is — and only falls through to the raw `stage` column when a job
 * predates the phase field (v1) or the JSON is unreadable. Reading `stage`
 * first would show "Curating sources" for a v2/v3 job that is already writing,
 * because those pipelines stopped moving the column.
 */
export function resolveRunningJobPhase(params: {
	status: string;
	stage: string | null;
	progressDetailsJson: string | null;
	locale: HomeSuggestionLocale;
}): string {
	const { locale } = params;
	if (params.status === "queued") return label(locale, "atlas.stage.queued");

	let phase: string | null = null;
	if (params.progressDetailsJson) {
		try {
			const parsed: unknown = JSON.parse(params.progressDetailsJson);
			if (parsed && typeof parsed === "object") {
				const candidate = (parsed as { phase?: unknown }).phase;
				if (typeof candidate === "string" && candidate.length > 0) {
					phase = candidate;
				}
			}
		} catch {
			// A job whose details never parsed still has a stage column.
		}
	}

	const phaseKey = phase ? PHASE_LABEL_KEYS[phase] : undefined;
	if (phaseKey) return label(locale, phaseKey);

	const stageKey = params.stage ? STAGE_LABEL_KEYS[params.stage] : undefined;
	if (stageKey) return label(locale, stageKey);

	return label(locale, "atlas.stage.running");
}

/**
 * A file-production job has no phases and its `stage` column is never written,
 * so the only honest thing to say is whether it is waiting or rendering.
 */
export function resolveFileJobPhase(params: {
	status: string;
	locale: HomeSuggestionLocale;
}): string {
	if (params.status === "queued") {
		return label(params.locale, "atlas.stage.queued");
	}
	return label(params.locale, "atlasActivity.phase.render");
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/**
 * The user's turns over the trailing twelve ISO weeks.
 *
 * `usage_events` is the honest per-turn source here: exactly one row per
 * completed assistant turn (unique on `message_id`), already carrying `user_id`
 * so no join to `conversations` is needed, and now indexed on
 * `(user_id, created_at)` for this window. `messages` would double-count (a
 * user row and an assistant row per turn) and would need the join.
 *
 * The honest limit: a turn that never reached a model — an import, or a turn
 * that failed before usage was recorded — has no usage row and so is not
 * counted. The bars are "turns the assistant answered", not "rows in messages".
 */
async function readWeekly(
	userId: string,
	now: Date,
	timeZone: string,
): Promise<HomeWeeklyBucket[]> {
	const windowStart = isoWeekStart(
		new Date(now.getTime() - (HOME_WEEKLY_BAR_COUNT - 1) * 7 * 86_400_000),
		timeZone,
	);
	const rows = await db
		.select({ createdAt: usageEvents.createdAt })
		.from(usageEvents)
		.where(
			and(
				eq(usageEvents.userId, userId),
				gte(usageEvents.createdAt, windowStart),
			),
		);
	// An empty week inside a used window is a 1px tick, because a gap there
	// would read as a missing week. An empty WINDOW is not twelve ticks — it is
	// no record at all, and drawing "0 this week" beside twelve grey marks
	// would be the home screen inventing history a new user does not have.
	if (rows.length === 0) return [];
	return bucketWeeklyCounts({
		timestampsMs: rows.map((row) => row.createdAt.getTime()),
		now,
		timeZone,
	});
}

async function readRecent(userId: string): Promise<HomeRecentConversation[]> {
	// Over-fetch: a conversation with no messages is not shown (it is a
	// prepared-but-unused landing draft), and the count is what reveals that.
	const candidates = await db
		.select({
			id: conversations.id,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
		})
		.from(conversations)
		.where(eq(conversations.userId, userId))
		.orderBy(desc(conversations.updatedAt))
		.limit(HOME_RECENT_LIMIT * 4);
	if (candidates.length === 0) return [];

	const ids = candidates.map((row) => row.id);
	const [counts, atlasRows] = await Promise.all([
		db
			.select({
				conversationId: messages.conversationId,
				count: sql<number>`count(*)`,
			})
			.from(messages)
			.where(inArray(messages.conversationId, ids))
			.groupBy(messages.conversationId),
		db
			.select({ conversationId: atlasJobs.conversationId })
			.from(atlasJobs)
			.where(
				and(
					eq(atlasJobs.userId, userId),
					eq(atlasJobs.status, "succeeded"),
					inArray(atlasJobs.conversationId, ids),
				),
			),
	]);

	const countById = new Map(
		counts.map((row) => [row.conversationId, Number(row.count)]),
	);
	const atlasIds = new Set(atlasRows.map((row) => row.conversationId));

	return candidates
		.map((row) => ({
			id: row.id,
			title: row.title,
			updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
			messageCount: countById.get(row.id) ?? 0,
			atlasFinished: atlasIds.has(row.id),
		}))
		.filter((row) => row.messageCount > 0)
		.slice(0, HOME_RECENT_LIMIT);
}

/**
 * The one job in flight, if there is one. Atlas wins a tie because it is the
 * longer-running of the two and the one whose progress is worth watching.
 */
async function readRunning(
	userId: string,
	locale: HomeSuggestionLocale,
): Promise<HomeRunningJob | null> {
	const [atlasRow] = await db
		.select({
			id: atlasJobs.id,
			conversationId: atlasJobs.conversationId,
			title: atlasJobs.title,
			status: atlasJobs.status,
			stage: atlasJobs.stage,
			progressPercent: atlasJobs.progressPercent,
			progressDetailsJson: atlasJobs.progressDetailsJson,
			startedAt: atlasJobs.startedAt,
			createdAt: atlasJobs.createdAt,
		})
		.from(atlasJobs)
		.where(
			and(
				eq(atlasJobs.userId, userId),
				inArray(atlasJobs.status, ["queued", "running"]),
			),
		)
		.orderBy(desc(atlasJobs.createdAt))
		.limit(1);

	if (atlasRow) {
		return {
			id: atlasRow.id,
			kind: "atlas",
			conversationId: atlasRow.conversationId,
			title: atlasRow.title,
			phase: resolveRunningJobPhase({
				status: atlasRow.status,
				stage: atlasRow.stage,
				progressDetailsJson: atlasRow.progressDetailsJson,
				locale,
			}),
			progressPercent: Math.max(0, Math.min(100, atlasRow.progressPercent)),
			startedAt: Math.floor(
				(atlasRow.startedAt ?? atlasRow.createdAt).getTime() / 1000,
			),
		};
	}

	const [fileRow] = await db
		.select({
			id: fileProductionJobs.id,
			conversationId: fileProductionJobs.conversationId,
			title: fileProductionJobs.title,
			status: fileProductionJobs.status,
			createdAt: fileProductionJobs.createdAt,
		})
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, userId),
				inArray(fileProductionJobs.status, ["queued", "running"]),
			),
		)
		.orderBy(desc(fileProductionJobs.createdAt))
		.limit(1);

	if (!fileRow) return null;
	return {
		id: fileRow.id,
		kind: "file",
		conversationId: fileRow.conversationId,
		title: fileRow.title,
		phase: resolveFileJobPhase({ status: fileRow.status, locale }),
		// File production reports no percentage; the track shows the two states
		// it does know rather than a number it would have to invent.
		progressPercent: fileRow.status === "queued" ? 0 : 50,
		startedAt: Math.floor(fileRow.createdAt.getTime() / 1000),
	};
}

// ---------------------------------------------------------------------------
// Assembly + the 30-second per-user cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { expiresAt: number; value: HomeSummary }>();

/** Test seam. */
export function clearHomeSummaryCache(): void {
	cache.clear();
}

async function computeHomeSummary(
	userId: string,
	now: Date,
): Promise<HomeSummary> {
	const [userRow] = await db
		.select({ uiLanguage: users.uiLanguage })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const locale: HomeSuggestionLocale =
		userRow?.uiLanguage === "hu" ? "hu" : "en";
	const timeZone = reportingTimeZone();

	const [weekly, recent, running, suggestions] = await Promise.all([
		readWeekly(userId, now, timeZone),
		readRecent(userId),
		readRunning(userId, locale),
		getHomeSuggestions({ userId, locale, now }),
	]);

	return {
		weekly,
		weeklyTotal: weekly.at(-1)?.count ?? 0,
		recent,
		running,
		suggestions,
		generatedAt: Math.floor(now.getTime() / 1000),
	};
}

export async function getHomeSummary(params: {
	userId: string;
	now?: Date;
}): Promise<HomeSummary> {
	const now = params.now ?? new Date();
	const cached = cache.get(params.userId);
	if (cached && cached.expiresAt > now.getTime()) return cached.value;

	const value = await computeHomeSummary(params.userId, now);
	cache.set(params.userId, {
		expiresAt: now.getTime() + homeSummaryCacheTtlMs(),
		value,
	});

	// Only on a miss: a client polling the summary must not be able to turn the
	// rail into a write endpoint. Best effort — the home screen must render
	// even if this fails.
	void recordHomeSuggestionsShown({
		userId: params.userId,
		candidateKeys: value.suggestions.slice(0, 3).map((s) => s.key),
		now,
	}).catch(() => undefined);

	return value;
}

/** Drops one user's cached summary, e.g. after they act on a suggestion. */
export function invalidateHomeSummary(userId: string): void {
	cache.delete(userId);
}
