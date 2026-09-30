// "From this chat" (Feature 2 · Canvas): what a board's own conversation has
// that can be put on the board — its produced and attached files, its Apps, the
// route maps its `map_route` calls returned, the charts its replies drew, the
// photos its photo searches found and the sources its web searches returned —
// newest first, a few of each. The Insert menu offers them; a pick becomes a
// File, App, map, chart, photo or live-web block.
//
// This is a second way to read a conversation's work, so it reads nothing the
// artifact routes could not: the board is resolved through THE scoped read
// (an incognito chat's board answers only to a read that names that chat, a
// stranger's board and a missing id answer alike), the conversation it lists is
// the board's own, and every source is one the family already reads through its
// own service (`listArtifactsForConversation`, the file-production read model,
// the attachment list, the message window). Nothing here queries a table.
//
// What is listed is what would SURVIVE being saved: every block's data is
// checked against its own shared schema, and an item the schema would refuse
// (a route with a malformed payload, a chart past the code limit) is left out
// rather than offered as a block that vanishes on the next save.
import { listConversationGeneratedFiles } from "$lib/server/services/file-production/read-model";
import { listMessageAttachments } from "$lib/server/services/knowledge";
import { getArtifactOwnershipScope } from "$lib/server/services/knowledge/store/core";
import { listMessageWindow } from "$lib/server/services/messages";
import type {
	ChatAttachment,
	ChatMessage,
	ThinkingSegment,
} from "$lib/server/services/messages-types";
import { groundedWebSourcesFromCandidates } from "$lib/server/services/web-grounding";
import { classifyMarkdownBlocks } from "$lib/services/markdown-blocks";
import {
	isHttpSourceUrl,
	isPhotoProxyPath,
} from "$lib/shared/artifacts/block-urls";
import { BLOCK_DATA_SCHEMAS } from "$lib/shared/artifacts/canvas-blocks";
import {
	LABEL_MAX_CHARS,
	PHOTO_MAX_ITEMS,
	SOURCES_MAX,
} from "$lib/shared/artifacts/canvas-limits";
import {
	attachedFileId,
	type CanvasChatBlocks,
	CHAT_BLOCKS_PER_KIND,
	CHAT_BLOCKS_SCAN_MESSAGES,
	type ChatAppBlock,
	type ChatChartBlock,
	type ChatFileBlock,
	type ChatMapBlock,
	type ChatPhotoBlock,
	type ChatSearchBlock,
	emptyChatBlocks,
} from "$lib/shared/artifacts/chat-blocks";
import type { ArtifactSource } from "$lib/shared/artifacts/sources";
import { fileExtension } from "$lib/shared/file-types";
import { immichThumbnailUrl } from "$lib/utils/tool-evidence-presentation";
import { listArtifactsForConversation } from "./read-model";
import { kindForArtifactRow, readScopedArtifactRow } from "./record";
import type { ArtifactScopeOptions } from "./types";

