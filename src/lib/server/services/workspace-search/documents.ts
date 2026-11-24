import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	artifactVersions,
	conversations,
	imageDescriptions,
	videoJobs,
} from "$lib/server/db/schema";
import {
	attachImagePreviews,
	getArtifactOwnershipScope,
	getLogicalDocumentsForArtifacts,
	knowledgeArtifactListSelection,
	parseWorkingDocumentMetadata,
} from "$lib/server/services/knowledge/store";
import { buildArtifactCanonicalOwnershipCondition } from "$lib/server/services/knowledge/store/core";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { parseJsonRecord } from "$lib/server/utils/json";
import { resolveWorkingDocumentIdentity } from "$lib/services/working-document-identity";
import { parseVideoVersionBody } from "$lib/shared/artifacts/video-body";
import {
	foldForSearch,
	searchSnippet,
} from "$lib/shared/workspace-search-text";
import { buildChatHref } from "./chats";
import {
	foldedGlob,
	foldedSnippet,
	indexMatch,
	likeSpellings,
	usesSearchIndex,
	wordSpellings,
} from "./patterns";
import {
	SEARCH_CANDIDATE_CAP,
	SEARCH_COUNT_CAP,
	type WorkspaceSearchBadge,
	type WorkspaceSearchDocumentMatchType,
	type WorkspaceSearchDocumentResult,
	type WorkspaceSearchKind,
	type WorkspaceSearchScope,
} from "./types";

type DocumentKind = "documents" | "media" | "apps";

const DOCUMENT_KINDS: readonly DocumentKind[] = ["documents", "media", "apps"];

/** The fields a word may be found in, with the weights search has always used. */
const NAME_WEIGHT = 30;
const LABEL_WEIGHT = 26;
const SUMMARY_WEIGHT = 14;
/** A picture's or video's prompt, what Alfy saw in a picture, a canvas's words. */
const FIELD_TEXT_WEIGHT = 12;
const BODY_WEIGHT = 10;
const EXACT_NAME_BONUS = 4;

const SNIPPET_BEFORE_CHARS = 120;
const SNIPPET_CUT_CHARS = 320;
const SNIPPET_CHARS = 160;
/**
 * Rows read to find a few distinct recent documents: a document may hold several
 * rows (an upload and its text, a generated file's versions), so the read widens
 * until enough distinct documents turn up or the library runs out.
 */
const RECENT_ROWS_PER_DOCUMENT = 10;
const RECENT_WIDENINGS = 3;

// ── Where a row's words live ─────────────────────────────────────────────

const metadataValue = (path: string): SQL =>
	sql`case when json_valid(${artifacts.metadataJson}) then json_extract(${artifacts.metadataJson}, ${path}) end`;

const artifactKindSql = metadataValue("$.artifactType");
const documentLabelSql = metadataValue("$.documentLabel");

/** A durable generated file, as the library lists it: a chat file, never a Download's. */
const generatedFileSql = sql`(
	${artifacts.type} = 'generated_output'
	and ${artifacts.retrievalClass} = 'durable'
	and ${metadataValue("$.sourceChatFileId")} is not null
	and coalesce(${metadataValue("$.artifactExport")}, 0) = 0
)`;

/** The artifact family's rows whose body is JSON or code, never prose. */
const JSON_KINDS = ["image", "video", "canvas", "app"] as const;

const familyOfKind = (kind: (typeof JSON_KINDS)[number]): SQL =>
	sql`(${artifacts.type} = 'artifact' and ${artifactKindSql} = ${kind})`;

/** Documents and Slides, and a row this slice cannot classify (it lists as a document). */
const textFamilySql = sql`(
	${artifacts.type} = 'artifact'
	and coalesce(${artifactKindSql}, 'document') not in ('image', 'video', 'canvas', 'app')
)`;

const textRowsSql = sql`(
	${artifacts.type} in ('source_document', 'normalized_document', 'skill_note')
	or ${generatedFileSql}
	or ${textFamilySql}
)`;

