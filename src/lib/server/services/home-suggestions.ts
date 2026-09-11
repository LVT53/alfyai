// The Try suggestion engine behind the chat home's chip rail (HomeV4A
// "Compact", and the TryMechanics board that specifies it).
//
// The whole point of this module is that there is NO model deciding what you
// might want. Six sources each produce candidate *objects* you already own — a
// granted capability on a connected account, a memory item under
// `goals_ongoing_work`, the topic of a recent conversation, an Atlas job you
// never finished — and each object fills exactly one template. That is why
// every chip can name its source on hover: the source is not a guess about the
// chip, it is the record the chip was built from.
//
// Ranking is two fields. Anything you opened, dismissed or ran drops to the
// bottom for seven days (`home_suggestion_events`); within each of those two
// groups the more recent underlying object wins. Ties break on the object's
// recency and then on the candidate key — never at random — so the same state
// of the world always produces the same rail, and a chip that moved can be
// explained.
//
// No model call anywhere. TryMechanics describes an optional local-model
// rephrase as step 5; it is deliberately out of scope here, and the template
// output — always a complete, correct sentence — is what ships.

import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import chatDict from "$lib/i18n/chat";
import { db } from "$lib/server/db";
import {
	atlasJobs,
	conversations,
	homeSuggestionEvents,
	memoryProfileItems,
} from "$lib/server/db/schema";
import { listConnectionsForUser } from "$lib/server/services/connections/store";

export type HomeSuggestionKind =
	| "calendar"
	| "files"
	| "email"
	| "memory"
	| "conversation"
	| "atlas";

export type HomeSuggestionLocale = "en" | "hu";

/**
 * A candidate before its strings are rendered: the identity, the template it
 * fills, the object that fills it, and the two ranking fields.
 */
export interface HomeSuggestionSeed {
	/** Stable identity, e.g. `calendar:<connectionId>`. Used as the event key. */
	key: string;
	kind: HomeSuggestionKind;
	/** Chip glyph — a provider/category icon name the client maps to an SVG. */
	icon: HomeSuggestionKind;
	textKey: keyof (typeof chatDict)["en"];
	labelKey: keyof (typeof chatDict)["en"];
	/** The real object, substituted into both the sentence and the chip label. */
	params: Record<string, string>;
	/**
	 * The ranking field, named. Shown verbatim as the chip's hover/tooltip
	 * source so a suggestion is always traceable to a thing the user owns.
	 */
	source: string;
	/** Recency of the underlying object, epoch seconds. Ranking field one. */
	objectUpdatedAt: number;
}

/** A candidate with its strings rendered in the user's UI language. */
export interface HomeSuggestion {
	key: string;
	kind: HomeSuggestionKind;
	icon: HomeSuggestionKind;
	/** The full sentence. Clicking the chip sends exactly this as message one. */
	text: string;
	/** The short chip face. */
	label: string;
	source: string;
	/** True when this candidate was opened, dismissed or run in the last 7 days. */
	actedOn: boolean;
}

export type HomeSuggestionEventKind = "shown" | "dismissed" | "used";

/** How long an acted-on candidate stays demoted. */
export const HOME_SUGGESTION_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The rail shows three; "another" deals the next three. Nine is three deals
 * before it wraps, which is as far as the board's rotation ever goes.
 */
export const HOME_SUGGESTION_POOL_SIZE = 9;

/** A `shown` row is only re-written this often, so a 30s poll cannot flood. */
export const HOME_SUGGESTION_SHOWN_THROTTLE_SECONDS = 10 * 60;

const MAX_MEMORY_GOALS = 3;
const MAX_RECENT_TOPICS = 10;
const MAX_ATLAS_JOBS = 3;

/**
 * Substitutes `{name}` placeholders with real values. The one string operation
 * in this module, kept separate so the mapping from object to sentence can be
 * tested without a database.
 *
 * An unknown placeholder is left standing rather than blanked: a visible
 * `{provider}` in a chip is a bug report, an empty gap is a mystery.
 */
