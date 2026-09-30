// A live-web block's two reads on the reader's behalf (Feature 2 · Canvas): the
// Refresh on a block that re-runs the search it stores, and a new search typed
// into the Insert menu. Both are a route by which a browser makes this server
// call a paid search provider, so they are held to the same few rules, all of
// them here and none in a route:
//
// - WHO: the board is resolved through THE scoped read (`readScopedArtifactRow`),
//   so a stranger's board, a missing id, an incognito chat's board read from
//   outside that chat and anything that is not a Canvas all answer alike
//   (`not_found`), before anything is searched.
// - WHAT RUNS: a Refresh runs the query STORED on the saved board, found by the
//   block's id, and nothing the client sent; a new search runs a query that is
//   valid text a block could keep. Never an address: the only thing sent out is a
//   short query, to the search provider the app already uses for a chat's own
//   `research_web` (its one module, `normal-chat-tools/research-web-tool.ts`,
//   ruling 57), with no page reads.
// - WHAT COMES BACK: only what a board may keep, built field by field from each
//   source and checked against the block's own shared schema. A link that is not a
//   web address is left out; a search that leaves nothing is `no_results` and
//   never blanks a snapshot.
// - HOW MUCH: a few a minute and a couple at once per reader (`canvas-web-limit.ts`),
//   each within a deadline, and stopped when the caller goes away.
// - WHAT IT WRITES: nothing. The snapshot goes back to the editor, and the board's
//   own save keeps it as the reader's version (one writer, so no save can be
//   refused because a refresh landed in between).
// - WHAT IT SAYS: nothing about the board or the query — no log line, and a failure
//   is a reason code, never the provider's own words.
import { randomUUID } from "node:crypto";
import { createResearchWebTool } from "$lib/server/services/normal-chat-tools/research-web-tool";
import type { ToolCallRecorder } from "$lib/server/services/normal-chat-tools/shared";
import { isHttpSourceUrl } from "$lib/shared/artifacts/block-urls";
import {
	BLOCK_DATA_SCHEMAS,
	type CanvasBlockData,
} from "$lib/shared/artifacts/canvas-blocks";
import { normalizeCanvasBody } from "$lib/shared/artifacts/canvas-body";
import {
	LABEL_MAX_CHARS,
	SOURCES_MAX,
} from "$lib/shared/artifacts/canvas-limits";
import type { CanvasWebFailure } from "$lib/shared/artifacts/live-web";
import type { ArtifactSource } from "$lib/shared/artifacts/sources";
import { acquireWebReadSlot } from "./canvas-web-limit";
import { kindForArtifactRow, readScopedArtifactRow } from "./record";
import type { ArtifactScopeOptions } from "./types";

type LiveWebData = Extract<CanvasBlockData, { kind: "liveweb" }>;

/**
 * How long one web read may take. The search tool has a 60 s ceiling of its own; this
 * is inside it, so the deadline that ends a read is always this one and the answer is
 * always a reason code.
 */
export const LIVEWEB_READ_TIMEOUT_MS = 45_000;

export type CanvasWebReadFailure = {
	ok: false;
	reason: CanvasWebFailure;
	/** Only for `rate_limited`: how long the reader is asked to wait. */
	retryAfterSeconds?: number;
};

export type RefreshCanvasLiveWebResult =
	| { ok: true; nodeId: string; data: LiveWebData }
	| CanvasWebReadFailure;

export type SearchCanvasLiveWebResult =
	| { ok: true; data: LiveWebData }
	| CanvasWebReadFailure;

const fail = (reason: CanvasWebFailure): CanvasWebReadFailure => ({
	ok: false,
	reason,
});

/** The HTTP status each reason answers with; the routes only look it up. */
export function canvasWebFailureStatus(reason: CanvasWebFailure): number {
	switch (reason) {
		case "not_found":
			return 404;
		case "invalid_query":
			return 400;
		case "rate_limited":
			return 429;
		default:
			return 422;
	}
}