function newestFirst<T extends { at: number; key: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** The file type the chat shows beside a file: its extension, in capitals. Empty for a file with none. */
function fileTypeLabel(filename: string): string {
	return fileExtension(filename).toUpperCase();
}

function fileBlock(params: {
	key: string;
	at: number;
	origin: ChatFileBlock["origin"];
	version: number | null;
	fileId: string;
	name: string;
	mime: string | null;
	bytes: number | null;
}): ChatFileBlock | null {
	const parsed = BLOCK_DATA_SCHEMAS.file.safeParse({
		kind: "file",
		fileId: params.fileId,
		name: params.name,
		mime: params.mime ?? "",
		bytes: params.bytes ?? 0,
		label: fileTypeLabel(params.name),
	});
	if (!parsed.success) return null;
	return {
		key: params.key,
		at: params.at,
		origin: params.origin,
		version: params.version,
		data: parsed.data,
	};
}

/** Produced files, and the uploaded files the reader attached to a message, as one list. */
async function listFiles(conversationId: string): Promise<ChatFileBlock[]> {
	const [produced, attachmentsByMessage] = await Promise.all([
		listConversationGeneratedFiles(conversationId),
		listMessageAttachments(conversationId),
	]);
	const files: ChatFileBlock[] = [];
	for (const file of produced) {
		const block = fileBlock({
			key: `file:${file.id}`,
			at: file.createdAt,
			origin: "produced",
			version: file.versionNumber ?? null,
			fileId: file.id,
			name: file.filename,
			mime: file.mimeType,
			bytes: file.sizeBytes,
		});
		if (block) files.push(block);
	}
	// One artifact attached to several messages is one file, at its newest link.
	const attached = new Map<string, ChatAttachment>();
	for (const attachments of attachmentsByMessage.values()) {
		for (const attachment of attachments) {
			if (attachment.type !== "source_document") continue;
			const seen = attached.get(attachment.artifactId);
			if (!seen || attachment.createdAt > seen.createdAt) {
				attached.set(attachment.artifactId, attachment);
			}
		}
	}
	for (const attachment of attached.values()) {
		const block = fileBlock({
			key: `attachment:${attachment.artifactId}`,
			at: attachment.createdAt,
			origin: "attached",
			version: null,
			fileId: attachedFileId(attachment.artifactId),
			name: attachment.name,
			mime: attachment.mimeType,
			bytes: attachment.sizeBytes,
		});
		if (block) files.push(block);
	}
	return newestFirst(files).slice(0, CHAT_BLOCKS_PER_KIND);
}

async function listApps(
	userId: string,
	conversationId: string,
): Promise<ChatAppBlock[]> {
	const rows = await listArtifactsForConversation({ userId, conversationId });
	const apps: ChatAppBlock[] = [];
	for (const row of rows) {
		if (row.kind !== "app") continue;
		const parsed = BLOCK_DATA_SCHEMAS.app.safeParse({
			kind: "app",
			artifactId: row.id,
			title: row.title,
		});
		if (!parsed.success) continue;
		apps.push({
			key: `app:${row.id}`,
			at: row.updatedAt,
			versionNumber: row.versionNumber,
			data: parsed.data,
		});
	}
	return newestFirst(apps).slice(0, CHAT_BLOCKS_PER_KIND);
}

/** The route maps a reply's finished `map_route` calls returned, newest call first. */
function mapsIn(message: ChatMessage): ChatMapBlock[] {
	const segments = message.thinkingSegments ?? [];
	const maps: ChatMapBlock[] = [];
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index];
		if (
			segment.type !== "tool_call" ||
			segment.name !== "map_route" ||
			segment.status !== "done" ||
			!segment.map
		) {
			continue;
		}
		const parsed = BLOCK_DATA_SCHEMAS.map.safeParse({
			kind: "map",
			route: "route",
			map: segment.map,
		});
		if (!parsed.success) continue;
		const action = segment.input?.action;
		maps.push({
			key: `map:${message.id}:${segment.callId ?? index}`,
			at: message.timestamp,
			action: typeof action === "string" ? action : null,
			map: parsed.data.map,
		});
	}
	return maps;
}

/** What a chart's own config says about itself: its title, when it has one, and its type. */
function chartFacts(code: string): {
	title: string | null;
	chartType: string | null;
} {
	try {
		const config = JSON.parse(code) as {
			type?: unknown;
			options?: { plugins?: { title?: { text?: unknown } } };
		};
		const text = config?.options?.plugins?.title?.text;
		const title = (Array.isArray(text) ? text.join(" ") : text) as unknown;
		return {
			title:
				typeof title === "string" && title.trim().length > 0
					? title.trim().slice(0, 200)
					: null,
			chartType: typeof config?.type === "string" ? config.type : null,
		};
	} catch {
		return { title: null, chartType: null };
	}
}

type Lexer = (source: string) => Parameters<typeof classifyMarkdownBlocks>[0];
let lexer: Promise<Lexer> | null = null;

/** The chat's own tokeniser and options, loaded once and only when a chat is listed. */
function loadLexer(): Promise<Lexer> {
	lexer ??= import("marked").then(
		({ marked }) =>
			(source) =>
				marked.lexer(source, { breaks: true, gfm: true }),
	);
	return lexer;
}

