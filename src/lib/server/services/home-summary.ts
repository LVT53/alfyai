// Everything the chat home (HomeV4A "Compact") reads, in one per-user payload:
// the twelve weekly bars and the week's count, the three most recent
// conversations, the cards for the projects that have been active, and the one
// job in flight.
//
// All of it is read-only, per user, and small. The whole thing is cached for 30
// seconds per user, which is the point of assembling it here rather than letting
// the home screen fan out to several endpoints.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import chatDict from "$lib/i18n/chat";
import { db } from "$lib/server/db";
import {
	atlasJobs,
	conversations,
	fileProductionJobs,
	memoryReviewItems,
	messages,
	users,
} from "$lib/server/db/schema";
import { listProjectKnowledge } from "$lib/server/services/knowledge/project-knowledge";
import { isUserMemoryEnabled } from "$lib/server/services/memory-controls";
import { getMemoryProfileReadModel } from "$lib/server/services/memory-profile/read-model";
import { listRecentlyActiveProjects } from "$lib/server/services/projects";

/**
 * The two languages the home figures are rendered into.
 *
 * It used to be re-exported from the suggestion engine, which owned the same
 * pair because it rendered suggestion templates server-side. The engine is
 * gone; the need to pick a label language is not, so the type lives here now,
 * next to the only code that uses it.
 */
export type HomeSummaryLocale = "en" | "hu";

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
/** The projects row's three columns, and its three cards. */
export const HOME_PROJECTS_LIMIT = 3;

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

/**
 * One card in the home projects row.
 *
 * Every field is already stored: `listRecentlyActiveProjects` supplies the name,
 * colour, chat count, last activity and whether the project has instructions,
 * and `listProjectKnowledge` supplies the file count. Nothing here is derived
 * for the card's sake — in particular it does NOT carry the instruction text,
 * only whether there is any.
 */
export interface HomeProjectCard {
	id: string;
	name: string;
	color: string | null;
	chatCount: number;
	/** Unix seconds. */
	lastActivityAt: number;
	hasInstructions: boolean;
	fileCount: number;
}