interface CandidateGroup {
	/** Which rows the group reads. */
	rows: SQL;
	/** Where a word may be besides the name, label and summary. */
	extra: (userId: string, term: string, word: string) => SQL[];
	/** The group's own words, read back to confirm and to show: a prompt, a description, a canvas's words. */
	fieldText: (userId: string) => SQL;
	/** Whether the row's text body is searched. */
	hasBody: boolean;
	/** Whether the row can carry a label (a generated file does). */
	hasLabel: boolean;
}

const noFieldText = () => sql`null`;

const imagePromptSql = sql`case when json_valid(${artifacts.contentText}) then json_extract(${artifacts.contentText}, '$.prompt') end`;

/**
 * A picture's takes, each a version whose body names the prompt it was made
 * from, so an edited picture is still found by what was first asked of it.
 * Read through the ownership-scoped artifact row, and never another person's.
 */
const takePromptSql = sql`case when json_valid(${artifactVersions.body}) then json_extract(${artifactVersions.body}, '$.prompt') end`;

const imageTakesOf = (userId: string): SQL =>
	sql`${artifactVersions.artifactId} = ${artifacts.id} and ${artifactVersions.userId} = ${userId}`;

/**
 * The keys a board keeps its words under: a note's or text block's `text`, a
 * checklist item's `text`, a frame's, chart's, checklist's, map's or photo
 * block's `label`, an App block's `title`, a chart's `subtitle`, a file
 * block's `name`, a photo's `alt`, a web block's `query`, a map's `route`, and
 * an edge's `label` and a note's `text`. Never a coordinate, a kind or an id.
 */
const CANVAS_TEXT_KEYS = [
	"text",
	"label",
	"title",
	"subtitle",
	"name",
	"alt",
	"query",
	"route",
] as const;

/**
 * Every text of the board under one of those keys, wherever it sits in the
 * body. A text is read as a text and never parsed, so a node that is not an
 * object (a hand-edited or damaged body) cannot make the whole search fail.
 */
const canvasWordsSql = sql`json_tree(case when json_valid(${artifacts.contentText}) then ${artifacts.contentText} else '{}' end)`;

const canvasWordsWhereSql = sql`word.type = 'text' and word.key in (${sql.join(
	CANVAS_TEXT_KEYS.map((key) => sql`${key}`),
	sql`, `,
)})`;

/** A video's prompts: the takes that made it, never another person's. */
const videoPromptSql = sql`case when json_valid(${videoJobs.requestJson}) and json_extract(${videoJobs.requestJson}, '$.v') = 1 then json_extract(${videoJobs.requestJson}, '$.prompt') end`;

const videoTakesOf = (userId: string): SQL =>
	sql`(${videoJobs.artifactId} = ${artifacts.id} or ${videoJobs.createdArtifactId} = ${artifacts.id}) and ${videoJobs.userId} = ${userId}`;

/**
 * A text row whose body holds one word: through the full-text index (case and
 * accents folded) for a word of three letters or more, else through the word's
 * typed, capitalised and capital spellings, which a trigram index cannot
 * replace for so short a word. The index holds only rows with a text body
 * (migration 145), never JSON or code; the group's own conditions still decide.
 */
function bodyHolds(term: string, word: string): SQL {
	if (usesSearchIndex(term)) {
		return sql`${artifacts}.rowid in (select rowid from artifacts_fts where artifacts_fts match ${indexMatch(term, word)})`;
	}
	return sql`(${sql.join(
		likeSpellings(word).map(
			(pattern) => sql`${artifacts.contentText} like ${pattern} escape '\\'`,
		),
		sql` or `,
	)})`;
}

