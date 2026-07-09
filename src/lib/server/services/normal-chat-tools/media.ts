import { z } from "zod";
import {
	type LibrarySection,
	PlexError,
	plexLibrarySections,
	plexWatchHistory,
	type WatchEntry,
} from "$lib/server/services/connections/providers/plex";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { decideLocalDistill } from "./connector-distill";

// Read-only by construction: this schema's `action` enum only ever lists
// read actions (watch_history, libraries). Plex NEVER gets a write path —
// there is no scrobble/markWatched/markPlayed/rate action here, not now and
// not in a later phase. A dedicated test in media.test.ts pins this enum.
export const mediaToolInputSchema = z.object({
	action: z.enum(["watch_history", "libraries"]),
	query: z.string().optional(),
	since: z.string().optional(),
	limit: z.number().optional(),
});

export type MediaToolInput = z.infer<typeof mediaToolInputSchema>;

export function sanitizeMediaToolInput(input: MediaToolInput): MediaToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.since ? { since: input.since.trim() } : {}),
		...(input.limit !== undefined ? { limit: input.limit } : {}),
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

export type MediaToolModelPayload = {
	success: boolean;
	name: "media";
	sourceType: "tool";
	action: MediaToolInput["action"];
	message: string;
	results: MediaToolWatchItem[];
	libraries: MediaToolLibraryItem[];
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

function citationLabel(item: MediaToolWatchItem): string {
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
	return `You have ${connections.length} Media connections (${labels}); using "${conn.label}" for this request.`;
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

// Redacts the MODEL-FACING citation labels once Option A distillation has
// applied — same rationale as photos.ts's/email.ts's redactCitationsForModel:
// citations[].label here is populated with the exact raw title/show name that
// Option A strips from `results[]`, so leaving it untouched would let the raw
// name reach the cloud model through `citations` even though
// `results[].title`/`show` were stripped two fields earlier in the same
// payload. `outcome.candidates` (the user's own Sources-tab list, built from
// the *original* unredacted entries before this gate ever runs) is left
// alone.
function redactCitationsForModel(
	results: MediaToolWatchItem[],
	citations: MediaCitation[],
): MediaCitation[] {
	return citations.map((citation, index) => {
		const viewedAt = results[index]?.viewedAt;
		return {
			...citation,
			label: viewedAt ? `Watched item at ${viewedAt}` : "Watched item",
		};
	});
}

// Locality Option A: watch history (what someone watches — show/movie
// titles) is sensitive personal data — when the user has opted in to local
// distillation and the selected chat model is cloud, replace it with a
// summary produced by a local model before it reaches the (cloud) model.
// This strips `title`/`show` from every result, and redacts
// `citations[].label` (see redactCitationsForModel) — i.e. the WHOLE
// model-facing payload, not just one field. `outcome.candidates` (the
// Sources-tab list) is untouched: it feeds the user's own screen, a
// different channel from what the model sees, and keeps the real titles.
// `libraries` (bare section names like "Movies"/"TV Shows") is not gated —
// it carries no personal watch data, only the shape of the user's own
// library.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: MediaToolInput;
	outcome: MediaToolOutcome;
}): Promise<MediaToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;
	if (outcome.modelPayload.action !== "watch_history") return outcome;

	const rawTextParts = outcome.modelPayload.results
		.map((item) => {
			const descriptors = [item.show, item.title].filter(
				(value): value is string => Boolean(value),
			);
			if (descriptors.length === 0) return null;
			return `${descriptors.join(" — ")} (${item.viewedAt})`;
		})
		.filter((value): value is string => Boolean(value));
	// Nothing raw to protect (e.g. every result is bare metadata with no
	// title/show) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const decision = await decideLocalDistill({
		userId,
		modelId,
		capability: "media",
		userQuestion: input.query ?? "",
		rawText: rawTextParts.join("\n"),
	});
	if (!decision.shouldDistill) return outcome;

	const strippedResults = outcome.modelPayload.results.map((item) => {
		const { title: _title, show: _show, ...rest } = item;
		return rest;
	});
	// Redact only the MODEL-facing copy — `outcome.candidates` (the
	// user-facing Sources-tab list) was already built from the original,
	// unredacted entries in `watchHistoryOutcome` and is untouched by this
	// gate.
	const redactedCitations = redactCitationsForModel(
		outcome.modelPayload.results,
		outcome.modelPayload.citations,
	);

	if ("distilled" in decision) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${decision.distilled}`,
				results: strippedResults,
				citations: redactedCitations,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"This watch history couldn't be privately summarized for a cloud model, so its details were withheld. Switch to a local model to view them, or try again.",
			results: strippedResults,
			citations: redactedCitations,
		},
	};
}

// Resolves the user's Media (Plex) connection(s) and executes a
// watch_history/libraries lookup, degrading gracefully (never throwing) so a
// connection problem never aborts the chat turn: no connection, ambiguity,
// and adapter failures all resolve to a `{ success: false, message }`-shaped
// payload instead. Read-only, and permanently so — Plex is analytics-only:
// there is no write action in mediaToolInputSchema and never will be.
export async function runMediaTool(
	userId: string,
	input: MediaToolInput,
	modelId: string,
): Promise<MediaToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "media");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Media connection set up yet. Connect your Plex server in Settings to check your watch history.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Media connection set up yet. Connect your Plex server in Settings to check your watch history.",
		});
	}

	try {
		if (input.action === "libraries") {
			const sections = await plexLibrarySections(userId, conn.id);
			return librariesOutcome(conn, sections, ambiguous, connections);
		}

		const entries = await plexWatchHistory(userId, conn.id, {
			...(input.since !== undefined ? { since: input.since } : {}),
			...(input.limit !== undefined ? { limit: input.limit } : {}),
			...(input.query !== undefined ? { query: input.query } : {}),
		});
		const outcome = watchHistoryOutcome(conn, entries, ambiguous, connections);
		return applyLocalDistillGate({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