export interface HomeSummary {
	weekly: HomeWeeklyBucket[];
	weeklyTotal: number;
	recent: HomeRecentConversation[];
	running: HomeRunningJob | null;
	/**
	 * The projects worth showing, newest activity first, at most
	 * `HOME_PROJECTS_LIMIT` of them. The eligibility rule — at least one chat
	 * that has carried a message — belongs to `listRecentlyActiveProjects` and
	 * is not re-applied anywhere: an empty project is not "recently active", and
	 * a second copy of that predicate is a second thing to keep true.
	 */
	projects: HomeProjectCard[];
	/**
	 * How many open Memory Profile review items this user has, straight from
	 * the same read model the Knowledge → Memory tab's badge uses
	 * (`getMemoryProfileReadModel(...).review.openCount`) — never a second
	 * definition of "needs review". Forced to 0 when the user's memory master
	 * toggle is off, even though the read model itself does not zero it.
	 */
	memoryReviewCount: number;
	/**
	 * True when the user dismissed the home notice at or after the newest open
	 * review item's creation time — i.e. nothing NEW has shown up since they
	 * dismissed it. False (never dismissed, or a newer item has since arrived)
	 * means the notice should show again.
	 */
	memoryReviewNoticeDismissed: boolean;
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
	//
	// The Thursday is reached on the CALENDAR, not by adding three times
	// 86,400,000 milliseconds: an hour given back inside the week would land
	// that sum on Wednesday 23:00 and, in a year whose 1 January is itself a
	// Thursday, shift every week number in it down by one. `Date.UTC` carries
	// the day overflow across month and year ends for free.
	const startLocal = zonedParts(weekStart, timeZone);
	const thursdayStamp = Date.UTC(
		startLocal.year,
		startLocal.month - 1,
		startLocal.day + 3,
	);
	const thursdayYear = new Date(thursdayStamp).getUTCFullYear();
	const yearStart = Date.UTC(thursdayYear, 0, 1);
	const dayOfYear = Math.round((thursdayStamp - yearStart) / 86_400_000) + 1;
	const week = Math.ceil(dayOfYear / 7);
	return `${thursdayYear}-W${String(week).padStart(2, "0")}`;
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
 * v2 and v3 pipeline phases mapped onto their i18n labels. v3 named four
 * phases v2 never had (`ask`, `outline`, `answer`, `critic`); each has its
 * own label now (ADR 0063), the same ones AtlasActivityBody.svelte uses.
 */
const PHASE_LABEL_KEYS: Record<string, PhraseKey> = {
	plan: "atlasActivity.phase.plan",
	ask: "atlasActivity.phase.ask",
	outline: "atlasActivity.phase.outline",
	research: "atlasActivity.phase.research",
	index: "atlasActivity.phase.index",
	answer: "atlasActivity.phase.answer",
	write: "atlasActivity.phase.write",
	critic: "atlasActivity.phase.critic",
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

function label(locale: HomeSummaryLocale, key: PhraseKey): string {
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
	locale: HomeSummaryLocale;
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
	locale: HomeSummaryLocale;
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
 * The messages the USER sent, over the trailing twelve ISO weeks.
 *
 * This used to count `usage_events`, and that is what put "249 this week" in
 * front of an owner who had sent a few dozen messages. `usage_events` is a
 * BILLING ledger, not a record of what the user did: every writer in
 * analytics.ts appends to it on the user's behalf — `recordMessageAnalytics`
 * (one row per assistant turn), `recordAtlasJobAnalytics` (one per Atlas job),
 * `recordParallelUsage` (one per `research_web` / `fetch_url` call) and
 * `recordControlModelUsage`, which alone covers the thought-step classifier,
 * the rail summary, the turn acknowledgment, memory recuration, consolidation,
 * summary and judge. One user message can be a dozen rows, and a background
 * memory pass with no user in the room is rows with no user message at all.
 *
 * So the bars and the count are the user's own messages: rows in `messages`
 * with `role = 'user'`, in conversations owned by this user. Backed by
 * `messages_conversation_role_created_idx` so this stays a per-conversation
 * index range rather than a scan of the table.
 *
 * The honest limit, and it is the opposite of the old one: an IMPORTED
 * conversation's user rows count, because the user did write them somewhere.
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
		.select({ createdAt: messages.createdAt })
		.from(messages)
		.innerJoin(conversations, eq(messages.conversationId, conversations.id))
		.where(
			and(
				eq(conversations.userId, userId),
				eq(messages.role, "user"),
				gte(messages.createdAt, windowStart),
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
	// A conversation with no messages is a prepared-but-unused landing draft,
	// not a conversation the user had — filtered in SQL rather than by
	// over-fetching and discarding, because a user who abandoned a run of
	// drafts would otherwise push every real conversation out of the window and
	// see an empty Recent. `messages_conversation_order_idx` makes the EXISTS a
	// lookup, not a scan.
	const candidates = await db
		.select({
			id: conversations.id,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, userId),
				sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id})`,
			),
		)
		.orderBy(desc(conversations.updatedAt))
		.limit(HOME_RECENT_LIMIT);
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

	return candidates.map((row) => ({
		id: row.id,
		title: row.title,
		updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
		messageCount: countById.get(row.id) ?? 0,
		atlasFinished: atlasIds.has(row.id),
	}));
}

/**
 * The one job in flight, if there is one. Atlas wins a tie because it is the
 * longer-running of the two and the one whose progress is worth watching.
 */
async function readRunning(
	userId: string,
	locale: HomeSummaryLocale,
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

/**
 * The cards for the home projects row.
 *
 * Eligibility is entirely `listRecentlyActiveProjects`'s answer — this function
 * asks it for three projects and draws those three. That is the point: "a
 * project with no chats gets no card" is one rule in one place, and a home
 * screen that re-checked it would be the second place it could go wrong.
 *
 * The file counts come from `listProjectKnowledge` per project, in parallel with
 * each other and read-only on both sides (the Files modal's own list is the same
 * read), so a card can never claim a count the modal would disagree with. Only
 * the length is used; the items themselves are the modal's business.
 */
async function readProjects(userId: string): Promise<HomeProjectCard[]> {
	const projects = await listRecentlyActiveProjects({
		userId,
		limit: HOME_PROJECTS_LIMIT,
	});
	if (projects.length === 0) return [];

	return Promise.all(
		projects.map(async (project) => ({
			id: project.id,
			name: project.name,
			color: project.color,
			chatCount: project.chatCount,
			lastActivityAt: project.lastActivityAt,
			hasInstructions: project.hasInstructions,
			fileCount: (await listProjectKnowledge({ userId, projectId: project.id }))
				.length,
		})),
	);
}

/**
 * The home-screen "memories need review" notice: the same open-review count
 * the Knowledge → Memory tab badge shows, plus whether the user's own
 * dismissal still covers everything currently open.
 *
 * The count comes straight from `getMemoryProfileReadModel(...)` — the exact
 * read model the Memory tab badge uses — so this can never define "needs
 * review" a second, different way. The one thing added here is the master
 * memory toggle: the Memory tab does not zero its badge when memory is
 * disabled (existing rows just sit there), but a home-screen notice pointing
 * the user at a feature they turned off would be wrong, so this path forces
 * the count to 0 in that case.
 *
 * Dismissal is per user, not per item: `users.homeMemoryReviewDismissedAt`
 * records when the user last dismissed the notice, and it stays dismissed
 * until an open review item NEWER than that timestamp exists. A dismissal
 * does not expire on its own: there is no natural "come back after a week" for
 * this notice, only "come back when there is something new to look at".
 *
 * The "newest" lookup is scoped to the exact row ids
 * `getMemoryProfileReadModel(...)` returned — not a second, independent
 * `status = 'open'` query — so a future change to what that read model
 * considers open (e.g. excluding a review row whose affected item is no
 * longer `review_needed`) is inherited here automatically instead of having
 * to be re-applied in two places.
 */
async function readMemoryReviewNotice(
	userId: string,
	homeMemoryReviewDismissedAt: Date | null,
): Promise<{ count: number; dismissed: boolean }> {
	const enabled = await isUserMemoryEnabled(userId).catch(() => true);
	if (!enabled) return { count: 0, dismissed: true };

	const profile = await getMemoryProfileReadModel({ userId });
	const count = profile.review.openCount;
	if (count === 0) return { count: 0, dismissed: true };
	if (!homeMemoryReviewDismissedAt) return { count, dismissed: false };

	const openIds = profile.review.items.map((item) => item.id);
	const [newest] = openIds.length
		? await db
				.select({ createdAt: memoryReviewItems.createdAt })
				.from(memoryReviewItems)
				.where(inArray(memoryReviewItems.id, openIds))
				.orderBy(desc(memoryReviewItems.createdAt))
				.limit(1)
		: [];

	const dismissed =
		!newest?.createdAt ||
		homeMemoryReviewDismissedAt.getTime() >= newest.createdAt.getTime();
	return { count, dismissed };
}

/**
 * Records that the user dismissed the home "memories need review" notice
 * right now. Read back by `readMemoryReviewNotice` above, which compares this
 * against the newest open review item's creation time — so the notice stays
 * hidden until a review item newer than this dismissal appears.
 */
export async function dismissMemoryReviewNotice(
	userId: string,
	now: Date = new Date(),
): Promise<void> {
	await db
		.update(users)
		.set({ homeMemoryReviewDismissedAt: now })
		.where(eq(users.id, userId));
	invalidateHomeSummary(userId);
}

// ---------------------------------------------------------------------------
// Assembly + the 30-second per-user cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { expiresAt: number; value: HomeSummary }>();

/**
 * How many users' summaries may sit in the cache at once.
 *
 * An entry going stale is not an entry going away: without this the map keeps
 * one payload — twelve buckets and three conversations — per user who has ever
 * opened the home screen since the process
 * started, for the life of the process. A thousand seats is a few megabytes of
 * summaries nobody is going to read again, and on a self-hosted box that is
 * memory the model needs. Insertion order is eviction order (Map preserves it),
 * which for a 30-second entry is close enough to least-recently-used.
 */
export const HOME_SUMMARY_CACHE_MAX_ENTRIES = 500;

/** Test seam. */
export function clearHomeSummaryCache(): void {
	cache.clear();
}

/** Test seam: how many entries are currently held. */
export function homeSummaryCacheSize(): number {
	return cache.size;
}

/**
 * Writes one entry and keeps the map bounded. Exported (and given the map as an
 * argument) so the bound can be tested without a database behind it.
 */
export function storeBoundedSummary<T extends { expiresAt: number }>(
	entries: Map<string, T>,
	userId: string,
	entry: T,
	now: number,
	max = HOME_SUMMARY_CACHE_MAX_ENTRIES,
): void {
	// Sweeping first means a busy process usually never reaches the cap, and
	// the cap is what stops an idle-but-large user base from accumulating.
	for (const [key, held] of entries) {
		if (held.expiresAt <= now) entries.delete(key);
	}
	// Re-inserting moves the key to the end of the iteration order, so a user
	// who keeps reading is never the one evicted.
	entries.delete(userId);
	entries.set(userId, entry);
	while (entries.size > max) {
		const oldest = entries.keys().next();
		if (oldest.done) break;
		entries.delete(oldest.value);
	}
}

async function computeHomeSummary(
	userId: string,
	now: Date,
): Promise<HomeSummary> {
	const [userRow] = await db
		.select({
			uiLanguage: users.uiLanguage,
			homeMemoryReviewDismissedAt: users.homeMemoryReviewDismissedAt,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const locale: HomeSummaryLocale = userRow?.uiLanguage === "hu" ? "hu" : "en";
	const timeZone = reportingTimeZone();

	const [weekly, recent, running, projects, memoryReviewNotice] =
		await Promise.all([
			readWeekly(userId, now, timeZone),
			readRecent(userId),
			readRunning(userId, locale),
			readProjects(userId),
			// Auxiliary: a memory read failure hides the notice instead of
			// failing the whole home screen.
			readMemoryReviewNotice(
				userId,
				userRow?.homeMemoryReviewDismissedAt ?? null,
			).catch((error) => {
				console.error("[HOME_SUMMARY] Memory review notice failed:", error);
				return { count: 0, dismissed: true };
			}),
		]);

	return {
		weekly,
		weeklyTotal: weekly.at(-1)?.count ?? 0,
		recent,
		running,
		projects,
		memoryReviewCount: memoryReviewNotice.count,
		memoryReviewNoticeDismissed: memoryReviewNotice.dismissed,
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
	storeBoundedSummary(
		cache,
		params.userId,
		{ expiresAt: now.getTime() + homeSummaryCacheTtlMs(), value },
		now.getTime(),
	);

	return value;
}

/** Drops one user's cached summary, e.g. after they dismiss the memory notice. */
export function invalidateHomeSummary(userId: string): void {
	cache.delete(userId);
}
