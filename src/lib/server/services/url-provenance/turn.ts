/**
 * Where an address a tool is asked to open came from, for one chat turn.
 *
 * `fetch_url` sends any address it is given to a service that fetches it, and
 * `produce_file` makes the document renderer fetch (or embed) any `https` image
 * it is given. The model chooses those addresses, and the model reads pages and
 * messages a stranger may have written, so an address it picks may carry private
 * data in its path, query or subdomain. The rule (docs/plans/exfil-channels): an
 * address is opened only when it came from the user's own messages or from a
 * tool's result, never from the model's words. This is that check, in code,
 * because a prompt rule is only as strong as the model that reads it.
 *
 * An address is allowed when its `provenanceKey` (the shared comparison form:
 * host, port, path and query exactly, scheme, `www.` and fragment ignored) is one
 * of:
 * - an address in the turn's own user message (not stored yet while the turn
 *   runs, so it comes from the tool context), a bare `example.com/page` included;
 * - an address in a stored user message of this conversation;
 * - an address in a result a tool handed the model earlier in this turn;
 * - an address a tool returned in an earlier turn (stored candidates and result
 *   digests);
 * - an address on the page the context step read for the user before the turn
 *   (`prefetch.ts`).
 *
 * Two kinds of result are not provenance, because their text is the model's own:
 * a tool that returns what the model wrote (`run_python`'s output, a file the
 * model produced, an artifact it made) and, in every counted result, an address
 * the model itself put in the call's input (a search that echoes its query would
 * otherwise turn any address into a "result"). `NON_PROVENANCE_RESULT_TOOLS`
 * names the first kind; a test refuses a registered tool that is in neither list,
 * so a new tool is a decision, not a default.
 *
 * Built lazily: the turn's own results are noted as they arrive, but the stored
 * messages are read only when an address first needs them.
 */