export function fillTemplate(
	template: string,
	params: Record<string, string>,
): string {
	let value = template;
	for (const [name, replacement] of Object.entries(params)) {
		value = value.replaceAll(`{${name}}`, replacement);
	}
	return value;
}

function translate(
	locale: HomeSuggestionLocale,
	key: keyof (typeof chatDict)["en"],
	params: Record<string, string>,
): string {
	const table = chatDict[locale] ?? chatDict.en;
	const pattern: string =
		(table as Record<string, string>)[key] ??
		(chatDict.en as Record<string, string>)[key] ??
		key;
	return fillTemplate(pattern, params);
}

/**
 * Trims an object's own words down to something that fits a chip without
 * lying about what it says. Cuts on a word boundary and marks the cut.
 */
export function shortenObject(value: string, max = 28): string {
	const trimmed = value.trim().replace(/\s+/g, " ");
	if (trimmed.length <= max) return trimmed;
	const cut = trimmed.slice(0, max);
	const lastSpace = cut.lastIndexOf(" ");
	const head = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
	return `${head.replace(/[.,;:–—-]+$/, "")}…`;
}

/**
 * Ranking. Acted-on candidates sink as a block; inside each block the more
 * recent object wins, and the candidate key breaks a dead tie so the order is
 * reproducible rather than whatever the database happened to return.
 */
export function rankHomeSuggestionSeeds(
	seeds: HomeSuggestionSeed[],
	actedOnKeys: ReadonlySet<string>,
): Array<HomeSuggestionSeed & { actedOn: boolean }> {
	const seen = new Set<string>();
	const deduped: HomeSuggestionSeed[] = [];
	for (const seed of seeds) {
		if (seen.has(seed.key)) continue;
		seen.add(seed.key);
		deduped.push(seed);
	}
	return deduped
		.map((seed) => ({ ...seed, actedOn: actedOnKeys.has(seed.key) }))
		.sort((a, b) => {
			if (a.actedOn !== b.actedOn) return a.actedOn ? 1 : -1;
			if (a.objectUpdatedAt !== b.objectUpdatedAt) {
				return b.objectUpdatedAt - a.objectUpdatedAt;
			}
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});
}

export function renderHomeSuggestion(
	seed: HomeSuggestionSeed & { actedOn: boolean },
	locale: HomeSuggestionLocale,
): HomeSuggestion {
	return {
		key: seed.key,
		kind: seed.kind,
		icon: seed.icon,
		text: translate(locale, seed.textKey, seed.params),
		label: translate(locale, seed.labelKey, seed.params),
		source: seed.source,
		actedOn: seed.actedOn,
	};
}

function epochSeconds(date: Date | null | undefined): number {
	return date ? Math.floor(date.getTime() / 1000) : 0;
}

// ---------------------------------------------------------------------------
// Source (a): connected accounts and what they actually granted
// ---------------------------------------------------------------------------

/**
 * Builds the connection-backed seeds.
 *
 * Two honest limits are baked in here, and both are the reason a template has
 * a generic form at all:
 *
 *  - **Files.** "Summarise the last {provider} upload" would like to name the
 *    most recently changed file. Finding it means a WebDAV/Graph round trip to
 *    the provider on every home render — not cheap, and not something a page
 *    load should block on — and nothing local indexes provider files. So the
 *    generic form is what ships. `recentFileName` is the seam: pass one in and
 *    the named template is used instead.
 *  - **Email.** "Draft the reply you owe {name}" needs an unanswered thread and
 *    the person on the other end of it. There is no local mail index either, so
 *    an unanswered thread cannot be identified without fetching the mailbox.
 *    The generic "Check what needs a reply" is what ships. `owedReplyTo` is the
 *    same seam.
 */