/** What this read hands the search tool to record: nothing is kept of it. */
const NO_RECORDER: ToolCallRecorder = {
	record: (entry) => entry,
	getEntries: () => [],
};

/** A query a block could keep whole and a provider could search: text, at most a block's label, no control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function cleanQuery(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const query = value.trim();
	if (
		query.length === 0 ||
		query.length > LABEL_MAX_CHARS ||
		CONTROL_CHARACTER.test(query)
	) {
		return null;
	}
	return query;
}

const text = (value: unknown, fallback: string): string =>
	typeof value === "string" ? value : fallback;
const textOrNull = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

/**
 * One source as a block keeps it, built from the fields it keeps and no others, or
 * null for something that is not a usable source. The link is the rule that
 * matters: a source is something a reader may click.
 */
function keptSource(raw: unknown): ArtifactSource | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	if (
		typeof source.id !== "string" ||
		typeof source.title !== "string" ||
		!isHttpSourceUrl(source.url)
	) {
		return null;
	}
	return {
		id: source.id,
		title: source.title,
		url: source.url,
		provider: text(source.provider, ""),
		authorityClass: text(source.authorityClass, "unknown"),
		authorityScore:
			typeof source.authorityScore === "number" &&
			Number.isFinite(source.authorityScore)
				? source.authorityScore
				: 0,
		publishedAt: textOrNull(source.publishedAt),
		updatedAt: textOrNull(source.updatedAt),
		...(typeof source.snippet === "string" && source.snippet.length > 0
			? { snippet: source.snippet }
			: {}),
	};
}

/**
 * What the search tool answered, as a block's snapshot, or why it is not one. The
 * tool strips an empty list out of its payload, so a search that ran and found
 * nothing has no `sources` at all and no `error` (a failure carries its `error`):
 * that is `no_results`, and anything else that is not a list of sources is a
 * failed read.
 */
function snapshotFrom(
	answer: unknown,
	query: string,
): { ok: true; data: LiveWebData } | CanvasWebReadFailure {
	if (!answer || typeof answer !== "object") return fail("refresh_failed");
	const payload = answer as {
		sources?: unknown;
		error?: unknown;
		success?: unknown;
	};
	if (typeof payload.error === "string") return fail("refresh_failed");
	if (payload.sources === undefined && typeof payload.success === "boolean") {
		return fail("no_results");
	}
	const sources = payload.sources;
	if (!Array.isArray(sources)) return fail("refresh_failed");
	const kept: ArtifactSource[] = [];
	for (const raw of sources) {
		const source = keptSource(raw);
		if (source) kept.push(source);
		if (kept.length >= SOURCES_MAX) break;
	}
	if (kept.length === 0) return fail("no_results");
	const parsed = BLOCK_DATA_SCHEMAS.liveweb.safeParse({
		kind: "liveweb",
		query,
		sources: kept,
		fetchedAt: Date.now(),
	});
	return parsed.success
		? { ok: true, data: parsed.data }
		: fail("refresh_failed");
}

/**
 * Runs one search for a reader, inside the throttle and the deadline, and answers
 * the snapshot or a reason. Every way it can end — an answer, a failure, the
 * deadline, the caller leaving — frees the reader's place and answers a reason code.
 */
