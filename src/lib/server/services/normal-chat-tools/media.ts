import { z } from "zod";
import { withCapabilityConnection } from "$lib/server/services/connections/capability-read";
import {
	type ContinueWatchingItem,
	type LibrarySearchItem,
	type LibrarySearchResult,
	type LibrarySection,
	PlexError,
	plexLibrarySearch,
	plexLibrarySections,
	plexOnDeck,
	plexWatchHistory,
	type WatchEntry,
} from "$lib/server/services/connections/providers/plex";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { applyLocalDistillGate } from "./connector-distill";
import { noMatchingConnectionMessage } from "./shared";

// Read-only by construction: this schema's `action` enum only ever lists
// read actions (watch_history, libraries, continue_watching, library_search).
// Plex NEVER gets a write path — there is no scrobble/markWatched/
// markPlayed/rate action here, not now and not in a later phase. A dedicated
// test in media.test.ts pins this enum.
export const mediaToolInputSchema = z.object({
	action: z.enum([
		"watch_history",
		"libraries",
		"continue_watching",
		"library_search",
	]),
	query: z.string().optional(),
	since: z.string().optional(),
	limit: z.number().optional(),
	// Multi-connection disambiguation — target ONE specific Media (Plex)
	// connection when the user has more than one server. A provider name
	// ("plex"), a connection label, or the account identifier all work — see
	// selectConnection in resolve.ts. Omitted -> the first connection
	// alphabetically (see pickDefaultConnection); this tool is read-only, so
	// there is no write-preference branch.
	account: z.string().optional(),
});

export type MediaToolInput = z.infer<typeof mediaToolInputSchema>;

export function sanitizeMediaToolInput(input: MediaToolInput): MediaToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.since ? { since: input.since.trim() } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
		...(input.account ? { account: input.account.trim() } : {}),
	};
}

export type MediaCitation = { label: string; url: string };

// One watch-history entry as surfaced to the model. `title`/`show` are the
// "raw watch details" the locality Option-A distill gate (below) strips when
// active — mirrors calendar.ts keeping id/start/end while stripping summary/
// location. `type`/`viewedAt`/`season`/`episode`/`library` are structural
// metadata; only title/show carry a recognizable name of what was watched,
// so those are the fields treated as sensitive raw content.
export type MediaToolWatchItem = {
	title?: string;
	show?: string;
	season?: number;
	episode?: number;
	type: string;
	viewedAt: string;
	library?: string;
};

export type MediaToolLibraryItem = LibrarySection;

// GAP B2 (continue watching / on-deck) — same "raw watch details vs
// structural metadata" split as MediaToolWatchItem: title/show are the
// sensitive fields the Option A distill gate strips when active (see
// applyLocalDistillGate); season/episode/type/viewOffsetMs/durationMs/
// progress/library are structural. NOT a direct alias of
// ContinueWatchingItem (plex.ts's domain type, where `title` is always
// present) — here title/show must be optional so the stripped shape still
// type-checks after the gate removes them.
export type MediaToolOnDeckItem = {
	title?: string;
	show?: string;
	season?: number;
	episode?: number;
	type: string;
	viewOffsetMs?: number;
	durationMs?: number;
	progress?: number;
	library?: string;
};

// GAP B3 (library search) — the user's OWNED catalog, not a personal
// "what did I watch" signal, so this is NOT gated by Option A (same
// rationale as `libraries`/bare section names below: it carries the shape
// of the user's library, not their viewing behavior).
export type MediaToolLibrarySearchItem = LibrarySearchItem;

export type MediaToolModelPayload = {
	success: boolean;
	name: "media";
	sourceType: "tool";
	action: MediaToolInput["action"];
	message: string;
	results: MediaToolWatchItem[];
	libraries: MediaToolLibraryItem[];
	onDeck: MediaToolOnDeckItem[];
	librarySearch: MediaToolLibrarySearchItem[];
	// The true match count for library_search (see LibrarySearchResult.
	// totalCount) — not capped by `librarySearch.length`.
	libraryMatchCount: number;
	citations: MediaCitation[];
};