export function buildConnectionSeeds(
	connections: Array<{
		id: string;
		label: string;
		displayName: string;
		status: string;
		grantedCapabilities: string[];
		capabilities: string[];
		updatedAt: number;
		lastUsedAt: number | null;
	}>,
	hints: {
		recentFileName?: string | null;
		owedReplyTo?: string | null;
	} = {},
): HomeSuggestionSeed[] {
	const seeds: HomeSuggestionSeed[] = [];
	for (const connection of connections) {
		// A capability only counts when the provider granted it AND the user
		// left it switched on: a denied scope cannot answer, and a switched-off
		// one must not be suggested behind the user's back.
		if (connection.status !== "connected") continue;
		const usable = new Set(
			connection.grantedCapabilities.filter((capability) =>
				connection.capabilities.includes(capability),
			),
		);
		const recency = Math.max(connection.lastUsedAt ?? 0, connection.updatedAt);
		const provider = connection.displayName;

		if (usable.has("calendar")) {
			seeds.push({
				key: `calendar:${connection.id}`,
				kind: "calendar",
				icon: "calendar",
				textKey: "home.suggest.calendar",
				labelKey: "home.suggest.calendar.short",
				params: {},
				source: connection.label || provider,
				objectUpdatedAt: recency,
			});
		}
		if (usable.has("files")) {
			const file = hints.recentFileName?.trim();
			seeds.push({
				key: `files:${connection.id}`,
				kind: "files",
				icon: "files",
				textKey: file ? "home.suggest.fileNamed" : "home.suggest.files",
				labelKey: file
					? "home.suggest.fileNamed.short"
					: "home.suggest.files.short",
				params: file ? { provider, file: shortenObject(file) } : { provider },
				source: connection.label || provider,
				objectUpdatedAt: recency,
			});
		}
		if (usable.has("email")) {
			const person = hints.owedReplyTo?.trim();
			seeds.push({
				key: `email:${connection.id}`,
				kind: "email",
				icon: "email",
				textKey: person
					? "home.suggest.emailPerson"
					: "home.suggest.emailGeneric",
				labelKey: person
					? "home.suggest.emailPerson.short"
					: "home.suggest.emailGeneric.short",
				params: person ? { name: shortenObject(person, 20) } : {},
				source: connection.label || provider,
				objectUpdatedAt: recency,
			});
		}
	}
	return seeds;
}

// ---------------------------------------------------------------------------
// Sources (b), (c), (d): memory goals, recent topics, unfinished Atlas work
// ---------------------------------------------------------------------------

export function buildMemorySeeds(
	goals: Array<{ id: string; statement: string; updatedAt: number }>,
	sourceLabel: string,
): HomeSuggestionSeed[] {
	return goals
		.filter((goal) => goal.statement.trim().length > 0)
		.map((goal) => ({
			key: `memory:${goal.id}`,
			kind: "memory" as const,
			icon: "memory" as const,
			textKey: "home.suggest.memory" as const,
			labelKey: "home.suggest.memory.short" as const,
			params: {
				goal: goal.statement.trim().replace(/\s+/g, " "),
				goalShort: shortenObject(goal.statement),
			},
			source: sourceLabel,
			objectUpdatedAt: goal.updatedAt,
		}));
}

export function buildConversationSeeds(
	topics: Array<{ id: string; title: string; updatedAt: number }>,
	sourceLabel: string,
): HomeSuggestionSeed[] {
	return topics
		.filter(
			(topic) =>
				topic.title.trim().length > 0 &&
				// The placeholder a conversation carries until its title is
				// summarised names no object at all, so it fills no template.
				topic.title.trim().toLowerCase() !== "new conversation",
		)
		.map((topic) => ({
			key: `conversation:${topic.id}`,
			kind: "conversation" as const,
			icon: "conversation" as const,
			textKey: "home.suggest.conversation" as const,
			labelKey: "home.suggest.conversation.short" as const,
			params: {
				topic: topic.title.trim().replace(/\s+/g, " "),
				topicShort: shortenObject(topic.title),
			},
			source: sourceLabel,
			objectUpdatedAt: topic.updatedAt,
		}));
}

