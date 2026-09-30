// "From this chat" (Feature 2 · Canvas): what a board's own conversation has
// that can be put on the board — its produced and attached files, its Apps, the
// route maps its `map_route` calls returned and the charts its replies drew —
// newest first, a few of each. The Insert menu offers them; a pick becomes a
// File, App, map or chart block.
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
} from "$lib/server/services/messages-types";
import { classifyMarkdownBlocks } from "$lib/services/markdown-blocks";
import { BLOCK_DATA_SCHEMAS } from "$lib/shared/artifacts/canvas-blocks";
import {
	attachedFileId,
	type CanvasChatBlocks,
	CHAT_BLOCKS_PER_KIND,
	CHAT_BLOCKS_SCAN_MESSAGES,
	type ChatAppBlock,
	type ChatChartBlock,
	type ChatFileBlock,
	type ChatMapBlock,
	emptyChatBlocks,
} from "$lib/shared/artifacts/chat-blocks";
import { fileExtension } from "$lib/shared/file-types";
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
	const codes = classifyMarkdownBlocks(lex(message.content))
		.flatMap((block) => (block.kind === "chart" ? [block.code] : []))
		.reverse();
	const charts: ChatChartBlock[] = [];
	for (const [index, code] of codes.entries()) {
		if (seenCode.has(code)) continue;
		const parsed = BLOCK_DATA_SCHEMAS.chart.safeParse({ kind: "chart", code });
		if (!parsed.success) continue;
		seenCode.add(code);
		charts.push({
			key: `chart:${message.id}:${index}`,
			at: message.timestamp,
			...chartFacts(code),
			data: parsed.data,
		});
	}
	return charts;
}

/** Route maps and charts, read from the chat's newest messages: what the chat itself drew. */
async function listDrawn(
	conversationId: string,
): Promise<Pick<CanvasChatBlocks, "maps" | "charts">> {
	const [{ messages }, lex] = await Promise.all([
		listMessageWindow(conversationId, { limit: CHAT_BLOCKS_SCAN_MESSAGES }),
		loadLexer(),
	]);
	const maps: ChatMapBlock[] = [];
	const charts: ChatChartBlock[] = [];
	const seenCode = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (maps.length < CHAT_BLOCKS_PER_KIND) maps.push(...mapsIn(message));
		if (charts.length < CHAT_BLOCKS_PER_KIND) {
			charts.push(...chartsIn(message, lex, seenCode));
		}
		if (
			maps.length >= CHAT_BLOCKS_PER_KIND &&
			charts.length >= CHAT_BLOCKS_PER_KIND
		) {
			break;
		}
	}
	return {
		maps: maps.slice(0, CHAT_BLOCKS_PER_KIND),
		charts: charts.slice(0, CHAT_BLOCKS_PER_KIND),
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