async function readWeb(params: {
	userId: string;
	query: string;
	signal?: AbortSignal;
}): Promise<{ ok: true; data: LiveWebData } | CanvasWebReadFailure> {
	// A caller that is already gone is not searched for.
	if (params.signal?.aborted) return fail("refresh_failed");
	const slot = acquireWebReadSlot(params.userId);
	if (!slot.ok) {
		return {
			ok: false,
			reason: "rate_limited",
			retryAfterSeconds: slot.retryAfterSeconds,
		};
	}

	const stop = new AbortController();
	const relay = () => stop.abort(params.signal?.reason);
	params.signal?.addEventListener("abort", relay, { once: true });
	const deadline = setTimeout(
		() => stop.abort(new Error("deadline")),
		LIVEWEB_READ_TIMEOUT_MS,
	);
	deadline.unref?.();
	try {
		// The search tool's cache is per conversation id, and its answer to the same
		// query is kept for half an hour: a session of its own for each read means a
		// refresh is always a new read, never the answer the chat cached earlier.
		const search = createResearchWebTool({
			userId: params.userId,
			conversationId: `canvas-live:${randomUUID()}`,
			turnId: randomUUID(),
			language: "en",
			recorder: NO_RECORDER,
		});
		// The tool ends itself at the signal, but a read is bounded by THIS deadline
		// whether or not it does.
		const ended = new Promise<never>((_, reject) => {
			stop.signal.addEventListener("abort", () => reject(new Error("ended")), {
				once: true,
			});
		});
		ended.catch(() => {});
		const answer = await Promise.race([
			search.execute(
				{ query: params.query },
				{ toolCallId: randomUUID(), messages: [], abortSignal: stop.signal },
			),
			ended,
		]);
		return snapshotFrom(answer, params.query);
	} catch {
		// Not the message: it can carry the provider's words, a key, the query.
		return fail("refresh_failed");
	} finally {
		clearTimeout(deadline);
		params.signal?.removeEventListener("abort", relay);
		slot.release();
	}
}

/** The saved board's node with this id, read the way the editor reads a board (a node the board would drop is not there). */
function storedNode(contentText: string | null, nodeId: string) {
	if (!contentText?.trim()) return null;
	try {
		const { body } = normalizeCanvasBody(JSON.parse(contentText));
		return body.nodes.find((node) => node.id === nodeId) ?? null;
	} catch {
		return null;
	}
}

/**
 * Re-runs the search a live-web block stores and answers its new snapshot. The
 * query is read from the SAVED board by the block's id, so nothing the client sends
 * decides what is searched. Writes nothing: the board's own save keeps the answer.
 * `null` scope options are the reader's own chats; `includeIncognito` is not a thing
 * a caller can ask for here.
 */
export async function refreshCanvasLiveWeb(
	params: {
		userId: string;
		artifactId: string;
		nodeId: string;
		signal?: AbortSignal;
	} & Pick<ArtifactScopeOptions, "conversationId">,
): Promise<RefreshCanvasLiveWebResult> {
	const row = await readScopedArtifactRow({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId ?? null,
	});
	if (!row || kindForArtifactRow(row) !== "canvas") return fail("not_found");

	const node = storedNode(row.contentText, params.nodeId);
	if (!node) return fail("not_found");
	// Only a live-web block stores a request that can be run again. A map's data is
	// the ROUTE the map tool returned, with no request of its own to repeat.
	if (node.type !== "liveweb" || node.data.kind !== "liveweb") {
		return fail("not_refreshable");
	}
	const query = cleanQuery(node.data.query);
	if (!query) return fail("not_refreshable");

	const read = await readWeb({
		userId: params.userId,
		query,
		signal: params.signal,
	});
	return read.ok ? { ok: true, nodeId: node.id, data: read.data } : read;
}

/**
 * Searches the web for a query typed into the Insert menu and answers the snapshot
 * a new live-web block starts from. The board is only the reader's scope: the
 * snapshot is placed, and saved, by the reader's own insert.
 */
export async function searchCanvasLiveWeb(
	params: {
		userId: string;
		artifactId: string;
		query: unknown;
		signal?: AbortSignal;
	} & Pick<ArtifactScopeOptions, "conversationId">,
): Promise<SearchCanvasLiveWebResult> {
	const row = await readScopedArtifactRow({
		userId: params.userId,
		artifactId: params.artifactId,
		conversationId: params.conversationId ?? null,
	});
	if (!row || kindForArtifactRow(row) !== "canvas") return fail("not_found");

	const query = cleanQuery(params.query);
	if (!query) return fail("invalid_query");

	return readWeb({
		userId: params.userId,
		query,
		signal: params.signal,
	});
}