export function buildAtlasSeeds(
	jobs: Array<{ id: string; title: string; updatedAt: number; status: string }>,
	sourceLabel: string,
): HomeSuggestionSeed[] {
	return jobs
		.filter((job) => job.title.trim().length > 0)
		.map((job) => ({
			key: `atlas:${job.id}`,
			kind: "atlas" as const,
			icon: "atlas" as const,
			textKey: "home.suggest.atlas" as const,
			labelKey: "home.suggest.atlas.short" as const,
			params: {
				title: job.title.trim().replace(/\s+/g, " "),
				titleShort: shortenObject(job.title),
			},
			source: sourceLabel,
			objectUpdatedAt: job.updatedAt,
		}));
}

// ---------------------------------------------------------------------------
// Gathering: the four reads, all indexed, all capped
// ---------------------------------------------------------------------------

async function actedOnKeysFor(userId: string, now: Date): Promise<Set<string>> {
	const rows = await db
		.select({
			candidateKey: homeSuggestionEvents.candidateKey,
			event: homeSuggestionEvents.event,
		})
		.from(homeSuggestionEvents)
		.where(
			and(
				eq(homeSuggestionEvents.userId, userId),
				gt(homeSuggestionEvents.expiresAt, now),
				// `shown` is rotation memory, not an action: putting a chip in
				// front of someone is not the same as them wanting it gone.
				inArray(homeSuggestionEvents.event, ["dismissed", "used"]),
			),
		);
	return new Set(rows.map((row) => row.candidateKey));
}

export async function gatherHomeSuggestionSeeds(params: {
	userId: string;
	locale: HomeSuggestionLocale;
}): Promise<HomeSuggestionSeed[]> {
	const { userId, locale } = params;
	const memoryLabel = translate(locale, "home.suggest.source.memory", {});
	const conversationLabel = translate(
		locale,
		"home.suggest.source.conversation",
		{},
	);
	const atlasLabel = translate(locale, "home.suggest.source.atlas", {});

	const [connectionRows, goalRows, topicRows, atlasRows] = await Promise.all([
		listConnectionsForUser(userId),
		db
			.select({
				id: memoryProfileItems.id,
				statement: memoryProfileItems.statement,
				updatedAt: memoryProfileItems.updatedAt,
			})
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, userId),
					eq(memoryProfileItems.category, "goals_ongoing_work"),
					eq(memoryProfileItems.status, "active"),
				),
			)
			.orderBy(desc(memoryProfileItems.updatedAt))
			.limit(MAX_MEMORY_GOALS),
		db
			.select({
				id: conversations.id,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.where(eq(conversations.userId, userId))
			.orderBy(desc(conversations.updatedAt))
			.limit(MAX_RECENT_TOPICS),
		// "Unfinished" = queued, failed-and-retryable, or cancelled. A succeeded
		// job is finished by definition and a running one is already on the
		// "Running now" line, so neither is an offer to pick anything up.
		db
			.select({
				id: atlasJobs.id,
				title: atlasJobs.title,
				status: atlasJobs.status,
				errorRetryable: atlasJobs.errorRetryable,
				updatedAt: atlasJobs.updatedAt,
			})
			.from(atlasJobs)
			.where(
				and(
					eq(atlasJobs.userId, userId),
					inArray(atlasJobs.status, ["queued", "failed", "cancelled"]),
				),
			)
			.orderBy(desc(atlasJobs.updatedAt))
			.limit(MAX_ATLAS_JOBS * 3),
	]);

	const connectionSeeds = buildConnectionSeeds(
		connectionRows.map((connection) => ({
			id: connection.id,
			label: connection.label,
			displayName: connection.label || connection.provider,
			status: connection.status,
			grantedCapabilities: connection.grantedCapabilities ?? [],
			capabilities: connection.capabilities,
			updatedAt: connection.updatedAt,
			lastUsedAt: connection.lastUsedAt ?? null,
		})),
	);

	const memorySeeds = buildMemorySeeds(
		goalRows.map((row) => ({
			id: row.id,
			statement: row.statement,
			updatedAt: epochSeconds(row.updatedAt),
		})),
		memoryLabel,
	);

	const conversationSeeds = buildConversationSeeds(
		topicRows.map((row) => ({
			id: row.id,
			title: row.title,
			updatedAt: epochSeconds(row.updatedAt),
		})),
		conversationLabel,
	);

	const atlasSeeds = buildAtlasSeeds(
		atlasRows
			.filter((row) => row.status !== "failed" || row.errorRetryable)
			.slice(0, MAX_ATLAS_JOBS)
			.map((row) => ({
				id: row.id,
				title: row.title,
				status: row.status,
				updatedAt: epochSeconds(row.updatedAt),
			})),
		atlasLabel,
	);

	return [
		...connectionSeeds,
		...memorySeeds,
		...conversationSeeds,
		...atlasSeeds,
	];
}