export type MediaToolOutcome = {
	modelPayload: MediaToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

function toToolWatchItem(entry: WatchEntry): MediaToolWatchItem {
	return {
		title: entry.title,
		...(entry.show ? { show: entry.show } : {}),
		...(entry.season !== undefined ? { season: entry.season } : {}),
		...(entry.episode !== undefined ? { episode: entry.episode } : {}),
		type: entry.type,
		viewedAt: entry.viewedAt,
		...(entry.library ? { library: entry.library } : {}),
	};
}

function toToolOnDeckItem(entry: ContinueWatchingItem): MediaToolOnDeckItem {
	return {
		title: entry.title,
		...(entry.show ? { show: entry.show } : {}),
		...(entry.season !== undefined ? { season: entry.season } : {}),
		...(entry.episode !== undefined ? { episode: entry.episode } : {}),
		type: entry.type,
		...(entry.viewOffsetMs !== undefined
			? { viewOffsetMs: entry.viewOffsetMs }
			: {}),
		...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
		...(entry.progress !== undefined ? { progress: entry.progress } : {}),
		...(entry.library ? { library: entry.library } : {}),
	};
}

// Shared by watch_history and continue_watching citations — both item shapes
// carry the same optional title/show pair.
function citationLabel(item: { title?: string; show?: string }): string {
	if (item.show && item.title) return `${item.show} — ${item.title}`;
	if (item.title) return item.title;
	return "(watched item)";
}

function toCandidate(citation: MediaCitation): ToolEvidenceCandidate {
	return {
		id: `media:${citation.label}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.label,
		sourceType: "tool",
	};
}

function buildPayload(params: {
	success: boolean;
	action: MediaToolInput["action"];
	message: string;
	results?: MediaToolWatchItem[];
	libraries?: MediaToolLibraryItem[];
	onDeck?: MediaToolOnDeckItem[];
	librarySearch?: MediaToolLibrarySearchItem[];
	libraryMatchCount?: number;
	citations?: MediaCitation[];
	candidates?: ToolEvidenceCandidate[];
}): MediaToolOutcome {
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "media",
			sourceType: "tool",
			action: params.action,
			message: params.message,
			results: params.results ?? [],
			libraries: params.libraries ?? [],
			onDeck: params.onDeck ?? [],
			librarySearch: params.librarySearch ?? [],
			libraryMatchCount: params.libraryMatchCount ?? 0,
			citations,
		},
		candidates: params.candidates ?? citations.map(toCandidate),
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	const other = connections.find((c) => c.id !== conn.id);
	return `You have ${connections.length} Media connections (${labels}); using "${conn.label}" for this request.${other ? ` Pass account:"${other.label}" to use ${other.label} instead.` : ""}`;
}

function withAmbiguityPrefix(
	message: string,
	ambiguous: boolean,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	return ambiguous ? `${ambiguityNote(conn, connections)} ${message}` : message;
}

function mapAdapterError(err: unknown): string {
	if (err instanceof PlexError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your Plex connection needs to be reconnected before I can access your watch history. Please reconnect it in Settings.";
			case "connection_not_found":
				return "Your Plex connection couldn't be found. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your media right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your media right now. Please try again in a moment.";
}

function watchHistoryOutcome(
	conn: ConnectionPublic,
	entries: WatchEntry[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): MediaToolOutcome {
	const items = entries.map(toToolWatchItem);
	const citations: MediaCitation[] = items.map((item) => ({
		label: citationLabel(item),
		url: "",
	}));
	const candidates = citations.map(toCandidate);
	const message =
		items.length === 0
			? "No watch history found."
			: `Found ${items.length} watched ${items.length === 1 ? "item" : "items"}.`;
	return buildPayload({
		success: true,
		action: "watch_history",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		results: items,
		citations,
		candidates,
	});
}

function librariesOutcome(
	conn: ConnectionPublic,
	sections: LibrarySection[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): MediaToolOutcome {
	const message =
		sections.length === 0
			? "No library sections found."
			: `Found ${sections.length} library ${sections.length === 1 ? "section" : "sections"}.`;
	return buildPayload({
		success: true,
		action: "libraries",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		libraries: sections,
	});
}

// GAP B2 — continue watching / on-deck. Builds citations/candidates the same
// way watchHistoryOutcome does (Sources tab keeps the real title/show; the
// Option A gate below may redact the model-facing copy).
function onDeckOutcome(
	conn: ConnectionPublic,
	entries: ContinueWatchingItem[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): MediaToolOutcome {
	const items = entries.map(toToolOnDeckItem);
	const citations: MediaCitation[] = items.map((item) => ({
		label: citationLabel(item),
		url: "",
	}));
	const candidates = citations.map(toCandidate);
	const message =
		items.length === 0
			? "Nothing is currently in progress or up next."
			: `Found ${items.length} ${items.length === 1 ? "item" : "items"} to continue watching.`;
	return buildPayload({
		success: true,
		action: "continue_watching",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		onDeck: items,
		citations,
		candidates,
	});
}

// GAP B3 — library search. Not gated by Option A (see MediaToolLibrarySearchItem).
function librarySearchOutcome(
	conn: ConnectionPublic,
	result: LibrarySearchResult,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): MediaToolOutcome {
	const { items, totalCount } = result;
	const shown = items.length < totalCount ? ` (showing ${items.length})` : "";
	const message =
		totalCount === 0
			? "No matching titles found in your library."
			: `Found ${totalCount} matching ${totalCount === 1 ? "title" : "titles"} in your library${shown}.`;
	return buildPayload({
		success: true,
		action: "library_search",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		librarySearch: items,
		libraryMatchCount: totalCount,
	});
}

// Redacts the MODEL-FACING citation labels once Option A distillation has
// applied — same rationale as photos.ts's/email.ts's redactCitationsForModel:
// citations[].label here is populated with the exact raw title/show name that
// Option A strips from `results[]`/`onDeck[]`, so leaving it untouched would
// let the raw name reach the cloud model through `citations` even though the
// title/show fields were stripped two fields earlier in the same payload.
// `outcome.candidates` (the user's own Sources-tab list, built from the
// *original* unredacted entries before this gate ever runs) is left alone.
// `fallbackLabel` differs by action: watch_history items are things already
// watched, continue_watching items may not be ("up next" episodes with no
// progress yet), so the generic label shouldn't claim otherwise.
function redactCitationsForModel(
	items: { viewedAt?: string }[],
	citations: MediaCitation[],
	fallbackLabel: string,
): MediaCitation[] {
	return citations.map((citation, index) => {
		const viewedAt = items[index]?.viewedAt;
		return {
			...citation,
			label: viewedAt ? `Watched item at ${viewedAt}` : fallbackLabel,
		};
	});
}

// Locality Option A: watch history AND continue-watching/on-deck data (both
// reveal what someone watches — show/movie titles, the latter arguably more
// sensitive since it's what they're watching *right now*) are sensitive
// personal data — when the user has opted in to local distillation and the
// selected chat model is cloud, replace it with a summary produced by a
// local model before it reaches the (cloud) model. This strips `title`/
// `show` from every result, and redacts `citations[].label` (see
// redactCitationsForModel) — i.e. the WHOLE model-facing payload, not just
// one field. `outcome.candidates` (the Sources-tab list) is untouched: it
// feeds the user's own screen, a different channel from what the model sees,
// and keeps the real titles. `libraries` (bare section names) and
// `library_search` (owned catalog, not viewing behavior) are not gated — see
// MediaToolLibrarySearchItem's doc comment.
function distillMediaReadOutcome(params: {
	userId: string;
	modelId: string;
	input: MediaToolInput;
	outcome: MediaToolOutcome;
}): Promise<MediaToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	const action = outcome.modelPayload.action;
	// Only watch_history / continue_watching carry raw viewing data; anything
	// else has no raw text so the gate would be a no-op anyway. An empty rawText
	// below short-circuits the shared gate to a no-op — but the guard also keeps
	// the field-shape logic (results vs onDeck) below well-defined.
	const isHistory = action === "watch_history";

	// Loosely typed to the fields this gate actually needs — both
	// MediaToolWatchItem (viewedAt required) and MediaToolOnDeckItem (no
	// viewedAt at all) satisfy it structurally.
	const items: { title?: string; show?: string; viewedAt?: string }[] =
		action === "watch_history" || action === "continue_watching"
			? isHistory
				? outcome.modelPayload.results
				: outcome.modelPayload.onDeck
			: [];

	const rawText = items
		.map((item) => {
			const descriptors = [item.show, item.title].filter(
				(value): value is string => Boolean(value),
			);
			if (descriptors.length === 0) return null;
			const label = descriptors.join(" — ");
			return isHistory ? `${label} (${item.viewedAt})` : label;
		})
		.filter((value): value is string => Boolean(value))
		.join("\n");

	// Redact only the MODEL-facing copy — `outcome.candidates` (the
	// user-facing Sources-tab list) was already built from the original,
	// unredacted entries in watchHistoryOutcome/onDeckOutcome and is
	// untouched by this gate.
	const redactedCitations = () =>
		redactCitationsForModel(
			items,
			outcome.modelPayload.citations,
			isHistory ? "Watched item" : "Continue-watching item",
		);
	const withheldMessage = `This ${isHistory ? "watch history" : "continue-watching list"} couldn't be privately summarized for a cloud model, so its details were withheld. Switch to a local model to view them, or try again.`;

	const strippedField = () =>
		isHistory
			? {
					results: outcome.modelPayload.results.map((item) => {
						const { title: _title, show: _show, ...rest } = item;
						return rest;
					}),
				}
			: {
					onDeck: outcome.modelPayload.onDeck.map((item) => {
						const { title: _title, show: _show, ...rest } = item;
						return rest;
					}),
				};

	return applyLocalDistillGate({
		outcome,
		userId,
		modelId,
		capability: "media",
		userQuestion: input.query ?? "",
		rawText,
		onDistilled: (o, distilled) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: `${o.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`,
				...strippedField(),
				citations: redactedCitations(),
			},
		}),
		onUnavailable: (o) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: withheldMessage,
				...strippedField(),
				citations: redactedCitations(),
			},
		}),
	});
}

