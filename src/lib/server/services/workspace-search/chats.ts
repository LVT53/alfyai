import { and, desc, eq, or, type SQL, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, messages, projects } from "$lib/server/db/schema";
import {
	foldForSearch,
	searchSnippet,
} from "$lib/shared/workspace-search-text";
import { foldedGlob, likeSpellings, wordSpellings } from "./patterns";
import {
	SEARCH_CANDIDATE_CAP,
	SEARCH_COUNT_CAP,
	type WorkspaceSearchConversationResult,
} from "./types";

/**
 * The query's words twice over: `terms` folded (from `searchTerms`) and `words`
 * as typed (from `typedSearchWords`), so `words[i]` spells `terms[i]`.
 */
export interface ChatQuery {
	terms: string[];
	words: string[];
}

type ConversationRow = {
	id: string;
	title: string;
	projectId: string | null;
	projectName: string | null;
	status: string;
	sealedAt: Date | null;
	updatedAt: Date;
};

/** How well a chat matches: every word in its title, in its title or project, or
 *  some word only in its messages. */
type Strength = 0 | 1 | 2;

interface RankedChat {
	row: ConversationRow;
	strength: Strength;
	/** The words the title and project do not hold, so a message must. */
	bodyIndexes: number[];
}

const SNIPPET_BEFORE_CHARS = 120;
const SNIPPET_CUT_CHARS = 320;
const SNIPPET_CHARS = 160;

const conversationSelection = {
	id: conversations.id,
	title: conversations.title,
	projectId: conversations.projectId,
	projectName: projects.name,
	status: conversations.status,
	sealedAt: conversations.sealedAt,
	updatedAt: conversations.updatedAt,
};

function toUnixSeconds(value: Date | null | undefined): number | null {
	return value instanceof Date ? value.getTime() / 1000 : null;
}

export function buildChatHref(
	conversationId: string,
	messageId?: string | null,
): string {
	const url = new URL(`/chat/${conversationId}`, "http://localhost");
	if (messageId) {
		url.searchParams.set("focus_message", messageId);
	}
	return `${url.pathname}${url.search}`;
}

function normaliseRow(row: {
	id: string;
	title: string;
	projectId: string | null;
	projectName: string | null;
	status: string;
	sealedAt: Date | null;
	updatedAt: Date;
}): ConversationRow {
	return {
		...row,
		projectId: row.projectId ?? null,
		projectName: row.projectName ?? null,
		sealedAt: row.sealedAt ?? null,
	};
}

function mapConversationResult(
	row: ConversationRow,
	match: WorkspaceSearchConversationResult["match"],
): WorkspaceSearchConversationResult {
	return {
		id: row.id,
		title: row.title,
		projectId: row.projectId ?? null,
		projectName: row.projectName ?? null,
		status: row.status === "sealed" ? "sealed" : "open",
		sealedAt: toUnixSeconds(row.sealedAt),
		updatedAt: toUnixSeconds(row.updatedAt) ?? 0,
		href: buildChatHref(row.id, match.messageId),
		match,
	};
}

/** A chat is listed only once it holds a message, as in the sidebar. */
function holdsAMessage(): SQL {
	return sql`exists (
		select 1 from ${messages}
		where ${messages.conversationId} = ${conversations.id}
		limit 1
	)`;
}

/**
 * One word of the query, found in the title or the project's name (folded, so
 * accents and case do not matter) or in any message (its typed, capitalised
 * and capital spellings). Different words may be found in different places.
 */
function holdsWord(term: string, word: string): SQL {
	const glob = foldedGlob(term);
	const likes = likeSpellings(word).map(
		(pattern) => sql`${messages.content} like ${pattern} escape '\\'`,
	);
	return sql`(
		${conversations.title} glob ${glob}
		or ${projects.name} glob ${glob}
		or exists (
			select 1 from ${messages}
			where ${messages.conversationId} = ${conversations.id}
			and (${sql.join(likes, sql` or `)})
		)
	)`;
}

/**
 * How well a chat's title and project hold the words, read in SQL as `rankChat`
 * reads it in code: 0 when every word is in the title, 1 when every word is in
 * the title or the project, else 2. The candidate read sorts by it first, so the
 * cap keeps the strongest matches and never only the newest.
 */
function strengthSql(terms: readonly string[]): SQL {
	const globs = terms.map(foldedGlob);
	const inTitle = sql.join(
		globs.map((glob) => sql`${conversations.title} glob ${glob}`),
		sql` and `,
	);
	const inTitleOrProject = sql.join(
		globs.map(
			(glob) =>
				sql`(${conversations.title} glob ${glob} or ${projects.name} glob ${glob})`,
		),
		sql` and `,
	);
	return sql`case when ${inTitle} then 0 when ${inTitleOrProject} then 1 else 2 end`;
}