/** The charts a reply drew, last first: the chat's own block reading (`classifyMarkdownBlocks`), so a fence and a bar-column table both count. */
function chartsIn(
	message: ChatMessage,
	lex: Lexer,
	seenCode: Set<string>,
): ChatChartBlock[] {
	let blocks: ReturnType<typeof classifyMarkdownBlocks>;
	try {
		blocks = classifyMarkdownBlocks(lex(message.content));
	} catch {
		// A reply the tokeniser cannot read has no charts to offer; it must not
		// fail the listing of the rest.
		return [];
	}
	const codes = blocks
		.flatMap((block) => (block.kind === "chart" ? [block.code] : []))
		.reverse();
	const charts: ChatChartBlock[] = [];
	for (const [index, code] of codes.entries()) {
		if (seenCode.has(code)) continue;
		const facts = chartFacts(code);
		// A chart's own title heads its block, as it heads the chart.
		const parsed = BLOCK_DATA_SCHEMAS.chart.safeParse({
			kind: "chart",
			...(facts.title ? { label: facts.title } : {}),
			code,
		});
		if (!parsed.success) continue;
		seenCode.add(code);
		charts.push({
			key: `chart:${message.id}:${index}`,
			at: message.timestamp,
			...facts,
			data: parsed.data,
		});
	}
	return charts;
}

type ToolCall = Extract<ThinkingSegment, { type: "tool_call" }>;

/** A finished call of one tool that did not report a failure (a failed call is persisted as "done" too). */
function finishedCall(
	segment: ThinkingSegment,
	name: string,
): segment is ToolCall {
	return (
		segment.type === "tool_call" &&
		segment.name === name &&
		segment.status === "done" &&
		segment.metadata?.ok !== false
	);
}

function firstText(
	input: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = input?.[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim().slice(0, 200);
		}
	}
	return null;
}

/**
 * The photos one search found, as the chat's own strip reads them: each result
 * carries the path of its Immich thumbnail, which the chat maps to the app's own
 * proxy (`immichThumbnailUrl`). Whatever else a result carries (a file name, a
 * description) stays in the chat: the block holds the address and the asset id,
 * so a board that is read to a model discloses no more than the tool's own
 * structural fields do.
 */
function photoItems(call: ToolCall): { id: string; imageUrl: string }[] {
	const seen = new Set<string>();
	const items: { id: string; imageUrl: string }[] = [];
	for (const candidate of call.candidates ?? []) {
		const imageUrl = immichThumbnailUrl(candidate.metadata?.thumbnailPath);
		if (!imageUrl || !isPhotoProxyPath(imageUrl)) continue;
		const id = imageUrl.slice(imageUrl.lastIndexOf("/") + 1);
		if (id.length > 128 || seen.has(id)) continue;
		seen.add(id);
		items.push({ id, imageUrl });
		if (items.length >= PHOTO_MAX_ITEMS) break;
	}
	return items;
}

/** The photo searches a reply ran, newest call first. */
function photosIn(message: ChatMessage): ChatPhotoBlock[] {
	const segments = message.thinkingSegments ?? [];
	const photos: ChatPhotoBlock[] = [];
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index];
		if (!finishedCall(segment, "photos")) continue;
		const items = photoItems(segment);
		if (items.length === 0) continue;
		const parsed = BLOCK_DATA_SCHEMAS.photo.safeParse({ kind: "photo", items });
		if (!parsed.success) continue;
		photos.push({
			key: `photos:${message.id}:${segment.callId ?? index}`,
			at: message.timestamp,
			query: firstText(segment.input, [
				"query",
				"personName",
				"city",
				"country",
			]),
			data: parsed.data,
		});
	}
	return photos;
}

/**
 * The sources a web search returned, as a block keeps them (`ArtifactSource`, the
 * web-grounding payload's own shape): read back from the candidates the tool call
 * persisted through web-grounding's own inverse, so this module shapes nothing
 * itself. What it adds is the board's rule for a link: a source is kept only if its
 * link is a web address (the block's schema would drop the whole block for one that
 * is not), a page read that returned a source again does not list it twice, and a
 * block holds at most `SOURCES_MAX`.
 */