// Resolves the user's Media (Plex) connection(s) and executes a
// watch_history/libraries/continue_watching/library_search lookup,
// degrading gracefully (never throwing) so a connection problem never aborts
// the chat turn: no connection, ambiguity, and adapter failures all resolve
// to a `{ success: false, message }`-shaped payload instead. Read-only, and
// permanently so — Plex is analytics-only: there is no write action in
// mediaToolInputSchema and never will be.
export async function runMediaTool(
	userId: string,
	input: MediaToolInput,
	modelId: string,
): Promise<MediaToolOutcome> {
	const notConnectedMessage =
		"You don't have a Media connection set up yet. Connect your Plex server in Settings to check your watch history.";

	const result = await withCapabilityConnection(
		userId,
		"media",
		{ account: input.account },
		async (conn, { ambiguous, connections }): Promise<MediaToolOutcome> => {
			try {
				if (input.action === "libraries") {
					const sections = await plexLibrarySections(userId, conn.id);
					return librariesOutcome(conn, sections, ambiguous, connections);
				}

				if (input.action === "continue_watching") {
					const items = await plexOnDeck(userId, conn.id, {
						...(input.limit !== undefined ? { limit: input.limit } : {}),
					});
					const outcome = onDeckOutcome(conn, items, ambiguous, connections);
					return distillMediaReadOutcome({ userId, modelId, input, outcome });
				}

				if (input.action === "library_search") {
					const result = await plexLibrarySearch(userId, conn.id, {
						...(input.query !== undefined ? { query: input.query } : {}),
						...(input.limit !== undefined ? { limit: input.limit } : {}),
					});
					return librarySearchOutcome(conn, result, ambiguous, connections);
				}

				const entries = await plexWatchHistory(userId, conn.id, {
					...(input.since !== undefined ? { since: input.since } : {}),
					...(input.limit !== undefined ? { limit: input.limit } : {}),
					...(input.query !== undefined ? { query: input.query } : {}),
				});
				const outcome = watchHistoryOutcome(
					conn,
					entries,
					ambiguous,
					connections,
				);
				return distillMediaReadOutcome({ userId, modelId, input, outcome });
			} catch (err) {
				return buildPayload({
					success: false,
					action: input.action,
					message: mapAdapterError(err),
				});
			}
		},
	);

	if (result.kind === "not-connected") {
		return buildPayload({
			success: false,
			action: input.action,
			message: notConnectedMessage,
		});
	}
	if (result.kind === "no-match") {
		return buildPayload({
			success: false,
			action: input.action,
			message: noMatchingConnectionMessage(
				"Media",
				result.selector,
				result.connections,
			),
		});
	}
	return result.value;
}