import type {
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";
import {
	extractUrls,
	extractUrlsFromValue,
	provenanceKey,
} from "$lib/shared/url-provenance";
import { prefetchAddressKeys } from "./prefetch";

/** What the stored messages of a conversation say (the messages service's read). */
export interface StoredProvenanceSources {
	/** The user's own message texts, newest first. */
	userTexts: readonly string[];
	/** Every tool call stored on the assistant's messages. */
	toolCalls: ReadonlyArray<Extract<ThinkingSegment, { type: "tool_call" }>>;
}

/**
 * Tools whose results bring addresses in from outside the model's own words: the
 * web, the user's connected accounts and stored documents, memory and skills.
 * (`read_generated_file` counts only for a document the user supplied; see
 * `resultCountsAsProvenance`.)
 */
export const PROVENANCE_RESULT_TOOLS: ReadonlySet<string> = new Set([
	"research_web",
	"fetch_url",
	"image_search",
	"memory_context",
	"read_generated_file",
	"files",
	"calendar",
	"contacts",
	"email",
	"photos",
	"media",
	"location",
	"repos",
	"tasks",
	"map_route",
	"use_skill",
]);

/**
 * Tools whose results are the model's own text coming back (what `run_python`
 * printed, an artifact or file it made, the acknowledgement of its own offer):
 * an address in them proves nothing about where the address came from.
 */
export const NON_PROVENANCE_RESULT_TOOLS: ReadonlySet<string> = new Set([
	"run_python",
	"produce_file",
	"create_artifact",
	"read_artifact",
	"edit_artifact",
	"suggest_instruction",
	"done",
]);

/** The most addresses one set of keys holds: a hostile page cannot grow it past this. */
const MAX_KEYS = 20_000;
/** The most characters of one user message that are read for addresses. */
const MAX_USER_TEXT_CHARS = 500_000;
/** The most characters of stored user messages read in all (newest first). */
const MAX_STORED_USER_CHARS = 2_000_000;
/** The most addresses read from one user message. */
const MAX_ADDRESSES_PER_TEXT = 500;
/** The most addresses read from one tool result (a long page carries many links). */
const MAX_ADDRESSES_PER_RESULT = 2_000;

/**
 * Whether a tool's result is a source of addresses. `read_generated_file` reads
 * both a file the model produced (its words) and a document the user uploaded or
 * linked (the user's): only the second counts.
 */
export function resultCountsAsProvenance(
	toolName: string,
	metadata?: Record<string, string | number | boolean | null> | null,
): boolean {
	if (toolName === "read_generated_file")
		return metadata?.source === "document";
	return PROVENANCE_RESULT_TOOLS.has(toolName);
}

function addKey(target: Set<string>, url: unknown): void {
	if (target.size >= MAX_KEYS) return;
	const key = provenanceKey(url);
	if (key) target.add(key);
}

/** The keys of the addresses the model wrote into a call's own input. */
function inputKeys(input: unknown): Set<string> {
	const keys = new Set<string>();
	for (const url of extractUrlsFromValue(input)) addKey(keys, url);
	return keys;
}

function addUserTextKeys(target: Set<string>, text: string): number {
	const scanned = text.slice(0, MAX_USER_TEXT_CHARS);
	for (const url of extractUrls(scanned, {
		bareDomains: true,
		limit: MAX_ADDRESSES_PER_TEXT,
	})) {
		addKey(target, url);
	}
	return scanned.length;
}

/** The keys of every address a conversation's stored messages make known. */
export function provenanceKeysOfStoredSources(
	sources: StoredProvenanceSources,
): Set<string> {
	const keys = new Set<string>();
	let budget = MAX_STORED_USER_CHARS;
	for (const text of sources.userTexts) {
		if (budget <= 0) break;
		budget -= addUserTextKeys(keys, text);
	}
	for (const call of sources.toolCalls) {
		if (!resultCountsAsProvenance(call.name, call.metadata)) continue;
		// What the model itself wrote into a call's input is not made a result by
		// coming back: a search that returns the address it was asked about, or a
		// digest that echoes it, says nothing about where the address came from.
		const own = inputKeys(call.input);
		// The sources a tool reported are results: the server writes a call's
		// candidates from what the tool returned.
		for (const candidate of call.candidates ?? []) {
			const key = provenanceKey(candidate.url);
			if (key && !own.has(key)) addKey(keys, candidate.url);
		}
		// The digest is a slice of what the model was handed.
		for (const url of extractUrls(call.resultDigest)) {
			const key = provenanceKey(url);
			if (key && !own.has(key)) addKey(keys, url);
		}
	}
	return keys;
}

/** A tool result the model has just been handed. */
export interface ToolResultObservation {
	toolName: string;
	/** The payload as the model received it. */
	payload: unknown;
	/** The call as it is being recorded: its input and the candidates it returned. */
	entry?: Pick<ToolCallEntry, "input" | "candidates" | "metadata">;
}

/** Addresses split by whether their source is known. */
export interface AddressPartition {
	/** The addresses whose source is known, as the model wrote them, in order. */
	allowed: string[];
	/** How many were refused. Never the addresses themselves: they are the model's words. */
	refusedCount: number;
}

export interface TurnUrlProvenance {
	/** Notes the addresses of a result the model has just been handed. Synchronous. */
	noteToolResult(result: ToolResultObservation): void;
	/** Splits the addresses a tool was asked to open into allowed and refused. */
	partition(urls: readonly string[]): Promise<AddressPartition>;
	/**
	 * Whether the turn already knows where this address came from: the user's own
	 * message, a result noted this turn, the prefetched page, or an address a call
	 * was already allowed to open. Synchronous, and never reads the database.
	 */
	isKnown(url: unknown): boolean;
}

export interface TurnUrlProvenanceParams {
	userId: string;
	conversationId: string;
	/** The turn's own user message: it is not stored while the turn runs. */
	requestText?: string;
	/** Reads what the conversation's stored messages say (the messages service). */
	loadStored: () => Promise<StoredProvenanceSources>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export function createTurnProvenance(
	params: TurnUrlProvenanceParams,
): TurnUrlProvenance {
	const turnKeys = new Set<string>();
	let requestKeys: Set<string> | null = null;
	let storedLoad: Promise<ReadonlySet<string>> | null = null;

	const requestKeysOnce = (): ReadonlySet<string> => {
		if (!requestKeys) {
			requestKeys = new Set();
			if (params.requestText) addUserTextKeys(requestKeys, params.requestText);
		}
		return requestKeys;
	};

	const knownWithoutStore = (key: string): boolean =>
		requestKeysOnce().has(key) ||
		turnKeys.has(key) ||
		Boolean(
			prefetchAddressKeys(params.userId, params.conversationId)?.has(key),
		);

	// A failed read is not remembered (the next call tries again) and reads as
	// "nothing stored": the address is refused, never allowed on a guess.
	const storedKeysOnce = (): Promise<ReadonlySet<string>> => {
		storedLoad ??= params
			.loadStored()
			.then((sources) => provenanceKeysOfStoredSources(sources))
			.catch(() => {
				storedLoad = null;
				return NO_KEYS;
			});
		return storedLoad;
	};

	return {
		noteToolResult({ toolName, payload, entry }) {
			if (!resultCountsAsProvenance(toolName, entry?.metadata)) return;
			// What the model itself wrote into the call's input is not made a result
			// by coming back (a search that returns, or a payload that echoes, the
			// address it was asked about).
			const own = inputKeys(entry?.input);
			for (const candidate of entry?.candidates ?? []) {
				const key = provenanceKey(candidate.url);
				if (key && !own.has(key)) addKey(turnKeys, candidate.url);
			}
			for (const url of extractUrlsFromValue(
				payload,
				MAX_ADDRESSES_PER_RESULT,
			)) {
				const key = provenanceKey(url);
				if (key && !own.has(key)) addKey(turnKeys, url);
			}
		},

		isKnown(url) {
			const key = provenanceKey(url);
			return key !== null && knownWithoutStore(key);
		},

		async partition(urls) {
			const keys = urls.map((url) => provenanceKey(url));
			// Decide what the cheap sets can, so a turn whose addresses all came from
			// the user or from this turn's results never reads the database.
			const allowedAt = keys.map(
				(key) => key !== null && knownWithoutStore(key),
			);
			if (keys.some((key, index) => key !== null && !allowedAt[index])) {
				const stored = await storedKeysOnce();
				keys.forEach((key, index) => {
					if (key !== null && !allowedAt[index] && stored.has(key)) {
						allowedAt[index] = true;
					}
				});
			}
			const allowed = urls.filter((_, index) => allowedAt[index]);
			// An address a call was allowed to open stays known for the rest of the
			// turn: the page it returns carries it as a source, and that source is the
			// user's own link, not something the model made up.
			for (const url of allowed) addKey(turnKeys, url);
			return { allowed, refusedCount: urls.length - allowed.length };
		},
	};
}
