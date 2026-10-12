/**
 * What feeds the source ledger (`ledger.ts`): the places where a tool's answer
 * reaches the user's screen, each noting the hosts and thumbnail addresses it
 * carries before it does.
 *
 * - the tool recorder in `createNormalChatTools`, for every call the turn makes
 *   (`noteToolEntrySources`), so a favicon request never races its own entry;
 * - a read of a conversation, for what earlier turns stored
 *   (`noteMessageSources`; after a restart this is what fills the ledger again);
 * - the Atlas worker's progress and the conversation's Atlas cards
 *   (`noteAtlasProgressSources`, `noteAtlasJobSources`);
 * - the live-web block's search (`noteSourceUrls`);
 * - the page the context step reads for a link in the user's message
 *   (`noteWebPrefetch`).
 *
 * Only RESULTS count: a call's candidates, never its input, which is the
 * model's own words (`toolSourceHosts` in the shared contract).
 */
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type {
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";
import {
	extractUrlsFromValue,
	sourceHostOf,
	toolImages,
	toolSourceHosts,
} from "$lib/shared/url-provenance";
import { recordLedgerHosts, recordLedgerThumbnails } from "./ledger";
import { recordPrefetchAddresses } from "./prefetch";

type ToolCallSegment = Extract<ThinkingSegment, { type: "tool_call" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A recorded call as the stored segment it will become. */
function asSegment(entry: ToolCallEntry): ToolCallSegment {
	return {
		type: "tool_call",
		callId: entry.callId,
		name: entry.name,
		input: entry.input,
		status: entry.status,
		outputSummary: entry.outputSummary,
		resultDigest: entry.resultDigest,
		sourceType: entry.sourceType,
		candidates: entry.candidates,
		metadata: entry.metadata,
		map: entry.map,
	};
}

function noteSegments(
	userId: string,
	segments: readonly ThinkingSegment[],
): void {
	recordLedgerHosts(userId, toolSourceHosts(segments));
	recordLedgerThumbnails(
		userId,
		toolImages(segments).flatMap((image) =>
			image.thumbnail ? [image.thumbnail] : [],
		),
	);
}

/**
 * The hosts and thumbnail addresses one recorded tool call returned. Called by
 * the recorder as the call is recorded, which is before the stream tells the
 * browser the call is done.
 */
export function noteToolEntrySources(
	userId: string,
	entry: ToolCallEntry,
	options: {
		/**
		 * Which of the call's candidates may be noted. The turn's recorder keeps out
		 * a candidate whose address the model itself wrote into the call's input
		 * (a search that returns the address it was asked about), since a host the
		 * model chose is not a host a tool returned.
		 */
		keepCandidate?: (candidate: ToolEvidenceCandidate) => boolean;
	} = {},
): void {
	const segment = asSegment(entry);
	const { keepCandidate } = options;
	noteSegments(userId, [
		keepCandidate && segment.candidates
			? { ...segment, candidates: segment.candidates.filter(keepCandidate) }
			: segment,
	]);
}

/**
 * The hosts and thumbnail addresses the tool calls of these stored messages
 * returned. Called when a conversation, or an older page of it, is read for the
 * browser, so a reloaded chat's icons and pictures are answered again.
 */
export function noteMessageSources(
	userId: string,
	messages: ReadonlyArray<{
		thinkingSegments?: readonly ThinkingSegment[] | null;
	}>,
): void {
	noteSegments(
		userId,
		(messages ?? []).flatMap((message) => message?.thinkingSegments ?? []),
	);
}

/** The hosts of addresses a tool returned (a live-web block's search results). */
export function noteSourceUrls(
	userId: string,
	urls: Iterable<string | null | undefined>,
): void {
	const hosts: string[] = [];
	for (const url of urls) {
		const host = sourceHostOf(url);
		if (host) hosts.push(host);
	}
	recordLedgerHosts(userId, hosts);
}

/**
 * The hosts of the web sources an Atlas run has read so far, from the progress
 * details it stores on its job. A library document has no host and is skipped.
 */
export function noteAtlasProgressSources(
	userId: string,
	details: unknown,
): void {
	const evidence = isRecord(details) ? details.evidence : null;
	const sources =
		isRecord(evidence) && Array.isArray(evidence.sources)
			? evidence.sources
			: [];
	const hosts: string[] = [];
	for (const source of sources) {
		if (!isRecord(source) || source.kind === "local") continue;
		if (typeof source.host === "string" && source.host) {
			hosts.push(source.host);
		}
	}
	recordLedgerHosts(userId, hosts);
}

/** The same, for the Atlas cards a conversation read returns. */
export function noteAtlasJobSources(
	userId: string,
	jobs: ReadonlyArray<{ progress?: { details?: unknown } | null }>,
): void {
	for (const job of jobs ?? []) {
		noteAtlasProgressSources(userId, job?.progress?.details);
	}
}

/**
 * The page the context step read for the user before the model ran (a link in
 * the message), as the model is handed it: the sources of the finished
 * `fetch_url` exchange go to the ledger, since the tool row shows them, and every
 * address on the page is noted for the turn's provenance, since the model can
 * follow a link on it exactly as on a page it fetched itself.
 */
export function noteWebPrefetch(params: {
	userId: string;
	conversationId: string;
	toolCalls: readonly ToolCallEntry[];
	/** The exchange as handed to the model (empty when it was spliced in as text). */
	toolMessages: unknown;
}): void {
	for (const entry of params.toolCalls) {
		noteToolEntrySources(params.userId, entry);
	}
	recordPrefetchAddresses(params.userId, params.conversationId, [
		...params.toolCalls.flatMap((entry) =>
			(entry.candidates ?? []).map((candidate) => candidate.url),
		),
		...extractUrlsFromValue(params.toolMessages, 2_000),
	]);
}