function searchSources(call: ToolCall): ArtifactSource[] {
	const seen = new Set<string>();
	const sources: ArtifactSource[] = [];
	for (const source of groundedWebSourcesFromCandidates(
		call.candidates ?? [],
	)) {
		if (!isHttpSourceUrl(source.url) || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
		if (sources.length >= SOURCES_MAX) break;
	}
	return sources;
}

/** A query as the chat would count it the same one: case and runs of spaces do not tell two searches apart. */
function queryKey(query: string): string {
	return query.replace(/\s+/g, " ").toLowerCase();
}

/**
 * The web searches a reply ran, newest call first. A search is a block that a
 * refresh re-runs, so its query is stored whole: a call with no query, or one
 * longer than a block keeps, is not offered. A query the chat searched more
 * than once is one row, at its newest run (`seenQueries` carries that across
 * replies, which are read newest first).
 */
function searchesIn(
	message: ChatMessage,
	seenQueries: Set<string>,
): ChatSearchBlock[] {
	const segments = message.thinkingSegments ?? [];
	const searches: ChatSearchBlock[] = [];
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index];
		if (!finishedCall(segment, "research_web")) continue;
		const rawQuery = segment.input?.query;
		if (typeof rawQuery !== "string") continue;
		const query = rawQuery.trim();
		if (query.length === 0 || query.length > LABEL_MAX_CHARS) continue;
		if (seenQueries.has(queryKey(query))) continue;
		const sources = searchSources(segment);
		if (sources.length === 0) continue;
		const parsed = BLOCK_DATA_SCHEMAS.liveweb.safeParse({
			kind: "liveweb",
			query,
			sources,
			fetchedAt: message.timestamp,
		});
		if (!parsed.success) continue;
		seenQueries.add(queryKey(query));
		searches.push({
			key: `search:${message.id}:${segment.callId ?? index}`,
			at: message.timestamp,
			data: parsed.data,
		});
	}
	return searches;
}

type Drawn = Pick<CanvasChatBlocks, "maps" | "charts" | "photos" | "searches">;

/** What the chat itself drew or found, read from its newest messages: route maps, charts, photo searches and web searches. */
async function listDrawn(conversationId: string): Promise<Drawn> {
	const [{ messages }, lex] = await Promise.all([
		listMessageWindow(conversationId, { limit: CHAT_BLOCKS_SCAN_MESSAGES }),
		loadLexer(),
	]);
	const drawn: Drawn = { maps: [], charts: [], photos: [], searches: [] };
	const seenCode = new Set<string>();
	const seenQueries = new Set<string>();
	const full = () =>
		drawn.maps.length >= CHAT_BLOCKS_PER_KIND &&
		drawn.charts.length >= CHAT_BLOCKS_PER_KIND &&
		drawn.photos.length >= CHAT_BLOCKS_PER_KIND &&
		drawn.searches.length >= CHAT_BLOCKS_PER_KIND;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (drawn.maps.length < CHAT_BLOCKS_PER_KIND) {
			drawn.maps.push(...mapsIn(message));
		}
		if (drawn.charts.length < CHAT_BLOCKS_PER_KIND) {
			drawn.charts.push(...chartsIn(message, lex, seenCode));
		}
		if (drawn.photos.length < CHAT_BLOCKS_PER_KIND) {
			drawn.photos.push(...photosIn(message));
		}
		if (drawn.searches.length < CHAT_BLOCKS_PER_KIND) {
			drawn.searches.push(...searchesIn(message, seenQueries));
		}
		if (full()) break;
	}
	return {
		maps: drawn.maps.slice(0, CHAT_BLOCKS_PER_KIND),
		charts: drawn.charts.slice(0, CHAT_BLOCKS_PER_KIND),
		photos: drawn.photos.slice(0, CHAT_BLOCKS_PER_KIND),
		searches: drawn.searches.slice(0, CHAT_BLOCKS_PER_KIND),
	};
}

/**
 * What the board's own chat has that the board can hold. `null` is "no such
 * board" — a missing id, another user's board, an incognito chat's board read
 * from outside that chat, and anything that is not a Canvas all answer it, so
 * the caller's 404 confirms nothing. A chat that has made nothing answers an
 * empty listing.
 */
export async function listCanvasChatBlocks(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<CanvasChatBlocks | null> {
	const row = await readScopedArtifactRow(params);
	if (!row || kindForArtifactRow(row) !== "canvas") return null;
	// A family row is readable only through a live chat, so a readable board
	// always has one; the check is for the type's sake.
	const conversationId = row.conversationId;
	if (!conversationId) return null;
	// The helpers below take a bare conversation id, so it is checked against
	// the caller's own scope first: a board can only ever list a chat that is
	// the caller's and reachable from where the read came from.
	const scope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId ?? null,
		includeIncognito: params.includeIncognito === true,
	});
	if (!scope.conversationIds.has(conversationId)) return emptyChatBlocks();

	const [files, apps, drawn] = await Promise.all([
		listFiles(conversationId),
		listApps(params.userId, conversationId),
		listDrawn(conversationId),
	]);
	return { files, apps, ...drawn };
}