async function loadCandidateRows(
	userId: string,
	query: ChatQuery,
): Promise<ConversationRow[]> {
	const rows = await db
		.select(conversationSelection)
		.from(conversations)
		.leftJoin(
			projects,
			and(
				eq(projects.id, conversations.projectId),
				eq(projects.userId, userId),
			),
		)
		.where(
			and(
				eq(conversations.userId, userId),
				holdsAMessage(),
				...query.terms.map((term, index) =>
					holdsWord(term, query.words[index] ?? term),
				),
			),
		)
		.orderBy(
			strengthSql(query.terms),
			desc(conversations.updatedAt),
			conversations.id,
		)
		.limit(SEARCH_CANDIDATE_CAP);
	return rows.map(normaliseRow);
}

function rankChat(row: ConversationRow, terms: readonly string[]): RankedChat {
	const title = foldForSearch(row.title);
	const project = row.projectName ? foldForSearch(row.projectName) : "";
	const inTitle = terms.map((term) => title.includes(term));
	const inProject = terms.map(
		(term) => project !== "" && project.includes(term),
	);
	const strength: Strength = inTitle.every(Boolean)
		? 0
		: terms.every((_, index) => inTitle[index] || inProject[index])
			? 1
			: 2;
	const bodyIndexes = terms
		.map((_, index) => index)
		.filter((index) => !(inTitle[index] || inProject[index]));
	return { row, strength, bodyIndexes };
}

function clipPlain(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET_CHARS
		? `${flat.slice(0, SNIPPET_CHARS).trimEnd()}…`
		: flat;
}

/**
 * The newest message that holds one of the words the title and project do not,
 * with a snippet cut in SQL around the first spelling `instr` finds, so a long
 * message is never read in full.
 */
async function loadBodyMatch(
	conversationId: string,
	query: ChatQuery,
	bodyIndexes: number[],
): Promise<{ id: string; role: string; snippet: string } | null> {
	const used =
		bodyIndexes.length > 0 ? bodyIndexes : query.terms.map((_, index) => index);
	const words = used.map((index) => query.words[index] ?? query.terms[index]);
	const terms = used.map((index) => query.terms[index]);
	const likes = words
		.flatMap(likeSpellings)
		.map((pattern) => sql`${messages.content} like ${pattern} escape '\\'`);
	const firstFound = sql.join(
		words
			.flatMap(wordSpellings)
			.map(
				(spelling) => sql`nullif(instr(${messages.content}, ${spelling}), 0)`,
			),
		sql`, `,
	);
	const [row] = await db
		.select({
			id: messages.id,
			role: messages.role,
			cut: sql<string>`substr(${messages.content}, max(1, coalesce(${firstFound}, 1) - ${SNIPPET_BEFORE_CHARS}), ${SNIPPET_CUT_CHARS})`,
		})
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), or(...likes)))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		role: row.role,
		snippet: searchSnippet(row.cut, terms, SNIPPET_CHARS) ?? clipPlain(row.cut),
	};
}

async function toResult(
	ranked: RankedChat,
	query: ChatQuery,
): Promise<WorkspaceSearchConversationResult> {
	if (ranked.strength < 2) {
		return mapConversationResult(ranked.row, {
			type: ranked.strength === 0 ? "title" : "project",
			snippet: null,
			messageId: null,
			messageRole: null,
		});
	}
	const body = await loadBodyMatch(ranked.row.id, query, ranked.bodyIndexes);
	return mapConversationResult(ranked.row, {
		type: "body",
		snippet: body?.snippet ?? null,
		messageId: body?.id ?? null,
		messageRole: body?.role ?? null,
	});
}

/** The person's newest chats, for the view before anything is typed. */
export async function recentChats(
	userId: string,
	limit: number,
): Promise<WorkspaceSearchConversationResult[]> {
	const rows = await db
		.select(conversationSelection)
		.from(conversations)
		.leftJoin(
			projects,
			and(
				eq(projects.id, conversations.projectId),
				eq(projects.userId, userId),
			),
		)
		.where(and(eq(conversations.userId, userId), holdsAMessage()))
		.orderBy(desc(conversations.updatedAt), conversations.id)
		.limit(limit);
	return rows.map((row) =>
		mapConversationResult(normaliseRow(row), {
			type: "recent",
			snippet: null,
			messageId: null,
			messageRole: null,
		}),
	);
}

/**
 * The chats that hold every word of the query, best match first: every word in
 * the title, then in the title or project, then some word only in a message;
 * newest first within each. `total` counts chats, not messages, up to the cap;
 * `hasMore` says a page past this one exists.
 */
export async function searchChats(
	userId: string,
	query: ChatQuery,
	window: { offset: number; limit: number },
): Promise<{
	results: WorkspaceSearchConversationResult[];
	total: number;
	hasMore: boolean;
}> {
	if (query.terms.length === 0) {
		return { results: [], total: 0, hasMore: false };
	}
	const candidates = await loadCandidateRows(userId, query);
	// A stable sort keeps the query's newest-first order inside each strength.
	const ranked = candidates
		.map((row) => rankChat(row, query.terms))
		.sort((left, right) => left.strength - right.strength);
	const page = ranked.slice(window.offset, window.offset + window.limit);
	return {
		results: await Promise.all(page.map((entry) => toResult(entry, query))),
		total: Math.min(ranked.length, SEARCH_COUNT_CAP),
		hasMore: window.offset + window.limit < ranked.length,
	};
}