const GROUPS: readonly CandidateGroup[] = [
	{
		// Uploads and their text, generated files, Skill Notes, Documents, Slides.
		rows: textRowsSql,
		hasBody: true,
		hasLabel: true,
		extra: (userId, term, word) => [
			bodyHolds(term, word),
			// What Alfy saw in an uploaded picture.
			sql`(${artifacts.type} = 'source_document' and exists (
				select 1 from ${imageDescriptions}
				where ${imageDescriptions.artifactId} = ${artifacts.id}
				and ${imageDescriptions.userId} = ${userId}
				and ${imageDescriptions.description} glob ${foldedGlob(term)}
			))`,
		],
		fieldText: (userId) =>
			sql`(select ${imageDescriptions.description} from ${imageDescriptions}
				where ${imageDescriptions.artifactId} = ${artifacts.id}
				and ${imageDescriptions.userId} = ${userId})`,
	},
	{
		rows: familyOfKind("image"),
		hasBody: false,
		hasLabel: false,
		extra: (userId, term) => [
			sql`${imagePromptSql} glob ${foldedGlob(term)}`,
			sql`exists (
				select 1 from ${artifactVersions}
				where ${imageTakesOf(userId)}
				and ${takePromptSql} glob ${foldedGlob(term)}
			)`,
		],
		fieldText: (userId) =>
			sql`(select group_concat(prompt, char(10)) from (
				select ${imagePromptSql} as prompt
				union
				select ${takePromptSql} from ${artifactVersions}
				where ${imageTakesOf(userId)}
			))`,
	},
	{
		rows: familyOfKind("video"),
		hasBody: false,
		hasLabel: false,
		extra: (userId, term) => [
			sql`exists (
				select 1 from ${videoJobs}
				where ${videoTakesOf(userId)}
				and ${videoPromptSql} glob ${foldedGlob(term)}
			)`,
		],
		fieldText: (userId) =>
			sql`(select group_concat(${videoPromptSql}, char(10)) from ${videoJobs}
				where ${videoTakesOf(userId)})`,
	},
	{
		rows: familyOfKind("canvas"),
		hasBody: false,
		hasLabel: false,
		extra: (_userId, term) => [
			sql`exists (
					select 1 from ${canvasWordsSql} as word
					where ${canvasWordsWhereSql} and word.value glob ${foldedGlob(term)}
				)`,
		],
		fieldText: () =>
			sql`(select group_concat(word.value, char(10))
					from ${canvasWordsSql} as word
					where ${canvasWordsWhereSql})`,
	},
	{
		// An App is found by its name and summary, never by its code.
		rows: familyOfKind("app"),
		hasBody: false,
		hasLabel: false,
		extra: () => [],
		fieldText: noFieldText,
	},
];

/** Every row a document list shows, for the newest few. */
const ANY_DOCUMENT_ROWS_SQL = sql`(${textRowsSql} or ${sql.join(
	JSON_KINDS.map(familyOfKind),
	sql` or `,
)})`;

// ── Classification ───────────────────────────────────────────────────────

/** The chip a document, picture, video or app sits under, and the word on its row. */
export function searchKindAndBadge(item: KnowledgeDocumentItem): {
	searchKind: DocumentKind;
	badge: WorkspaceSearchBadge;
} {
	const mime = item.mimeType ?? "";
	const uploaded = item.documentOrigin === "uploaded";
	if (item.kind === "app") return { searchKind: "apps", badge: "app" };
	if (item.kind === "image") return { searchKind: "media", badge: "image" };
	if (item.kind === "video") return { searchKind: "media", badge: "video" };
	if (uploaded && mime.startsWith("image/")) {
		return { searchKind: "media", badge: "image" };
	}
	if (uploaded && mime.startsWith("video/")) {
		return { searchKind: "media", badge: "video" };
	}
	if (item.kind === "slides") {
		return { searchKind: "documents", badge: "slides" };
	}
	if (item.kind === "canvas") {
		return { searchKind: "documents", badge: "canvas" };
	}
	if (item.kind === "document") {
		return { searchKind: "documents", badge: "document" };
	}
	if (item.documentOrigin === "skill_note") {
		return { searchKind: "documents", badge: "skill_note" };
	}
	if (item.documentOrigin === "generated") {
		return {
			searchKind: "documents",
			badge: item.documentRole?.startsWith("Atlas research report")
				? "report"
				: "generated",
		};
	}
	return { searchKind: "documents", badge: "uploaded" };
}