/**
 * The rail's pool: every candidate this user has, ranked, capped at nine and
 * rendered. The client shows the first three and "another" deals the next
 * three, wrapping — which is why the whole pool comes back in one response
 * rather than the rotation costing a round trip.
 *
 * Fewer than three candidates means fewer than three chips, and none means no
 * rail at all: a new user with nothing connected and no history gets a greeting
 * and a composer, which is honest.
 */
export async function getHomeSuggestions(params: {
	userId: string;
	locale: HomeSuggestionLocale;
	now?: Date;
}): Promise<HomeSuggestion[]> {
	const now = params.now ?? new Date();
	const [seeds, actedOn] = await Promise.all([
		gatherHomeSuggestionSeeds(params),
		actedOnKeysFor(params.userId, now),
	]);
	return rankHomeSuggestionSeeds(seeds, actedOn)
		.slice(0, HOME_SUGGESTION_POOL_SIZE)
		.map((seed) => renderHomeSuggestion(seed, params.locale));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function recordHomeSuggestionEvent(params: {
	userId: string;
	candidateKey: string;
	event: HomeSuggestionEventKind;
	now?: Date;
}): Promise<void> {
	const now = params.now ?? new Date();
	await db.insert(homeSuggestionEvents).values({
		id: crypto.randomUUID(),
		userId: params.userId,
		candidateKey: params.candidateKey,
		event: params.event,
		createdAt: now,
		expiresAt: new Date(
			now.getTime() + HOME_SUGGESTION_EVENT_TTL_SECONDS * 1000,
		),
	});
}

/**
 * Records that these candidates were put in front of the user, at most once
 * per key per throttle window. Called on a summary cache miss — never on a
 * cache hit — so a polling client cannot turn the rail into a write endpoint.
 */
export async function recordHomeSuggestionsShown(params: {
	userId: string;
	candidateKeys: string[];
	now?: Date;
}): Promise<void> {
	if (params.candidateKeys.length === 0) return;
	const now = params.now ?? new Date();
	const since = new Date(
		now.getTime() - HOME_SUGGESTION_SHOWN_THROTTLE_SECONDS * 1000,
	);
	const recent = await db
		.select({ candidateKey: homeSuggestionEvents.candidateKey })
		.from(homeSuggestionEvents)
		.where(
			and(
				eq(homeSuggestionEvents.userId, params.userId),
				eq(homeSuggestionEvents.event, "shown"),
				gt(homeSuggestionEvents.createdAt, since),
				inArray(homeSuggestionEvents.candidateKey, params.candidateKeys),
			),
		);
	const alreadyShown = new Set(recent.map((row) => row.candidateKey));
	const rows = params.candidateKeys
		.filter((key) => !alreadyShown.has(key))
		.map((key) => ({
			id: crypto.randomUUID(),
			userId: params.userId,
			candidateKey: key,
			event: "shown" as const,
			createdAt: now,
			expiresAt: new Date(
				now.getTime() + HOME_SUGGESTION_EVENT_TTL_SECONDS * 1000,
			),
		}));
	if (rows.length === 0) return;
	await db.insert(homeSuggestionEvents).values(rows);
}

/** Housekeeping for the seven-day window. Safe to call from anywhere. */
export async function purgeExpiredHomeSuggestionEvents(
	now: Date = new Date(),
): Promise<void> {
	await db
		.delete(homeSuggestionEvents)
		.where(lt(homeSuggestionEvents.expiresAt, now));
}