// ── Matching ─────────────────────────────────────────────────────────────

/**
 * The query's words twice over: `terms` folded (from `searchTerms`) and `words`
 * as typed (from `typedSearchWords`), so `words[i]` spells `terms[i]`.
 */
export interface DocumentQuery {
	terms: string[];
	words: string[];
}

type CandidateRow = {
	id: string;
	name: string;
	summary: string | null;
	metadataJson: string | null;
	updatedAt: Date;
	fieldText: string | null;
};

interface Candidate {
	row: CandidateRow;
	hasBody: boolean;
}

interface FieldMatch {
	field: "name" | "label" | "summary" | "fieldText" | "body";
	weight: number;
}

interface RankedDocument {
	item: KnowledgeDocumentItem;
	rowId: string;
	score: number;
	match: { type: WorkspaceSearchDocumentMatchType; snippet: string | null };
	/** The words whose only home is the row's body, to cut its snippet. */
	bodyIndexes: number[];
	searchKind: DocumentKind;
	badge: WorkspaceSearchBadge;
}

function wordClause(
	userId: string,
	group: CandidateGroup,
	term: string,
	word: string,
): SQL {
	const glob = foldedGlob(term);
	const parts: SQL[] = [
		sql`${artifacts.name} glob ${glob}`,
		sql`${artifacts.summary} glob ${glob}`,
		...(group.hasLabel ? [sql`${documentLabelSql} glob ${glob}`] : []),
		...group.extra(userId, term, word),
	];
	return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * How well a row's name, label and summary hold the words, read in SQL as
 * `matchFields` weighs them in code: 0 when every word is in the name, 1 in the
 * name or label, 2 in the name, label or summary, else 3 (the row's own text or
 * body). The candidate read sorts by it first, so the cap keeps the strongest
 * matches and never only the newest.
 */
function strengthSql(group: CandidateGroup, terms: readonly string[]): SQL {
	const holdsEvery = (fields: (glob: string) => SQL[]): SQL =>
		sql.join(
			terms.map((term) => {
				const glob = foldedGlob(term);
				return sql`(${sql.join(fields(glob), sql` or `)})`;
			}),
			sql` and `,
		);
	const name = (glob: string) => sql`${artifacts.name} glob ${glob}`;
	const label = (glob: string) =>
		group.hasLabel ? [sql`${documentLabelSql} glob ${glob}`] : [];
	const summary = (glob: string) => sql`${artifacts.summary} glob ${glob}`;
	return sql`case
		when ${holdsEvery((glob) => [name(glob)])} then 0
		when ${holdsEvery((glob) => [name(glob), ...label(glob)])} then 1
		when ${holdsEvery((glob) => [name(glob), ...label(glob), summary(glob)])} then 2
		else 3
	end`;
}

async function loadCandidates(
	userId: string,
	query: DocumentQuery,
	ownership: SQL | undefined,
): Promise<Candidate[]> {
	const found = await Promise.all(
		GROUPS.map(async (group) => {
			const rows = await db
				.select({
					id: knowledgeArtifactListSelection.id,
					name: knowledgeArtifactListSelection.name,
					summary: knowledgeArtifactListSelection.summary,
					metadataJson: knowledgeArtifactListSelection.metadataJson,
					updatedAt: knowledgeArtifactListSelection.updatedAt,
					fieldText: sql<string | null>`${group.fieldText(userId)}`,
				})
				.from(artifacts)
				.where(
					and(
						ownership,
						group.rows,
						...query.terms.map((term, index) =>
							wordClause(userId, group, term, query.words[index] ?? term),
						),
					),
				)
				.orderBy(
					strengthSql(group, query.terms),
					desc(artifacts.updatedAt),
					artifacts.id,
				)
				.limit(SEARCH_CANDIDATE_CAP);
			return rows.map((row) => ({ row, hasBody: group.hasBody }));
		}),
	);
	return found.flat();
}

function labelOf(metadataJson: string | null): string | null {
	return (
		parseWorkingDocumentMetadata(parseJsonRecord(metadataJson ?? null))
			.documentLabel ?? null
	);
}

interface HeldField extends FieldMatch {
	text: string | null;
	folded: string;
}

function held(
	field: FieldMatch["field"],
	weight: number,
	text: string | null,
): HeldField {
	return { field, weight, text, folded: foldForSearch(text ?? "") };
}

/**
 * Which field holds each word, confirmed with the shared matcher (case and
 * accents folded). A word no short field holds sits in the body, which only the
 * SQL condition reads, so it counts as a content match; a row with no body
 * whose word is nowhere is not a result.
 */
function matchFields(
	candidate: Candidate,
	terms: readonly string[],
): {
	score: number;
	match: RankedDocument["match"];
	bodyIndexes: number[];
} | null {
	const { row } = candidate;
	const fields = [
		held("name", NAME_WEIGHT, row.name),
		held("label", LABEL_WEIGHT, labelOf(row.metadataJson)),
		held("summary", SUMMARY_WEIGHT, row.summary),
		held("fieldText", FIELD_TEXT_WEIGHT, row.fieldText),
	];

	const holders: FieldMatch[] = [];
	const bodyIndexes: number[] = [];
	for (const [index, term] of terms.entries()) {
		const best = fields
			.filter((field) => field.folded.includes(term))
			.sort((left, right) => right.weight - left.weight)[0];
		if (best) {
			holders.push({ field: best.field, weight: best.weight });
		} else if (candidate.hasBody) {
			holders.push({ field: "body", weight: BODY_WEIGHT });
			bodyIndexes.push(index);
		} else {
			return null;
		}
	}
	const weakest = holders.reduce((low, next) =>
		next.weight < low.weight ? next : low,
	);
	const exactName =
		holders.every((holder) => holder.field === "name") &&
		foldForSearch(row.name) === terms.join(" ");
	const type: WorkspaceSearchDocumentMatchType =
		weakest.field === "name"
			? "name"
			: weakest.field === "label"
				? "label"
				: weakest.field === "summary"
					? "summary"
					: "content";
	const holderField = fields.find((field) => field.field === weakest.field);
	const heldTerms = terms.filter(
		(_, index) => holders[index]?.field === weakest.field,
	);
	const snippet =
		holderField && (type === "summary" || weakest.field === "fieldText")
			? searchSnippet(holderField.text ?? "", heldTerms, SNIPPET_CHARS)
			: null;
	return {
		score: weakest.weight + (exactName ? EXACT_NAME_BONUS : 0),
		match: { type, snippet },
		bodyIndexes,
	};
}

function compareRanked(left: RankedDocument, right: RankedDocument): number {
	return (
		right.score - left.score ||
		right.item.updatedAt - left.item.updatedAt ||
		left.item.displayArtifactId.localeCompare(right.item.displayArtifactId)
	);
}

// ── Result rows ──────────────────────────────────────────────────────────

function buildKnowledgeWorkspaceHref(document: KnowledgeDocumentItem): string {
	const identity = resolveWorkingDocumentIdentity(document);
	const url = new URL("/knowledge", "http://localhost");
	url.searchParams.set("open_artifact", identity.preview.artifactId);
	url.searchParams.set("open_filename", document.name);
	if (document.mimeType) {
		url.searchParams.set("open_mime", document.mimeType);
	}
	return `${url.pathname}${url.search}`;
}

function buildDocumentSourceHref(
	document: KnowledgeDocumentItem,
): string | null {
	if (!(document.originConversationId && document.originAssistantMessageId)) {
		return null;
	}
	return buildChatHref(
		document.originConversationId,
		document.originAssistantMessageId,
	);
}

/**
 * The serving route's URL for a stored picture's or clip's small thumb (a
 * clip's is its poster frame's); an incognito chat's file needs its chat named.
 */
function thumbSrc(fileId: string, conversationId: string | null): string {
	const query = new URLSearchParams({ variant: "thumb" });
	if (conversationId) query.set("conversationId", conversationId);
	return `/api/images/files/${encodeURIComponent(fileId)}?${query.toString()}`;
}

async function loadVideoBodies(
	userId: string,
	ids: string[],
): Promise<Map<string, ReturnType<typeof parseVideoVersionBody>>> {
	const bodies = new Map<string, ReturnType<typeof parseVideoVersionBody>>();
	if (ids.length === 0) return bodies;
	const rows = await db
		.select({ id: artifacts.id, contentText: artifacts.contentText })
		.from(artifacts)
		.where(and(eq(artifacts.userId, userId), inArray(artifacts.id, ids)));
	for (const row of rows) {
		bodies.set(row.id, parseVideoVersionBody(row.contentText));
	}
	return bodies;
}

async function loadChatTitles(
	userId: string,
	ids: string[],
): Promise<Map<string, string>> {
	const titles = new Map<string, string>();
	if (ids.length === 0) return titles;
	const rows = await db
		.select({ id: conversations.id, title: conversations.title })
		.from(conversations)
		.where(
			and(eq(conversations.userId, userId), inArray(conversations.id, ids)),
		);
	for (const row of rows) titles.set(row.id, row.title);
	return titles;
}

/** The body snippet of each row, cut in SQL around the first spelling found, never read whole. */
async function loadBodySnippets(
	entries: Array<{ rowId: string; words: string[]; terms: string[] }>,
): Promise<Map<string, string>> {
	const snippets = new Map<string, string>();
	await Promise.all(
		entries.map(async ({ rowId, words, terms }) => {
			const firstFound = sql.join(
				words
					.flatMap(wordSpellings)
					.map(
						(spelling) =>
							sql`nullif(instr(${artifacts.contentText}, ${spelling}), 0)`,
					),
				sql`, `,
			);
			const [row] = await db
				.select({
					cut: sql<
						string | null
					>`substr(${artifacts.contentText}, max(1, coalesce(${firstFound}, 1) - ${SNIPPET_BEFORE_CHARS}), ${SNIPPET_CUT_CHARS})`,
				})
				.from(artifacts)
				.where(eq(artifacts.id, rowId))
				.limit(1);
			const cut = row?.cut;
			if (!cut) return;
			const snippet =
				searchSnippet(cut, terms, SNIPPET_CHARS) ??
				(await foldedBodySnippet(rowId, terms)) ??
				cut.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
			if (snippet) snippets.set(rowId, snippet);
		}),
	);
	return snippets;
}

/**
 * The snippet of a body whose word no typed spelling locates (found by the
 * index through folding alone), cut from its whole text, for one row of the page.
 */
async function foldedBodySnippet(
	rowId: string,
	terms: readonly string[],
): Promise<string | null> {
	const [row] = await db
		.select({ contentText: artifacts.contentText })
		.from(artifacts)
		.where(eq(artifacts.id, rowId))
		.limit(1);
	return row?.contentText
		? foldedSnippet(row.contentText, terms, SNIPPET_CHARS)
		: null;
}

/** Everything a row of the page shows beyond the item itself, read for the rows on the page only. */
async function toResults(
	userId: string,
	query: DocumentQuery | null,
	entries: Array<
		Pick<
			RankedDocument,
			"item" | "rowId" | "match" | "bodyIndexes" | "searchKind" | "badge"
		>
	>,
): Promise<WorkspaceSearchDocumentResult[]> {
	if (entries.length === 0) return [];
	const items = await attachImagePreviews(
		userId,
		entries.map((entry) => entry.item),
	);
	const itemById = new Map(items.map((item) => [item.id, item]));
	const videoBodies = await loadVideoBodies(
		userId,
		items.filter((item) => item.kind === "video").map((item) => item.id),
	);
	const chatIds = Array.from(
		new Set(
			items
				.filter((item) => item.documentOrigin !== "uploaded")
				.map((item) => item.originConversationId ?? item.conversationId)
				.filter((id): id is string => Boolean(id)),
		),
	);
	const chatTitles = await loadChatTitles(userId, chatIds);
	const bodySnippets = query
		? await loadBodySnippets(
				entries
					.filter((entry) => entry.bodyIndexes.length > 0)
					.map((entry) => ({
						rowId: entry.rowId,
						words: entry.bodyIndexes.map(
							(index) => query.words[index] ?? query.terms[index],
						),
						terms: entry.bodyIndexes.map((index) => query.terms[index]),
					})),
			)
		: new Map<string, string>();

	return entries.map((entry) => {
		const item = itemById.get(entry.item.id) ?? entry.item;
		const video = videoBodies.get(item.id) ?? null;
		const chatId =
			item.documentOrigin === "uploaded"
				? null
				: (item.originConversationId ?? item.conversationId);
		const preview =
			item.kind === "image" && item.imagePreview
				? {
						src: thumbSrc(item.imagePreview.fileId, item.conversationId),
						width: item.imagePreview.width,
						height: item.imagePreview.height,
					}
				: video
					? {
							// The row's tile is 48 pixels: the poster's small thumb, not the full frame.
							src: thumbSrc(video.posterFileId, item.conversationId),
							width: video.width,
							height: video.height,
						}
					: null;
		const snippet =
			entry.match.snippet ?? bodySnippets.get(entry.rowId) ?? null;
		return {
			id: item.id,
			type: item.type,
			displayArtifactId: item.displayArtifactId,
			promptArtifactId: item.promptArtifactId,
			familyArtifactIds: item.familyArtifactIds,
			name: item.name,
			mimeType: item.mimeType,
			sizeBytes: item.sizeBytes,
			conversationId: item.conversationId,
			summary: item.summary,
			documentOrigin: item.documentOrigin,
			documentFamilyId: item.documentFamilyId,
			documentFamilyStatus: item.documentFamilyStatus,
			documentLabel: item.documentLabel,
			documentRole: item.documentRole,
			versionNumber: item.versionNumber,
			originConversationId: item.originConversationId,
			originAssistantMessageId: item.originAssistantMessageId,
			sourceChatFileId: item.sourceChatFileId,
			updatedAt: item.updatedAt,
			href: buildKnowledgeWorkspaceHref(item),
			sourceHref: buildDocumentSourceHref(item),
			kind: item.kind,
			searchKind: entry.searchKind,
			badge: entry.badge,
			originConversationTitle: chatId ? (chatTitles.get(chatId) ?? null) : null,
			preview,
			durationMs: video?.durationMs ?? null,
			match: { type: entry.match.type, snippet },
		};
	});
}

// ── The two entry points ─────────────────────────────────────────────────

/**
 * Documents, pictures, videos and apps that hold every word of the query, by
 * the fields each kind keeps its words in (a picture's prompt, a canvas's
 * words, a video's takes, what Alfy saw in an upload, never JSON or code),
 * best field first, newest first among equals. Each kind is counted up to the
 * cap. `scope: "all"` returns up to `window.limit` of each kind from the top;
 * a kind's scope returns that kind's page from `window.offset` and says whether
 * another follows; any other scope returns the counts alone.
 */
export async function searchDocuments(
	userId: string,
	query: DocumentQuery,
	scope: WorkspaceSearchScope,
	window: { offset: number; limit: number },
): Promise<{
	results: WorkspaceSearchDocumentResult[];
	totals: Pick<Record<WorkspaceSearchKind, number>, DocumentKind>;
	hasMore: boolean;
}> {
	const totals = { documents: 0, media: 0, apps: 0 };
	if (query.terms.length === 0) {
		return { results: [], totals, hasMore: false };
	}
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const ownership = buildArtifactCanonicalOwnershipCondition({
		userId,
		ownershipScope,
	});
	const candidates = await loadCandidates(userId, query, ownership);
	const items = await getLogicalDocumentsForArtifacts(
		userId,
		candidates.map((candidate) => candidate.row.id),
	);

	// One result per document: its best row.
	const byDocument = new Map<string, RankedDocument>();
	for (const candidate of candidates) {
		const item = items.get(candidate.row.id);
		if (!item) continue;
		const matched = matchFields(candidate, query.terms);
		if (!matched) continue;
		const { searchKind, badge } = searchKindAndBadge(item);
		const ranked: RankedDocument = {
			item,
			rowId: candidate.row.id,
			score: matched.score,
			match: matched.match,
			bodyIndexes: matched.bodyIndexes,
			searchKind,
			badge,
		};
		const existing = byDocument.get(item.displayArtifactId);
		if (!existing || compareRanked(ranked, existing) < 0) {
			byDocument.set(item.displayArtifactId, ranked);
		}
	}
	const byKind = new Map<DocumentKind, RankedDocument[]>(
		DOCUMENT_KINDS.map((kind) => [kind, []]),
	);
	for (const ranked of [...byDocument.values()].sort(compareRanked)) {
		byKind.get(ranked.searchKind)?.push(ranked);
	}
	for (const kind of DOCUMENT_KINDS) {
		totals[kind] = Math.min(byKind.get(kind)?.length ?? 0, SEARCH_COUNT_CAP);
	}

	let page: RankedDocument[] = [];
	let hasMore = false;
	if (scope === "all") {
		page = DOCUMENT_KINDS.flatMap((kind) =>
			(byKind.get(kind) ?? []).slice(0, window.limit),
		);
	} else if (scope === "documents" || scope === "media" || scope === "apps") {
		const ranked = byKind.get(scope) ?? [];
		page = ranked.slice(window.offset, window.offset + window.limit);
		hasMore = window.offset + window.limit < ranked.length;
	}
	return { results: await toResults(userId, query, page), totals, hasMore };
}

/**
 * The newest documents, for the view before anything is typed: the newest rows
 * of the person's library, read as documents, never the whole library.
 */
export async function recentDocuments(
	userId: string,
	limit: number,
): Promise<WorkspaceSearchDocumentResult[]> {
	if (limit <= 0) return [];
	const ownershipScope = await getArtifactOwnershipScope(userId);
	const ownership = buildArtifactCanonicalOwnershipCondition({
		userId,
		ownershipScope,
	});
	const newest = new Map<string, KnowledgeDocumentItem>();
	let rowLimit = limit * RECENT_ROWS_PER_DOCUMENT;
	for (let attempt = 0; attempt <= RECENT_WIDENINGS; attempt++) {
		const rows = await db
			.select({ id: artifacts.id })
			.from(artifacts)
			.where(and(ownership, ANY_DOCUMENT_ROWS_SQL))
			.orderBy(desc(artifacts.updatedAt), artifacts.id)
			.limit(rowLimit);
		const items = await getLogicalDocumentsForArtifacts(
			userId,
			rows.map((row) => row.id),
		);
		newest.clear();
		for (const row of rows) {
			const item = items.get(row.id);
			if (item && !newest.has(item.displayArtifactId)) {
				newest.set(item.displayArtifactId, item);
			}
		}
		if (newest.size >= limit || rows.length < rowLimit) break;
		rowLimit *= 2;
	}
	const page = [...newest.values()]
		.sort(
			(left, right) =>
				right.updatedAt - left.updatedAt ||
				left.displayArtifactId.localeCompare(right.displayArtifactId),
		)
		.slice(0, limit)
		.map((item) => ({
			item,
			rowId: item.id,
			match: { type: "recent" as const, snippet: null },
			bodyIndexes: [],
			...searchKindAndBadge(item),
		}));
	return toResults(userId, null, page);
}
