// Unified tool activity rows — the pure presentation layer behind
// `ToolActivityRow.svelte`.
//
// Every tool call the chat renders (live while thinking, inside the expanded
// thinking rail, and as a pinned deliverable) goes through ONE row shape:
//
//   [status glyph] [tool icon] verb object ................ meta [chevron]
//
// This module owns the grammar (which verb, which object, which right-hand
// fact) and the body view-model (what the opened panel shows). It is pure:
// nothing Svelte-reactive, no `$t` store import — the translator is threaded
// in as a plain `Translate` parameter, exactly like
// `tool-evidence-presentation.ts` already does, so every branch here is
// directly unit-testable with a fake translator.

import type { VideoCardView } from "$lib/components/artifacts/video/video-card-view";
import type { I18nKey } from "$lib/i18n";
// Type-only: erased at build time, so this pure browser module never carries
// the artifacts service's own server code (client/api/artifacts.ts already
// crosses this same boundary the same way).
import type { ArtifactCardSummary } from "$lib/server/services/artifacts/types";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { ImageCardView } from "$lib/server/services/images/read-model";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ToolCallMapData } from "$lib/server/services/messages-types";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { formatByteSize } from "$lib/utils/format";
import {
	formatConnectionToolAction,
	getConnectionToolLabelKey,
	getHumanReadableToolNameKey,
	getToolCallIconType,
	type ToolCallIconType,
} from "$lib/utils/tool-calls";
import {
	candidateReason,
	dedupeSourcesByUrl,
	extractHostname,
	type FetchedSource,
	formatToolCall,
	getFetchUrlSources,
	isCitedSource,
	orderCitedFirst,
	stripToPlainText,
	type ToolCallSegment,
	type Translate,
} from "$lib/utils/tool-evidence-presentation";
import {
	type ReasonKind,
	readReasonCode,
	resolveToolReason,
} from "$lib/utils/tool-reason-words";

/**
 * `skipped`: it ended with nothing done and nothing wrong, as a declined write does.
 * `closed`: a question the person shut with the X instead of answering it; drawn as a
 * muted X, because nothing failed and nothing was done either.
 */
export type ToolActivityStatus =
	| "running"
	| "done"
	| "failed"
	| "skipped"
	| "closed";

/**
 * A runtime mirror of `ArtifactKind` (`$lib/shared/artifacts/kinds`, a
 * type-only import) — narrows a tool-call metadata string field, which
 * cannot carry the type itself across the wire.
 */
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
	"document",
	"app",
	"canvas",
	"slides",
	"file",
];

/**
 * A source under a search or read row. `fromInput` marks one taken from the
 * addresses the call was GIVEN rather than from what it returned: those are the
 * model's own words (a prompt injection can put private data in a host), so a row
 * never asks for the favicon of such a host (docs/plans/exfil-channels).
 */
export type ToolWebSource = FetchedSource & { fromInput?: true };

/** The opened panel under a row. One variant per tool shape in the mockup. */
export type ToolActivityBody =
	| { kind: "sources"; sources: ToolWebSource[]; citedCount: number }
	| { kind: "page"; sources: ToolWebSource[]; excerpt: string | null }
	| { kind: "python"; program: string; output: string | null }
	| { kind: "map"; map: ToolCallMapData; summary: string }
	| { kind: "text"; text: string }
	| { kind: "bullets"; items: string[] }
	| {
			kind: "actions";
			actions: { key: string; label: string; status: ToolActivityStatus }[];
	  }
	// One sentence, in the person's language, from a reason code's words (never
	// from `outputSummary`, `metadata.error` or anything else written for the model
	// or the log): what happened, once.
	| { kind: "reason"; text: string }
	// The file-production body is rendered by FileProductionCard.svelte (the
	// reduced, body-only component); the job itself is threaded through the
	// component prop rather than flattened here.
	| { kind: "file-job" }
	// A successful create_artifact/edit_artifact call (Feature 2, the
	// cross-kind in-chat card): ArtifactCard's own chrome="body" rendering for
	// every kind but File. `preview` is never computed here — this module is
	// pure and has no access to ConversationDetail.artifacts — the caller
	// (ThinkingBlock.svelte) attaches it from the conversation's own artifact
	// summaries when one exists (after a reload, or once the turn's own
	// refresh catches up); live, mid-turn, it stays undefined and the card
	// falls back to its kind's generic body.
	| {
			kind: "artifact";
			artifactId: string;
			artifactKind: ArtifactKind;
			artifactTitle: string;
			preview?: ArtifactCardSummary;
	  }
	// Wave 2.5 Step 12/13: a create_artifact call still RUNNING, once its own
	// call arguments already name a kind and a title (the model supplied
	// both) — a skeleton standalone card, never a real id (there is none
	// yet). edit_artifact's call arguments carry neither (only artifactId +
	// patches), so an in-flight edit never gets this body — see
	// `buildSettledToolActivityItem`'s own note on the running branch.
	| { kind: "artifact-creating"; artifactKind: ArtifactKind; title: string }
	// A SETTLED, business-level refusal (`ok: false`) of a create_artifact
	// call — never edit_artifact, whose refusal keeps falling through to the
	// generic identity/body below unchanged (tool-activity.test.ts's own
	// pinned "shows the refusal, not a deliverable" rule). Distinct from a
	// hard transport failure (`status === "failed"`), which already gets its
	// own red-row-plus-error-body treatment elsewhere in this file.
	| {
			kind: "artifact-failed";
			artifactKind: ArtifactKind;
			title: string;
			reason: string | null;
	  }
	// Same arrangement for an Atlas report: AtlasActivityBody.svelte renders the
	// panel (stage line + plan while running, Report/Evidence/Plan tabs when
	// done), threaded in as a snippet by AtlasActivityRow.svelte.
	| { kind: "atlas" }
	// And for a connection write once it is settled: what it was, threaded in
	// by WriteConfirmCard.svelte.
	| { kind: "write" }
	// A question Alfy asked once it no longer waits ("Ask me first"): each
	// question with the answer the person gave, as `buildAskFoldedItem`
	// (components/chat/ask-card-view.ts) worded it. A card the person closed has no
	// body: there is nothing to show but the line.
	| { kind: "ask"; pairs: Array<{ question: string; answer: string }> }
	// A make_image call's picture card (plan 2b T2): the card itself is found
	// by the chat page's image cards, by `cardId`, or while the call still runs
	// by the take whose tool call this is (`cardId` null until the call names it).
	| {
			kind: "image-card";
			cardId: string | null;
			takeId: string | null;
			title: string;
			/** The card, attached by the message from the chat's image cards (never computed here). */
			card?: ImageCardView | null;
	  }
	// A make_video call's clip card (video plan, slice 3): the card is found by
	// the chat page's video cards, by `cardId`, or while the call still runs by
	// the take whose tool call this is (`cardId` null until the call names it).
	| {
			kind: "video-card";
			cardId: string | null;
			takeId: string | null;
			title: string;
			/** The card, attached by the message from the chat's video cards (never computed here). */
			card?: VideoCardView | null;
	  };

export type ToolActivityItem = {
	key: string;
	status: ToolActivityStatus;
	iconType: ToolCallIconType;
	/** Muted leading word ("Searched", "Reading", "Created"). */
	verb: string;
	/** Primary text — the thing the tool acted on. May be empty. */
	object: string;
	/** Muted text right after the object, for a row whose object alone would mislead ("· left to Alfy", "· closed"). */
	objectSuffix?: string;
	/** Right-hand fact ("6 sources", "27 km · 34 min", "12 KB", "Failed"). */
	meta: string;
	/** Short label for the collapsed summary strip ("Searched 6 sources"). */
	summaryLabel: string;
	/**
	 * What repeats of this tool ADD UP TO in the collapsed strip: the unit
	 * names the quantity, `summaryCount` carries this row's share of it (5
	 * sources, 1 page, 3 connector actions, 4 memories). A tool with nothing
	 * countable (Python, a skill, a route) leaves both unset and its repeats
	 * fold into a "×N" instead.
	 */
	summaryUnit?: "sources" | "pages" | "actions" | "memories";
	summaryCount?: number;
	/** A deliverable stays visible (with its body open) when the block collapses. */
	pinned: boolean;
	/** A file-production row is always open — row + body read as one element. */
	alwaysOpen: boolean;
	body: ToolActivityBody | null;
	/** Full text for the row's native tooltip. */
	title: string;
	/**
	 * The item a create_artifact / edit_artifact row is about, and whether the
	 * call failed. A reply draws one card per item however many calls worked on it,
	 * and a failed attempt that a later call made good is no row of the reply
	 * (`foldArtifactDeliverables`): both need to know which item a row is about.
	 */
	artifact?: { id: string | null; failed: boolean };
};

const VERB_KEYS = {
	searched: "toolActivity.searched",
	searching: "toolActivity.searching",
	searchedImages: "toolActivity.searchedImages",
	searchingImages: "toolActivity.searchingImages",
	read: "toolActivity.read",
	reading: "toolActivity.reading",
	ranPython: "toolActivity.ranPython",
	runningPython: "toolActivity.runningPython",
	route: "toolActivity.route",
	routing: "toolActivity.routing",
	transit: "toolActivity.transit",
	planningTransit: "toolActivity.planningTransit",
	timetable: "toolActivity.timetable",
	loadingTimetable: "toolActivity.loadingTimetable",
	journey: "toolActivity.journey",
	planningJourney: "toolActivity.planningJourney",
	created: "toolActivity.created",
	makingPicture: "toolActivity.makingPicture",
	madePicture: "toolActivity.madePicture",
	changedPicture: "toolActivity.changedPicture",
	pictureFailed: "toolActivity.pictureFailed",
	pictureStopped: "toolActivity.pictureStopped",
	pictureStillMaking: "toolActivity.pictureStillMaking",
	pictureRequestAdjusted: "toolActivity.pictureRequestAdjusted",
	pictureBlocked: "toolActivity.pictureBlocked",
	pictureNotMade: "toolActivity.pictureNotMade",
	creating: "toolActivity.creating",
	edited: "toolActivity.edited",
	editing: "toolActivity.editing",
	editFailed: "toolActivity.editFailed",
	createFailed: "toolActivity.createFailed",
	usedSkill: "toolActivity.usedSkill",
	usingSkill: "toolActivity.usingSkill",
	recalled: "toolActivity.recalled",
	recalling: "toolActivity.recalling",
	// Not a verb to put an object after: the whole photos row, with its count.
	photosViewed: "toolActivity.photosViewed",
} as const satisfies Record<string, I18nKey>;

type VerbName = keyof typeof VERB_KEYS;

/**
 * Every string the Atlas activity row and its body can print. Kept as its own
 * list (and folded into TOOL_ACTIVITY_I18N_KEYS below) so the one dictionary
 * test covers the Atlas grammar too — an Atlas row that lost a translation
 * would otherwise print a raw key in the chat.
 */
const ATLAS_ACTIVITY_I18N_KEYS: readonly I18nKey[] = [
	"atlasActivity.verb",
	"atlasActivity.questionsProgress",
	"atlasActivity.stopped",
	"atlasActivity.stoppedNote",
	"atlasActivity.cancelledAfter",
	"atlasActivity.cancelled",
	"atlasActivity.phase.plan",
	"atlasActivity.phase.research",
	"atlasActivity.phase.index",
	"atlasActivity.phase.write",
	"atlasActivity.phase.verify",
	"atlasActivity.phase.render",
	"atlasActivity.sourcesRead",
	"atlasActivity.sections",
	"atlasActivity.then",
	"atlasActivity.stop",
	"atlasActivity.planLabel",
	"atlasActivity.questionQueued",
	"atlasActivity.questionRunning",
	"atlasActivity.questionDone",
	"atlasActivity.tabsLabel",
	"atlasActivity.tab.report",
	"atlasActivity.tab.evidence",
	"atlasActivity.tab.plan",
	"atlasActivity.reportMeta",
	"atlasActivity.reportMetaWithSections",
	"atlasActivity.download",
	"atlasActivity.format.pdf",
	"atlasActivity.format.html",
	"atlasActivity.format.markdown",
	"atlasActivity.formatWithSize",
	"atlasActivity.confidence",
	"atlasActivity.evidenceSummary",
	"atlasActivity.confidence.corroborated",
	"atlasActivity.confidence.single",
	"atlasActivity.confidence.mixed",
	"atlasActivity.confidence.thin",
	"atlasActivity.moreSources",
	"atlasActivity.moreSourcesFiltered",
	"atlasActivity.filteredOnly",
	"atlasActivity.revise",
	"atlasActivity.continue",
	"atlasActivity.fork",
	"atlasActivity.retry",
	"atlasActivity.retryNote",
	"atlasActivity.retryPrompt",
	"atlasActivity.progressLabel",
	"atlas.defaultTitle",
	"atlas.durationMinutes",
	"atlas.durationSeconds",
	"atlas.failed",
	"atlas.sourceCount",
	"atlas.stage.failed",
	"atlas.stage.queued",
	"atlas.stage.running",
];

/**
 * Every i18n key an activity row can render — the verbs above plus the few
 * non-verb strings the rows and their bodies use. Exported so one test can
 * assert the whole set resolves in BOTH dictionaries: a missing verb would
 * otherwise only surface as a raw key printed in the UI.
 */
export const TOOL_ACTIVITY_I18N_KEYS: readonly I18nKey[] = [
	...Object.values(VERB_KEYS),
	"toolActivity.scratchProgram",
	"toolActivity.memoriesCount",
	"toolActivity.transfersCount",
	"toolActivity.departuresCount",
	"toolActivity.transitWalk",
	"toolActivity.transitStops",
	"toolActivity.summaryTimes",
	"toolActivity.summaryRepeat",
	"toolActivity.summaryFailedCount",
	"toolActivity.summaryMemories",
	"toolActivity.sourcesEyebrow",
	"toolActivity.program",
	"toolActivity.output",
	"toolActivity.expandActivity",
	"toolActivity.retriedOnce",
	// The route card's step-by-step body (RouteItinerary.svelte) draws these;
	// they ride the same resolution test rather than a second one of their own.
	"routeItinerary.directions",
	"routeItinerary.showAllSteps",
	"routeItinerary.showFewerSteps",
	"routeItinerary.otherDepartures",
	"routeItinerary.change",
	"routeItinerary.cycle",
	"routeItinerary.drive",
	"routeItinerary.cyclingDirections",
	"routeItinerary.drivingDirections",
	"routeItinerary.via",
	"routeItinerary.climb",
	"routeItinerary.toward",
	"routeItinerary.platform",
	"routeItinerary.minutes",
	"routeItinerary.leaveArrive",
	"routeItinerary.arriveBy",
	"routeItinerary.changesCount",
	"routeItinerary.modeCar",
	"routeItinerary.modeWalk",
	"routeItinerary.modeBike",
	"routeItinerary.modeTransit",
	"toolCalls.failed",
	"toolCalls.sourcesCount",
	"toolCalls.citedCount",
	"toolCalls.readPagesCount",
	"toolCalls.actionsCount",
	...ATLAS_ACTIVITY_I18N_KEYS,
];

/**
 * The words a row says on its own line besides a reason's sentence (the sentences
 * are the registry's, `tool-reason-words.ts`): what a search that found nothing says
 * on its right, the verbs a stop on purpose puts in front of its object, counts and
 * units. They live in `i18n/tool-rows.ts`; one test asserts each resolves in both
 * languages, so a row cannot print a raw key.
 */
export const TOOL_ROW_I18N_KEYS: readonly I18nKey[] = [
	"toolRows.meta.nothingFound",
];

function verb(
	translate: Translate,
	running: VerbName,
	settled: VerbName,
	status: ToolActivityStatus,
): string {
	return translate(VERB_KEYS[status === "running" ? running : settled]);
}

/**
 * The sources shown under a search/read row. Prefers the call's own web
 * candidates (they carry real titles, citation status and excerpts) and falls
 * back to the URLs the call was given, so a read row never renders empty.
 */
export function getToolWebSources(segment: ToolCallSegment): ToolWebSource[] {
	// The URL fallback below reads the call's INPUTS, which is only meaningful
	// for a read-a-page call. A search's query is not a source, even when it
	// happens to contain a URL.
	const allowUrlInputFallback =
		getToolCallIconType(segment.name) !== "web-search";
	const fromCandidates = (segment.candidates ?? [])
		.filter((candidate) => candidate.sourceType === "web" && candidate.url)
		.map((candidate) => {
			const reason = candidateReason(candidate);
			return {
				title: stripToPlainText(
					candidate.title || extractHostname(candidate.url ?? ""),
				),
				url: candidate.url as string,
				status: candidate.status,
				reason: reason ? stripToPlainText(reason) : undefined,
			};
		});
	if (fromCandidates.length > 0) {
		return orderCitedFirst(dedupeSourcesByUrl(fromCandidates));
	}
	return allowUrlInputFallback
		? getFetchUrlSources(segment.name, segment.input).map((source) => ({
				...source,
				fromInput: true as const,
			}))
		: [];
}

function citedCount(sources: FetchedSource[]): number {
	return sources.filter(isCitedSource).length;
}

function firstStringInput(input: Record<string, unknown>): string {
	return String(Object.values(input ?? {})[0] ?? "").trim();
}

const IMAGE_REASON_KEYS: Record<string, I18nKey> = {
	image_server_unreachable: "toolActivity.pictureReason.unreachable",
	image_graph_rejected: "toolActivity.pictureReason.rejected",
	image_render_failed: "toolActivity.pictureReason.renderFailed",
	image_render_timeout: "toolActivity.pictureReason.renderTimeout",
	image_result_missing: "toolActivity.pictureReason.resultMissing",
	image_input_missing: "toolActivity.pictureReason.inputMissing",
	image_server_not_configured: "toolActivity.pictureReason.notConfigured",
	not_configured: "toolActivity.pictureReason.notConfigured",
	image_request_invalid: "toolActivity.pictureReason.requestInvalid",
	image_blocked: "toolActivity.pictureReason.blocked",
	image_unchecked: "toolActivity.pictureReason.unchecked",
};

/** The explicit-picture filter's codes: the row says the picture was blocked, not that making it failed. */
const IMAGE_FILTER_ERRORS = new Set(["image_blocked", "image_unchecked"]);

/**
 * The localized reason for a make_image row that did not make its picture; null
 * when the person has nothing to act on. A refusal (too many takes, a repeated
 * retry, an unknown picture name...) is mostly a correction for the model, which
 * recovers by itself; only the refusals the person must act on — no server, an
 * explicit request, H3's missing transparency — get words here.
 */
function imageReasonKey(
	metadata: Record<string, string | number | boolean | null> | undefined,
): I18nKey | null {
	const code = metadata?.imageError;
	if (typeof code === "string" && IMAGE_REASON_KEYS[code]) {
		return IMAGE_REASON_KEYS[code];
	}
	const refusal = metadata?.imageRefusal;
	if (typeof refusal === "string") {
		if (refusal === "not_configured") {
			return "toolActivity.pictureReason.notConfigured";
		}
		if (refusal === "explicit_request") {
			return "toolActivity.pictureReason.explicitRequest";
		}
		if (refusal === "transparent_unavailable") {
			return "toolActivity.pictureReason.transparentUnavailable";
		}
		return metadata?.imageUnreadable === true
			? "toolActivity.pictureReason.unreadable"
			: null;
	}
	return "toolActivity.pictureReason.generic";
}

/**
 * The object shown for a `run_python` row: the program's first comment line,
 * else a neutral "scratch program". Never the whole program — that lives in
 * the body.
 */
export function runPythonObject(
	input: Record<string, unknown>,
	translate: Translate,
): string {
	const code = typeof input.code === "string" ? input.code : "";
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) {
			const comment = trimmed.replace(/^#+\s*/, "").trim();
			if (comment) return comment.slice(0, 120);
		}
		if (trimmed.length > 0) break;
	}
	return translate("toolActivity.scratchProgram");
}

export function formatMapDistance(meters: number | undefined): string {
	if (meters == null || !Number.isFinite(meters)) return "";
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1)} km`;
}

export function formatMapDuration(seconds: number | undefined): string {
	if (seconds == null || !Number.isFinite(seconds)) return "";
	const mins = Math.round(seconds / 60);
	if (mins < 60) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem > 0 ? `${hours} h ${rem} min` : `${hours} h`;
}

function mapRouteLabel(map: ToolCallMapData): string {
	if (map.originLabel && map.destinationLabel) {
		return `${map.originLabel} → ${map.destinationLabel}`;
	}
	return map.originLabel ?? map.destinationLabel ?? "";
}

function mapMeta(map: ToolCallMapData): string {
	return [formatMapDistance(map.distanceM), formatMapDuration(map.durationS)]
		.filter((part) => part.length > 0)
		.join(" · ");
}

/**
 * The right-hand fact for a public-transport row. A journey is measured in
 * time and changes ("1 h 12 min · 1 transfer"); a "next departures" lookup is
 * measured in how many it found ("6 departures"). Distance is deliberately
 * absent: nobody asks how many kilometres a bus ride is.
 */
function transitMeta(map: ToolCallMapData, translate: Translate): string {
	if (map.departures) {
		return translate("toolActivity.departuresCount", {
			count: map.departures.length,
		});
	}
	const parts = [formatMapDuration(map.durationS)];
	if (map.transfers !== undefined) {
		parts.push(
			translate("toolActivity.transfersCount", { count: map.transfers }),
		);
	}
	return parts.filter((part) => part.length > 0).join(" · ");
}

/**
 * The right-hand fact for a mixed-mode journey: how long the whole trip takes
 * and which modes it uses, in order and without repeats ("3 h 32 min · bike,
 * train, walk"). Distance is left out for the same reason it is on a transit
 * row — a journey is measured in time, not kilometres.
 */
function journeyMeta(map: ToolCallMapData, translate: Translate): string {
	const modeKeys: I18nKey[] = [];
	for (const leg of map.transitLegs ?? []) {
		const key: I18nKey =
			leg.type === "pt"
				? "routeItinerary.modeTransit"
				: leg.type === "bike"
					? "routeItinerary.modeBike"
					: leg.type === "drive"
						? "routeItinerary.modeCar"
						: "routeItinerary.modeWalk";
		if (!modeKeys.includes(key)) modeKeys.push(key);
	}
	const modes = modeKeys
		.map((key) => translate(key).toLocaleLowerCase())
		.join(", ");
	return [formatMapDuration(map.durationS), modes]
		.filter((part) => part.length > 0)
		.join(" · ");
}

function memoryBullets(candidates: ToolEvidenceCandidate[]): string[] {
	return candidates
		.map((candidate) => stripToPlainText(candidate.title ?? ""))
		.filter((title) => title.length > 0)
		.slice(0, 8);
}

/**
 * A call still marked running in a reply that is over was cut off: the person
 * pressed Stop, or the reply ended some other way before the call's closing event
 * came. It reads as the quiet stop, never as a spinner that cannot end. The row is
 * built as the settled call it would have been, with the shared `stopped` code (and
 * the flags a picture's and a clip's own rows read their Stop from).
 */
function endedAsStopped(segment: ToolCallSegment): ToolCallSegment {
	const metadata: Record<string, string | number | boolean | null> = {
		...segment.metadata,
		reasonCode: "stopped",
	};
	if (segment.name === "make_image") metadata.imageStopped = true;
	if (segment.name === "make_video") metadata.videoStopped = true;
	return { ...segment, status: "done", metadata };
}

/** What a call's outcome says: its kind, and its one sentence (none when the row's own words say it all). */
type RowReason = { kind: ReasonKind; text: string | null };

/**
 * The outcome a call carries, from its reason code, or from the fact that it failed
 * with no code at all (a call saved before codes, or a code a newer server wrote
 * that this one does not know): then its tool's own fallback sentence. A call that
 * simply worked has none. Nothing here reads `outputSummary`, `metadata.error` or
 * any input: those are the model's and the log's, never a person's.
 */
function describeReason(
	segment: ToolCallSegment,
	translate: Translate,
): RowReason | null {
	const metadata = segment.metadata;
	const code = readReasonCode(segment.name, metadata);
	const failed = segment.status === "failed" || metadata?.ok === false;
	if (code === null && !failed) return null;
	// The person's own word for a place a route could not find; a sentence about a
	// place that names none would print its placeholder, so it reads as the
	// route's fallback instead.
	const place =
		typeof metadata?.reasonPlace === "string"
			? metadata.reasonPlace.trim()
			: "";
	const artifactKind =
		typeof metadata?.artifactKind === "string" ? metadata.artifactKind : null;
	let words = resolveToolReason(segment.name, code, { artifactKind });
	if (words.code === "place_not_found" && !place) {
		words = resolveToolReason(segment.name, null);
	}
	return {
		kind: words.kind,
		text: words.key
			? translate(words.key, place ? { place } : undefined)
			: null,
	};
}

/**
 * Draws a row's outcome on top of the grammar its tool gave it. The glyph and the
 * colour come from the code's kind, never from the stored `status` (which stays
 * what the server wrote, because the history the model reads is derived from it):
 * something broke is the red cross; a stop the app made on purpose, or a setting
 * the person can change, is the quiet dash; information and "nothing found" stay
 * done. The tool's own label stays (a failed read is still "Read <host>"); only the
 * glyph, the right-hand word and the body change.
 */
function withReason(
	item: ToolActivityItem,
	reason: RowReason,
	translate: Translate,
): ToolActivityItem {
	const sentence: ToolActivityBody | null = reason.text
		? { kind: "reason", text: reason.text }
		: null;
	// A failed create or edit already says so in its own verb ("Couldn't edit").
	const saysItself = Boolean(item.artifact?.failed);
	switch (reason.kind) {
		case "fail": {
			const failedMeta = translate("toolCalls.failed");
			return {
				...item,
				status: "failed",
				meta: saysItself ? item.meta : failedMeta,
				summaryLabel: saysItself
					? item.summaryLabel
					: `${item.verb} ${failedMeta}`,
				// A call that failed contributed nothing to count up.
				summaryCount: 0,
				// Nothing failed is a deliverable, and nothing failed pins itself open.
				pinned: false,
				alwaysOpen: false,
				body: sentence,
			};
		}
		case "stop":
			return {
				...item,
				status: "skipped",
				meta: "",
				summaryLabel: saysItself ? item.summaryLabel : item.verb,
				summaryCount: 0,
				pinned: false,
				alwaysOpen: false,
				body: sentence,
			};
		case "empty":
			return {
				...item,
				status: "done",
				meta: translate("toolRows.meta.nothingFound"),
				summaryLabel: item.verb,
				summaryCount: 0,
				pinned: false,
				alwaysOpen: false,
				body: null,
			};
		case "info":
			return {
				...item,
				status: "done",
				// A line of information never takes the place of what the call found.
				body: item.body ?? sentence,
			};
	}
}

/**
 * Builds the view-model for one non-connector tool call.
 *
 * A failed call keeps the SAME label a successful one would have had ("Read
 * weather.metoffice.gov.uk", not a neutral tool name): per the approved
 * mockup, only the status glyph and the right-hand word change, and the body
 * becomes the reason. So the grammar is built first, and the outcome is applied
 * on top of it.
 *
 * `options.turnEnded`: the reply this call belongs to is over, so a call still
 * marked running was cut off and reads as stopped.
 */
export function buildToolActivityItem(
	segment: ToolCallSegment,
	key: string,
	translate: Translate,
	options?: { turnEnded?: boolean },
): ToolActivityItem {
	const call =
		options?.turnEnded === true && segment.status === "running"
			? endedAsStopped(segment)
			: segment;
	const item = buildSettledToolActivityItem(call, key, translate);
	// A picture's and a clip's rows word their own outcome from their codes, and a
	// card (an item made, being made, or refused) is its own account.
	if (call.name === "make_image" || call.name === "make_video") return item;
	if (
		item.body?.kind === "artifact" ||
		item.body?.kind === "artifact-creating" ||
		item.body?.kind === "artifact-failed"
	) {
		return item;
	}
	const reason = describeReason(call, translate);
	return reason ? withReason(item, reason, translate) : item;
}

type RowBase = Pick<
	ToolActivityItem,
	"key" | "status" | "iconType" | "pinned" | "alwaysOpen"
>;

/** A make_image call's row: its verb, title and failure words. */
function makeImageRow(
	segment: ToolCallSegment,
	base: RowBase,
	translate: Translate,
): ToolActivityItem {
	const status = segment.status;
	const metadata = segment.metadata;
	const inputTitle =
		typeof segment.input?.title === "string" ? segment.input.title : "";
	const title =
		typeof metadata?.imageTitle === "string" && metadata.imageTitle
			? metadata.imageTitle
			: inputTitle;
	const picturesAreStillComing =
		status === "running" || metadata?.imageStatus === "running";
	if (picturesAreStillComing) {
		const makingVerb = translate(VERB_KEYS.makingPicture);
		return {
			...base,
			verb: makingVerb,
			object: title,
			meta: "",
			summaryLabel: makingVerb,
			title: title || makingVerb,
			body: null,
		};
	}
	// A Stop is not a failure: the person asked for it.
	if (metadata?.imageStopped === true) {
		const stoppedVerb = translate(VERB_KEYS.pictureStopped);
		return {
			...base,
			status: "done",
			verb: stoppedVerb,
			object: title,
			meta: "",
			summaryLabel: stoppedVerb,
			title: title ? `${stoppedVerb}: ${title}` : stoppedVerb,
			body: null,
		};
	}
	// The tool's envelope gave up waiting, but the take is still rendering and
	// lands on its card: that is not a failure.
	if (metadata?.imageError === "image_tool_timeout") {
		const stillVerb = translate(VERB_KEYS.pictureStillMaking);
		return {
			...base,
			status: "done",
			verb: stillVerb,
			object: title,
			meta: "",
			summaryLabel: stillVerb,
			title: title ? `${stillVerb}: ${title}` : stillVerb,
			body: null,
		};
	}
	// A refusal meant only for the model (too many takes, a repeated retry, an
	// unknown picture name): the model corrects itself, so the person sees a
	// neutral row, not a failure. An explicit request and H3's transparent
	// refusal are the person's to act on, so they fall through to the failed
	// branch and get their own reason below.
	if (
		typeof metadata?.imageRefusal === "string" &&
		metadata.imageRefusal !== "not_configured" &&
		metadata.imageRefusal !== "explicit_request" &&
		metadata.imageRefusal !== "transparent_unavailable" &&
		metadata.imageUnreadable !== true
	) {
		const adjustedVerb = translate(VERB_KEYS.pictureRequestAdjusted);
		return {
			...base,
			status: "done",
			verb: adjustedVerb,
			object: title,
			meta: "",
			summaryLabel: adjustedVerb,
			title: title ? `${adjustedVerb}: ${title}` : adjustedVerb,
			body: null,
		};
	}
	if (status === "failed" || metadata?.ok === false) {
		const failedVerb = translate(
			metadata?.imageRefusal === "explicit_request" ||
				metadata?.imageRefusal === "transparent_unavailable"
				? VERB_KEYS.pictureNotMade
				: typeof metadata?.imageError === "string" &&
						IMAGE_FILTER_ERRORS.has(metadata.imageError)
					? VERB_KEYS.pictureBlocked
					: VERB_KEYS.pictureFailed,
		);
		// Words for the person come from the code, never from what the model was told.
		const reasonKey = imageReasonKey(metadata);
		const reason = reasonKey ? translate(reasonKey) : "";
		return {
			...base,
			status: "failed",
			verb: failedVerb,
			object: title,
			meta: "",
			summaryLabel: failedVerb,
			title: title ? `${failedVerb}: ${title}` : failedVerb,
			body: reason ? { kind: "reason", text: reason } : null,
		};
	}
	const doneVerb = translate(
		VERB_KEYS[metadata?.imageEdit === true ? "changedPicture" : "madePicture"],
	);
	return {
		...base,
		verb: doneVerb,
		object: title,
		meta:
			metadata?.imageRetried === true
				? translate("toolActivity.retriedOnce")
				: "",
		summaryLabel: `${doneVerb} ${title}`.trim(),
		title,
		body: null,
	};
}

/**
 * A make_image row carries the picture's card under it (plan 2b T2): when the
 * call names its card, or while it still runs (the card is then found by the
 * take made for this call). A refusal names no card and keeps its own body
 * (preflight F28). The card is a deliverable, so the row stays open.
 */
function withImageCard(
	item: ToolActivityItem,
	segment: ToolCallSegment,
): ToolActivityItem {
	const metadata = segment.metadata;
	const cardId =
		typeof metadata?.imageCardId === "string" && metadata.imageCardId
			? metadata.imageCardId
			: null;
	if (!cardId && segment.status !== "running") return item;
	const takeId =
		typeof metadata?.imageTakeId === "string" && metadata.imageTakeId
			? metadata.imageTakeId
			: null;
	const title =
		typeof segment.input?.title === "string" ? segment.input.title : "";
	return {
		...item,
		pinned: true,
		alwaysOpen: true,
		body: { kind: "image-card", cardId, takeId, title: item.object || title },
	};
}

type VideoErrorMetadata = Record<string, unknown> | undefined;

/** The person's words for a video take's failure code; null when there is no code. */
function videoReasonKey(metadata: VideoErrorMetadata): I18nKey | null {
	const code =
		typeof metadata?.videoError === "string" ? metadata.videoError : null;
	if (!code) return null;
	if (code === "video_blocked") return "artifacts.video.card.blockedDetail";
	if (code === "video_unchecked") return "artifacts.video.card.uncheckedDetail";
	if (
		code === "video_server_unreachable" ||
		code === "video_server_not_configured" ||
		// The tool's own refusal code for the same fact (no LTX address set).
		code === "not_configured"
	) {
		return "artifacts.video.card.unavailable";
	}
	return "artifacts.take.failed";
}

/** A make_video call's row: its verb, title and failure words, in the video's own language. */
function makeVideoRow(
	segment: ToolCallSegment,
	base: RowBase,
	translate: Translate,
): ToolActivityItem {
	const status = segment.status;
	const metadata = segment.metadata;
	const inputTitle =
		typeof segment.input?.title === "string" ? segment.input.title : "";
	const title =
		typeof metadata?.videoTitle === "string" && metadata.videoTitle
			? metadata.videoTitle
			: inputTitle;
	const clipIsStillComing =
		status === "running" || metadata?.videoStatus === "running";
	if (clipIsStillComing) {
		const makingVerb = translate("artifacts.video.row.making");
		return {
			...base,
			verb: makingVerb,
			object: title,
			meta: "",
			summaryLabel: makingVerb,
			title: title || makingVerb,
			body: null,
		};
	}
	// A Stop is not a failure: the person asked for it.
	if (metadata?.videoStopped === true) {
		const stoppedVerb = translate("artifacts.video.row.stopped");
		return {
			...base,
			status: "done",
			verb: stoppedVerb,
			object: title,
			meta: "",
			summaryLabel: stoppedVerb,
			title: title ? `${stoppedVerb}: ${title}` : stoppedVerb,
			body: null,
		};
	}
	// The tool's envelope gave up waiting, but the take is still rendering and
	// lands on its card: that is not a failure.
	if (metadata?.videoError === "video_tool_timeout") {
		const stillVerb = translate("artifacts.video.row.stillMaking");
		return {
			...base,
			status: "done",
			verb: stillVerb,
			object: title,
			meta: "",
			summaryLabel: stillVerb,
			title: title ? `${stillVerb}: ${title}` : stillVerb,
			body: null,
		};
	}
	if (status === "failed" || metadata?.ok === false) {
		const blocked =
			typeof metadata?.videoError === "string" &&
			(metadata.videoError === "video_blocked" ||
				metadata.videoError === "video_unchecked");
		const failedVerb = translate(
			blocked ? "artifacts.video.row.blocked" : "artifacts.video.row.failed",
		);
		const reasonKey = videoReasonKey(metadata);
		const reason = reasonKey ? translate(reasonKey) : "";
		return {
			...base,
			status: "failed",
			verb: failedVerb,
			object: title,
			meta: "",
			summaryLabel: failedVerb,
			title: title ? `${failedVerb}: ${title}` : failedVerb,
			body: reason ? { kind: "reason", text: reason } : null,
		};
	}
	const doneVerb = translate("artifacts.video.row.made");
	return {
		...base,
		verb: doneVerb,
		object: title,
		meta: "",
		summaryLabel: `${doneVerb} ${title}`.trim(),
		title,
		body: null,
	};
}

/**
 * A make_video row carries the clip's card under it, as a make_image row does:
 * when the call names its card, or while it still runs (the card is then found
 * by the take made for this call). A refusal names no card and keeps its own
 * body.
 */
function withVideoCard(
	item: ToolActivityItem,
	segment: ToolCallSegment,
): ToolActivityItem {
	const metadata = segment.metadata;
	const cardId =
		typeof metadata?.videoCardId === "string" && metadata.videoCardId
			? metadata.videoCardId
			: null;
	if (!cardId && segment.status !== "running") return item;
	const takeId =
		typeof metadata?.videoTakeId === "string" && metadata.videoTakeId
			? metadata.videoTakeId
			: null;
	const title =
		typeof segment.input?.title === "string" ? segment.input.title : "";
	return {
		...item,
		pinned: true,
		alwaysOpen: true,
		body: { kind: "video-card", cardId, takeId, title: item.object || title },
	};
}

function buildSettledToolActivityItem(
	segment: ToolCallSegment,
	key: string,
	translate: Translate,
): ToolActivityItem {
	const status = segment.status;
	const iconType = getToolCallIconType(segment.name);
	const base = {
		key,
		status,
		iconType,
		pinned: false,
		alwaysOpen: false,
	};

	if (iconType === "web-search") {
		const sources = getToolWebSources(segment);
		const query = String(
			segment.input.query ?? segment.input.q ?? firstStringInput(segment.input),
		).slice(0, 200);
		const searchVerb = verb(translate, "searching", "searched", status);
		const sourcesMeta =
			sources.length > 0
				? translate("toolCalls.sourcesCount", { count: sources.length })
				: "";
		return {
			...base,
			verb: searchVerb,
			object: query,
			meta: sourcesMeta,
			summaryLabel: sourcesMeta ? `${searchVerb} ${sourcesMeta}` : searchVerb,
			summaryUnit: "sources",
			summaryCount: sources.length,
			title: query,
			body:
				sources.length > 0
					? { kind: "sources", sources, citedCount: citedCount(sources) }
					: null,
		};
	}

	if (iconType === "image-search") {
		const query = firstStringInput(segment.input).slice(0, 200);
		const imageVerb = verb(
			translate,
			"searchingImages",
			"searchedImages",
			status,
		);
		return {
			...base,
			verb: imageVerb,
			object: query,
			meta: "",
			summaryLabel: imageVerb,
			title: query,
			body: null,
		};
	}

	if (iconType === "fetch-url") {
		const sources = getToolWebSources(segment);
		const primary = sources[0];
		// While the read is still in flight, a single URL body would only repeat
		// the row's own object, so that row stays chevron-less — the mockup's
		// "no chevron yet". Several URLs at once, a page that has actually come
		// back, or any settled read all carry something worth opening.
		const hasReturnedPages = (segment.candidates ?? []).some(
			(candidate) => candidate.sourceType === "web" && candidate.url,
		);
		const hasRevealableBody =
			sources.length > 0 &&
			(hasReturnedPages || sources.length > 1 || status !== "running");
		const host = primary
			? extractHostname(primary.url)
			: firstStringInput(segment.input);
		const object =
			primary?.title && primary.title !== host
				? `${host} · ${primary.title}`
				: host;
		return {
			...base,
			verb: verb(translate, "reading", "read", status),
			object,
			meta: "",
			summaryLabel: translate("toolCalls.readPagesCount", { count: 1 }),
			summaryUnit: "pages",
			summaryCount: 1,
			title: object,
			body: hasRevealableBody
				? {
						kind: "page",
						sources,
						excerpt: primary?.reason?.trim() || null,
					}
				: null,
		};
	}

	if (iconType === "run-python") {
		const object = runPythonObject(segment.input, translate);
		const program =
			typeof segment.input.code === "string" ? segment.input.code : "";
		const pythonVerb = verb(translate, "runningPython", "ranPython", status);
		return {
			...base,
			verb: pythonVerb,
			object,
			meta: "",
			summaryLabel: pythonVerb,
			title: object,
			body: program
				? {
						kind: "python",
						program,
						output: segment.outputSummary?.trim() || null,
					}
				: null,
		};
	}

	if (iconType === "map-route") {
		const map = segment.map ?? null;
		const object = map ? mapRouteLabel(map) : firstStringInput(segment.input);
		// The two public-transport actions get their own verbs and their own
		// right-hand fact — "Route A → B · 27 km" would be nonsense for a bus
		// journey, and outright wrong for a list of departures.
		const action = segment.input?.action;
		const isTimetable = action === "timetable";
		const isJourney = action === "journey";
		const isTransit = action === "transit" || isTimetable;
		const routeVerb = isJourney
			? verb(translate, "planningJourney", "journey", status)
			: isTimetable
				? verb(translate, "loadingTimetable", "timetable", status)
				: isTransit
					? verb(translate, "planningTransit", "transit", status)
					: verb(translate, "routing", "route", status);
		const meta = map
			? isJourney
				? journeyMeta(map, translate)
				: isTransit
					? transitMeta(map, translate)
					: mapMeta(map)
			: "";
		return {
			...base,
			verb: routeVerb,
			object,
			meta,
			summaryLabel: routeVerb,
			title: object,
			// A route is a deliverable: it stays visible, body open, when the
			// thinking block collapses.
			pinned: Boolean(map) && status === "done",
			body: map
				? {
						kind: "map",
						map,
						summary: [object, meta].filter(Boolean).join(" · "),
					}
				: null,
		};
	}

	if (iconType === "use-skill") {
		const displayName =
			typeof segment.metadata?.skillDisplayName === "string" &&
			segment.metadata.skillDisplayName.trim()
				? segment.metadata.skillDisplayName.trim()
				: firstStringInput(segment.input);
		const description = segment.outputSummary?.trim() || null;
		const skillVerb = verb(translate, "usingSkill", "usedSkill", status);
		return {
			...base,
			verb: skillVerb,
			object: displayName,
			meta: "",
			summaryLabel: `${skillVerb} ${displayName}`.trim(),
			title: displayName,
			body: description ? { kind: "text", text: description } : null,
		};
	}

	// make_image: the picture itself is drawn by its own card in the chat, after
	// the row; the row says what the call did, and for how many tries.
	if (segment.name === "make_image") {
		return withImageCard(makeImageRow(segment, base, translate), segment);
	}

	// make_video: the clip is drawn by its own card, the same way.
	if (segment.name === "make_video") {
		return withVideoCard(makeVideoRow(segment, base, translate), segment);
	}

	if (iconType === "artifact") {
		const isEdit = segment.name === "edit_artifact";
		const metadata = segment.metadata;
		const rawArtifactKind = metadata?.artifactKind;
		const artifactKind =
			typeof rawArtifactKind === "string" &&
			ARTIFACT_KINDS.includes(rawArtifactKind as ArtifactKind)
				? (rawArtifactKind as ArtifactKind)
				: undefined;
		const artifactId =
			typeof metadata?.artifactId === "string"
				? metadata.artifactId
				: undefined;
		const artifactTitle =
			typeof metadata?.artifactTitle === "string"
				? metadata.artifactTitle
				: undefined;
		const hasCard =
			metadata?.ok === true &&
			artifactId !== undefined &&
			artifactKind !== undefined &&
			artifactTitle !== undefined;

		// While still running, create_artifact's own call arguments already
		// name the title (the model supplied it); edit_artifact's do not (only
		// artifactId + patches/ops), so an in-flight edit has no better object
		// than the row's own generic identity below.
		const inputTitle =
			typeof segment.input?.title === "string"
				? segment.input.title
				: undefined;
		// Wave 2.5 Step 12/13: the RUNNING call's own kind, read from its call
		// arguments (`artifactType`) rather than `metadata.artifactKind` above
		// (metadata is the settled TOOL RESULT — never populated while running).
		// create_artifact's schema always includes it; edit_artifact's never
		// does, so this stays undefined for an in-flight edit exactly like
		// `inputTitle` above.
		const rawInputArtifactKind = segment.input?.artifactType;
		const inputArtifactKind =
			typeof rawInputArtifactKind === "string" &&
			ARTIFACT_KINDS.includes(rawInputArtifactKind as ArtifactKind)
				? (rawInputArtifactKind as ArtifactKind)
				: undefined;
		const inputArtifactId =
			typeof segment.input?.artifactId === "string"
				? segment.input.artifactId
				: undefined;
		const object = artifactTitle ?? inputTitle ?? "";
		const actionVerb = verb(
			translate,
			isEdit ? "editing" : "creating",
			isEdit ? "edited" : "created",
			status,
		);

		if (hasCard) {
			return {
				...base,
				artifact: { id: artifactId, failed: false },
				verb: actionVerb,
				object,
				// Redesign §5.1 problem 7 / §9.2: an artifact card reads like a log
				// entry when it carries a raw "230 ms"/"1 ms" fact next to it — the
				// card itself is the deliverable, so the row never shows a timing.
				meta: "",
				summaryLabel: `${actionVerb} ${object}`.trim(),
				title: object,
				// A made or changed artifact is a deliverable, exactly like a
				// produced file: it stays visible with its body open rather than
				// requiring a click to reveal what Alfy made.
				pinned: true,
				alwaysOpen: true,
				body: { kind: "artifact", artifactId, artifactKind, artifactTitle },
			};
		}
		if (status === "running") {
			// Wave 2.5 Step 12/13: create_artifact only (isEdit is false and its
			// own call arguments carry a kind) gets the skeleton standalone card;
			// edit_artifact keeps today's row (no card yet, body: null) — the
			// brief's own "edit_artifact keeps today's row" line. A running call
			// that names nothing (an edit carries only the item's id) is its verb
			// alone, never "Tool <id>".
			const creatingBody: ToolActivityBody | null =
				!isEdit && inputArtifactKind && object
					? {
							kind: "artifact-creating",
							artifactKind: inputArtifactKind,
							title: object,
						}
					: null;
			return {
				...base,
				verb: actionVerb,
				object,
				// Same reasoning as the settled card above: no timing while creating either.
				meta: "",
				summaryLabel: actionVerb,
				title: object,
				// Mirrors the settled card above: a skeleton card stays visible on
				// its own rather than requiring a click to reveal itself.
				pinned: Boolean(creatingBody),
				alwaysOpen: Boolean(creatingBody),
				body: creatingBody,
			};
		}
		// Wave 2.5 Step 12/13: a SETTLED, business-level refusal of create_artifact
		// (never edit_artifact — see the "artifact-failed" body's own doc comment
		// above) gets a standalone card saying so, with the model-facing reason.
		// The row's own verb/title stay the SAME settled form a success would
		// have had (this file's established philosophy for every OTHER failure:
		// only the glyph and the body communicate it — see
		// `buildToolActivityItem`'s own top comment) — `status` is overridden to
		// "failed" so the glyph actually turns red for what is, from the user's
		// side, a real failure (nothing was made), unlike a hard transport
		// failure the segment itself never reports here (status stays "done").
		if (
			!isEdit &&
			status === "done" &&
			metadata?.ok === false &&
			artifactKind &&
			object
		) {
			return {
				...base,
				status: "failed",
				verb: actionVerb,
				object,
				meta: "",
				summaryLabel: `${actionVerb} ${object}`.trim(),
				title: object,
				pinned: true,
				alwaysOpen: true,
				body: {
					kind: "artifact-failed",
					artifactKind,
					title: object,
					reason: segment.outputSummary ?? null,
				},
			};
		}
		// A call that failed (a thrown error) or was refused (`ok: false`) and made
		// no card (RC-A #2): the row says what was tried and on what, in the
		// reader's language, red like any failed row, folded, and never shows the
		// model's own words (English, written for the model) or the call's
		// parameters. It used to fall through to the generic identity below:
		// "Tool <id>", opened on `patches: [object Object]`.
		if (
			status === "failed" ||
			metadata?.ok === false ||
			readReasonCode(segment.name, metadata) !== null
		) {
			const failedVerb = translate(
				VERB_KEYS[isEdit ? "editFailed" : "createFailed"],
			);
			// The item by its title (the record carries it for a refusal since this
			// row learned to), else the call's own title, else its kind.
			const named =
				artifactTitle ??
				inputTitle ??
				(artifactKind
					? translate(`artifacts.type.${artifactKind}` as I18nKey)
					: "");
			return {
				...base,
				status: "failed",
				verb: named ? `${failedVerb}:` : failedVerb,
				object: named,
				meta: "",
				summaryLabel: failedVerb,
				title: named ? `${failedVerb}: ${named}` : failedVerb,
				pinned: false,
				alwaysOpen: false,
				body: null,
				artifact: { id: artifactId ?? inputArtifactId ?? null, failed: true },
			};
		}
		// A settled call whose success metadata came back malformed: never
		// fabricate a card for something that did not, in fact, happen. Falls
		// through to the generic identity/body below.
	}

	if (iconType === "memory") {
		const bullets = memoryBullets(segment.candidates ?? []);
		// A recall that returned nothing (or has not returned yet) must not
		// claim "0 memories" — it names what it was looking FOR instead, and
		// says nothing at all when it has neither.
		const object =
			bullets.length > 0
				? translate("toolActivity.memoriesCount", { count: bullets.length })
				: firstStringInput(segment.input);
		const memoryVerb = verb(translate, "recalling", "recalled", status);
		return {
			...base,
			verb: memoryVerb,
			object,
			meta: "",
			summaryLabel: `${memoryVerb} ${object}`.trim(),
			summaryUnit: "memories",
			summaryCount: bullets.length,
			title: object,
			body: bullets.length > 0 ? { kind: "bullets", items: bullets } : null,
		};
	}

	// A read names the item it read (F22): its title, never its id. The generic row
	// below would say "Tool <id>", and in a Hungarian turn "Eszköz e4d471c7-...".
	if (
		segment.name === "read_artifact" ||
		segment.name === "read_generated_file"
	) {
		const readVerb = verb(translate, "reading", "read", status);
		const object = readItemName(segment);
		return {
			...base,
			verb: readVerb,
			object,
			meta: "",
			summaryLabel: readVerb,
			title: object ? `${readVerb}: ${object}` : readVerb,
			body: null,
		};
	}

	const identity = describeToolIdentity(segment, translate);
	return {
		...base,
		verb: identity.verb,
		object: identity.object,
		meta: "",
		summaryLabel: identity.verb,
		title: identity.title,
		body: null,
	};
}

/**
 * What a read of an item names (F22): the item's own title (the record carries it
 * since this row learned to), a produced file by its request title, else its file
 * name. Never an id; an older record with none names nothing.
 */
function readItemName(segment: ToolCallSegment): string {
	const title = segment.metadata?.artifactTitle;
	if (typeof title === "string" && title.trim() !== "") return title.trim();
	for (const key of ["requestTitle", "filename"] as const) {
		const value = segment.input?.[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return "";
}

/**
 * The neutral "<tool label>: <first value>" identity used for generic tools
 * and for every failed row (a failure keeps the normal label — only the glyph
 * and the right-hand word go red).
 */
function describeToolIdentity(
	segment: ToolCallSegment,
	translate: Translate,
): { verb: string; object: string; title: string } {
	const label = translate(getHumanReadableToolNameKey(segment.name));
	const full = formatToolCall(segment.name, segment.input, translate);
	const object = full.startsWith(`${label}: `)
		? full.slice(label.length + 2)
		: full === label
			? ""
			: full;
	return { verb: label, object, title: full };
}

/**
 * How many photos the model was shown across a run of photos calls: the sum of
 * what each call says it queued (`metadata.viewedCount`, written by the photos
 * tool only when the model asked to look). Anything that is not a whole number
 * of photos counts as none, and so does any other tool.
 */
function photosViewedIn(tools: ToolCallSegment[]): number {
	return tools.reduce((total, tool) => {
		if (tool.name !== "photos") return total;
		const count = tool.metadata?.viewedCount;
		return typeof count === "number" && Number.isInteger(count) && count > 0
			? total + count
			: total;
	}, 0);
}

/** Builds the view-model for a collapsed run of connector calls. */
export function buildConnectorActivityItem(
	tools: ToolCallSegment[],
	key: string,
	translate: Translate,
): ToolActivityItem {
	const anyRunning = tools.some((tool) => tool.status === "running");
	const anyFailed =
		!anyRunning && tools.some((tool) => tool.status === "failed");
	const status: ToolActivityStatus = anyRunning
		? "running"
		: anyFailed
			? "failed"
			: "done";
	const labelKey =
		getConnectionToolLabelKey(tools[0].name) ?? "toolCalls.generic";
	const label = translate(labelKey);
	const object = translate("toolCalls.actionsCount", { count: tools.length });
	const viewed = photosViewedIn(tools);
	// The model was shown photos, and the row says so instead of counting
	// actions: "Looked at 6 photos". Those words are the whole row (no object
	// after them), so repeats fold into "Looked at 6 photos x2" like any other
	// row with nothing countable behind it. The opened panel still lists every
	// action.
	const looked =
		viewed > 0 ? translate(VERB_KEYS.photosViewed, { count: viewed }) : null;
	return {
		key,
		status,
		iconType: getToolCallIconType(tools[0].name),
		verb: looked ?? label,
		object: looked === null ? object : "",
		meta: anyFailed ? translate("toolCalls.failed") : "",
		summaryLabel: looked ?? `${label} ${object}`,
		...(looked === null
			? { summaryUnit: "actions" as const, summaryCount: tools.length }
			: {}),
		pinned: false,
		alwaysOpen: false,
		title: `${label} · ${looked ?? object}`,
		body: {
			kind: "actions",
			actions: tools.map((tool, index) => ({
				key: tool.callId ?? `${tool.name}-${index}`,
				label:
					(typeof tool.input.action === "string"
						? formatConnectionToolAction(tool.input.action)
						: "") || formatToolCall(tool.name, tool.input, translate),
				status: tool.status,
			})),
		},
	};
}

type ToolActivitySummaryGroup = {
	key: string;
	iconType: ToolCallIconType;
	verb: string;
	/** What the group's rows ended as, by the glyph they show: a stop is never a failure. */
	outcome: "failed" | "skipped" | "ok";
	/** The first row of the group — its label is what a lone occurrence shows. */
	first: ToolActivityItem;
	/** How many rows folded in. */
	occurrences: number;
	/** Sum of `summaryCount` across them (sources, pages, actions, memories). */
	total: number;
};

/** The label one group of same-kind rows contributes to the strip. */
function summaryGroupLabel(
	group: ToolActivitySummaryGroup,
	translate: Translate,
): string {
	// One call of a tool reads exactly as it did before aggregation.
	if (group.occurrences === 1) return group.first.summaryLabel;
	// A row that says in its own words what failed ("Couldn't edit") is not "… 2
	// failed": it repeats like any other.
	if (group.outcome === "failed" && !group.first.artifact?.failed) {
		return translate("toolActivity.summaryFailedCount", {
			verb: group.verb,
			count: group.occurrences,
		});
	}
	// A stop on purpose is not a failure and found nothing to add up either: it
	// repeats like any step with nothing countable behind it.
	if (group.outcome === "skipped") {
		return translate("toolActivity.summaryRepeat", {
			verb: group.verb,
			count: group.occurrences,
		});
	}
	switch (group.first.summaryUnit) {
		case "pages":
			// "Read 4 pages" — the pages ARE the calls, so no "×4" as well.
			return translate("toolCalls.readPagesCount", { count: group.total });
		case "sources": {
			// "Searched 3 times · 14 sources" — how often, then what it yielded.
			const times = translate("toolActivity.summaryTimes", {
				verb: group.verb,
				count: group.occurrences,
			});
			return group.total > 0
				? `${times} · ${translate("toolCalls.sourcesCount", { count: group.total })}`
				: times;
		}
		case "actions":
			// "Calendar 5 actions" — the same shape a single group already uses,
			// with the actions of every group summed.
			return `${group.verb} ${translate("toolCalls.actionsCount", { count: group.total })}`;
		case "memories":
			// A recall count is not a number the user can act on, and several
			// recalls are one thing that happened: "Recalled memories".
			return translate("toolActivity.summaryMemories", { verb: group.verb });
		default:
			// Nothing countable behind it (Python, a skill, an image search):
			// "Ran Python ×2".
			return translate("toolActivity.summaryRepeat", {
				verb: group.verb,
				count: group.occurrences,
			});
	}
}

/**
 * The collapsed-and-done summary strip: one entry per KIND of tool, in the
 * order each kind first appeared, joined by middle dots in the template. Only
 * non-pinned rows fold in — deliverables keep their own pinned row.
 *
 * Repeats aggregate rather than queueing up: a turn that searched three times
 * spends one slot ("Searched 3 times · 14 sources"), not three. The grouping
 * key is the icon type plus the verb — the two things that make two rows read
 * as "the same tool again" — and successes never merge with failures, so a
 * turn that read four pages and failed two says both ("Read 4 pages · Read 2
 * failed") instead of hiding either.
 */
export function buildToolActivitySummary(
	items: ToolActivityItem[],
	translate: Translate,
): { key: string; iconType: ToolCallIconType; label: string }[] {
	const groups = new Map<string, ToolActivitySummaryGroup>();
	const order: string[] = [];
	for (const item of items) {
		// Rows group by the glyph they show, so a stop on purpose never merges with a
		// success, and is never counted as a failure.
		const outcome: ToolActivitySummaryGroup["outcome"] =
			item.status === "failed"
				? "failed"
				: item.status === "skipped"
					? "skipped"
					: "ok";
		const groupKey = `${item.iconType}\u0000${item.verb}\u0000${outcome}`;
		const existing = groups.get(groupKey);
		if (existing) {
			existing.occurrences += 1;
			existing.total += item.summaryCount ?? 0;
			continue;
		}
		groups.set(groupKey, {
			key: item.key,
			iconType: item.iconType,
			// A row may end its verb in a colon to introduce a free-form title (the
			// Hungarian way to attach one without a case ending); the strip says
			// the verb alone.
			verb: item.verb.replace(/:$/, ""),
			outcome,
			first: item,
			occurrences: 1,
			total: item.summaryCount ?? 0,
		});
		order.push(groupKey);
	}
	return order.map((groupKey) => {
		const group = groups.get(groupKey) as ToolActivitySummaryGroup;
		return {
			key: group.key,
			iconType: group.iconType,
			label: summaryGroupLabel(group, translate),
		};
	});
}

/**
 * A file-production job as an activity row. This REPLACES the standalone
 * FileProductionCard shell: the row carries the grammar ("Creating …" /
 * "Created …" + size), and the (reduced) FileProductionCard renders only the
 * body.
 *
 * While the job is active the row is `alwaysOpen`, so row and body share one
 * background and read as a single element — the owner's explicit note.
 */
export function buildFileProductionActivityItem(
	job: FileProductionJob,
	translate: Translate,
): ToolActivityItem {
	const isActive = job.status === "queued" || job.status === "running";
	const isError = job.status === "failed" || job.status === "cancelled";
	const status: ToolActivityStatus = isActive
		? "running"
		: isError
			? "failed"
			: "done";
	const primaryFile = job.files[0];
	const object = primaryFile?.filename ?? job.title ?? "";
	const totalBytes = job.files.reduce(
		(sum, file) => sum + (file.sizeBytes ?? 0),
		0,
	);
	const createdVerb = verb(translate, "creating", "created", status);
	return {
		key: `file-job-${job.id}`,
		status,
		iconType: "file-production",
		verb: createdVerb,
		object,
		meta: isError
			? translate("toolCalls.failed")
			: totalBytes > 0
				? formatByteSize(totalBytes, { trimWholeUnits: true })
				: "",
		summaryLabel: `${createdVerb} ${object}`.trim(),
		// A produced file is a deliverable: it never folds into the summary
		// strip, it stays a pinned row with its body open.
		pinned: true,
		// A deleted file's body (what happened, and Regenerate) is the whole point
		// of its row: open on its own, never behind a chevron.
		alwaysOpen: isActive || Boolean(job.filesDeleted),
		title: object,
		body: { kind: "file-job" },
	};
}

// ---------------------------------------------------------------------------
// Atlas report rows
// ---------------------------------------------------------------------------
//
// An Atlas job renders as ONE activity row in the same grammar as every other
// tool — while it runs it is a pinned row, always open, exactly like a file
// being produced:
//
//   [spinner] [file] Atlas report  <title> ……… 4 of 6 questions · 6 min
//
// The v2 pipeline puts its live plan on `progress.details`; v1 jobs carry only
// `queries`/`focus`. Everything below reads BOTH, and every v2 field is
// optional, so a v1 job keeps rendering (stage label + queries) with no
// server change.

export type AtlasActivityPhase =
	| "plan"
	| "research"
	| "index"
	| "write"
	| "verify"
	| "render"
	// v3 phases (ADR 0063). "research" is shared with v2 above; the rest are
	// v3-only, so a v2 card never sees them and a v3 card never sees "index".
	| "ask"
	| "outline"
	| "answer"
	| "critic";

export type AtlasPlanEntryStatus = "queued" | "running" | "done";

export type AtlasPlanConfidence = "corroborated" | "single" | "mixed" | "thin";

export type AtlasPlanEntry = {
	id: string;
	question: string;
	status: AtlasPlanEntryStatus;
	sourceCount: number;
	confidence: AtlasPlanConfidence | null;
};

export type AtlasEvidenceSource = {
	n: number;
	title: string;
	/** Empty for a `local` source. */
	host: string;
	date: string | null;
	cited: boolean;
	/** `local` is one of the user's own documents: no host, no favicon. */
	kind: "web" | "local";
};

export type AtlasEvidenceSummary = {
	corroborated: number;
	single: number;
	inferred: number;
	cut: number;
	filteredCount: number;
	sources: AtlasEvidenceSource[];
};

/** The client's view of `AtlasJobCard.progress.details`, v1 and v2 together. */
export type AtlasActivityDetails = {
	pipelineVersion: number | null;
	phase: AtlasActivityPhase | null;
	plan: AtlasPlanEntry[];
	round: { current: number; total: number } | null;
	sourcesRead: number | null;
	next: string | null;
	evidence: AtlasEvidenceSummary | null;
	/**
	 * Sections written, for the Report tab's document row: the stored
	 * `sections.written` (v2/v3, present once writing is done), else a flat
	 * `sectionCount`. Omitted from the row's meta when neither is there.
	 */
	sectionCount: number | null;
	/** v1 fields, still rendered by the fallback body. */
	queries: string[];
	focus: string[];
	roundKind: "initial" | "gap-fill" | null;
	generatedTitle: string | null;
};

const ATLAS_PHASES: readonly AtlasActivityPhase[] = [
	"plan",
	"research",
	"index",
	"write",
	"verify",
	"render",
	"ask",
	"outline",
	"answer",
	"critic",
];

const ATLAS_PLAN_STATUSES: readonly AtlasPlanEntryStatus[] = [
	"queued",
	"running",
	"done",
];

const ATLAS_CONFIDENCES: readonly AtlasPlanConfidence[] = [
	"corroborated",
	"single",
	"mixed",
	"thin",
];

const ATLAS_MAX_PLAN_ENTRIES = 24;
const ATLAS_MAX_EVIDENCE_SOURCES = 40;
const ATLAS_MAX_TEXT = 240;

function atlasText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, ATLAS_MAX_TEXT) : null;
}

function atlasCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(0, Math.round(value));
}

function atlasStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(atlasText)
		.filter((entry): entry is string => Boolean(entry))
		.slice(0, ATLAS_MAX_PLAN_ENTRIES);
}

function parseAtlasPlanEntry(
	value: unknown,
	index: number,
): AtlasPlanEntry | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const question = atlasText(record.question);
	if (!question) return null;
	const status = ATLAS_PLAN_STATUSES.includes(
		record.status as AtlasPlanEntryStatus,
	)
		? (record.status as AtlasPlanEntryStatus)
		: "queued";
	const confidence = ATLAS_CONFIDENCES.includes(
		record.confidence as AtlasPlanConfidence,
	)
		? (record.confidence as AtlasPlanConfidence)
		: null;
	return {
		id: atlasText(record.id) ?? `q${index + 1}`,
		question,
		status,
		sourceCount: atlasCount(record.sourceCount) ?? 0,
		confidence,
	};
}

function parseAtlasEvidence(value: unknown): AtlasEvidenceSummary | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const sources = Array.isArray(record.sources)
		? record.sources
				.map((entry, index): AtlasEvidenceSource | null => {
					if (!entry || typeof entry !== "object") return null;
					const source = entry as Record<string, unknown>;
					const title = atlasText(source.title);
					if (!title) return null;
					const local = source.kind === "local";
					return {
						n: atlasCount(source.n) ?? index + 1,
						title,
						host: local ? "" : (atlasText(source.host) ?? ""),
						date: atlasText(source.date),
						cited: source.cited === true,
						kind: local ? "local" : "web",
					};
				})
				.filter((entry): entry is AtlasEvidenceSource => entry !== null)
				.slice(0, ATLAS_MAX_EVIDENCE_SOURCES)
		: [];
	const corroborated = atlasCount(record.corroborated) ?? 0;
	const single = atlasCount(record.single) ?? 0;
	const inferred = atlasCount(record.inferred) ?? 0;
	const cut = atlasCount(record.cut) ?? 0;
	const filteredCount = atlasCount(record.filteredCount) ?? 0;
	// An evidence object with nothing in it at all is treated as absent, so the
	// Evidence tab never opens on an empty panel.
	if (
		sources.length === 0 &&
		corroborated + single + inferred + cut + filteredCount === 0
	) {
		return null;
	}
	return { corroborated, single, inferred, cut, filteredCount, sources };
}

/**
 * Sections the report was written with. v2 and v3 store
 * `sections: {written, planned}` once writing is done; a flat `sectionCount`
 * is still read for any blob that carries one.
 */
function atlasSectionCount(record: Record<string, unknown>): number | null {
	const sections =
		record.sections && typeof record.sections === "object"
			? (record.sections as Record<string, unknown>)
			: null;
	return atlasCount(sections?.written) ?? atlasCount(record.sectionCount);
}

/** Defensive read of a job's progress details — every field optional. */
export function parseAtlasActivityDetails(
	value: unknown,
): AtlasActivityDetails {
	const empty: AtlasActivityDetails = {
		pipelineVersion: null,
		phase: null,
		plan: [],
		round: null,
		sourcesRead: null,
		next: null,
		evidence: null,
		sectionCount: null,
		queries: [],
		focus: [],
		roundKind: null,
		generatedTitle: null,
	};
	if (!value || typeof value !== "object") return empty;
	const record = value as Record<string, unknown>;
	const plan = Array.isArray(record.plan)
		? record.plan
				.map(parseAtlasPlanEntry)
				.filter((entry): entry is AtlasPlanEntry => entry !== null)
				.slice(0, ATLAS_MAX_PLAN_ENTRIES)
		: [];
	const roundRecord =
		record.round && typeof record.round === "object"
			? (record.round as Record<string, unknown>)
			: null;
	const roundCurrent = atlasCount(roundRecord?.current);
	const roundTotal = atlasCount(roundRecord?.total);
	return {
		pipelineVersion: atlasCount(record.pipelineVersion),
		phase: ATLAS_PHASES.includes(record.phase as AtlasActivityPhase)
			? (record.phase as AtlasActivityPhase)
			: null,
		plan,
		round:
			roundCurrent !== null && roundTotal !== null
				? { current: roundCurrent, total: roundTotal }
				: null,
		sourcesRead: atlasCount(record.sourcesRead),
		next: atlasText(record.next),
		evidence: parseAtlasEvidence(record.evidence),
		sectionCount: atlasSectionCount(record),
		queries: atlasStringList(record.queries),
		focus: atlasStringList(record.focus ?? record.gapFillFocus),
		roundKind:
			record.roundKind === "gap-fill" || record.roundKind === "initial"
				? record.roundKind
				: null,
		generatedTitle: atlasText(record.generatedTitle),
	};
}

/** How many plan questions are finished, and how many there are. */
export function atlasPlanProgress(plan: AtlasPlanEntry[]): {
	done: number;
	total: number;
} {
	return {
		done: plan.filter((entry) => entry.status === "done").length,
		total: plan.length,
	};
}

/** "45s" / "6 min", from the job's own timestamps. Never negative. */
function atlasElapsedLabel(
	startMs: number,
	endMs: number,
	translate: Translate,
): string | null {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
	const seconds = Math.round((endMs - startMs) / 1000);
	if (seconds < 1) return null;
	if (seconds < 60) return translate("atlas.durationSeconds", { seconds });
	return translate("atlas.durationMinutes", {
		minutes: Math.max(1, Math.round(seconds / 60)),
	});
}

/**
 * The Atlas job as the client sees it. Structurally the public `AtlasJobCard`
 * plus the two fields the v2 read model adds: `startedAt` (when the worker
 * claimed the job — the honest clock for "6 min") and the richer
 * `progress.details`. Both optional, so a v1 payload satisfies this type.
 */
export type AtlasActivityJob = {
	id: string;
	conversationId: string;
	title: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	stage?: string | null;
	profile: string;
	progress?: {
		percent: number;
		stage: string;
		details?: unknown;
	} | null;
	sourceCounts: { accepted: number; web: number; local: number };
	outputs: {
		htmlChatGeneratedFileId?: string | null;
		pdfChatGeneratedFileId?: string | null;
		markdownChatGeneratedFileId?: string | null;
	};
	error?: { code: string; message: string; retryable: boolean } | null;
	startedAt?: number | null;
	createdAt: number;
	completedAt?: number | null;
};

/** The report's own title: the generated one when there is one. */
export function atlasReportTitle(
	job: AtlasActivityJob,
	details: AtlasActivityDetails,
	translate: Translate,
): string {
	return (
		details.generatedTitle ??
		(job.title.trim() || translate("atlas.defaultTitle"))
	);
}

/**
 * One Atlas job as an activity row. Running jobs are `alwaysOpen` (pinned, no
 * chevron — the plan stays visible while it executes); a settled job folds to a
 * tick with a chevron over the Report / Evidence / Plan tabs.
 *
 * A cancelled job is deliberately NOT a failure: it renders as a done row whose
 * object says how far it got and whose meta reads "Stopped".
 */
export function buildAtlasActivityItem(
	job: AtlasActivityJob,
	details: AtlasActivityDetails,
	translate: Translate,
	nowMs: number,
): ToolActivityItem {
	const isActive = job.status === "queued" || job.status === "running";
	const status: ToolActivityStatus =
		job.status === "failed" ? "failed" : isActive ? "running" : "done";
	const reportTitle = atlasReportTitle(job, details, translate);
	const { done, total } = atlasPlanProgress(details.plan);
	const startedAt = job.startedAt ?? job.createdAt;
	const elapsed = atlasElapsedLabel(
		startedAt,
		isActive ? nowMs : (job.completedAt ?? nowMs),
		translate,
	);
	const atlasVerb = translate("atlasActivity.verb");

	const object =
		job.status === "cancelled"
			? total > 0
				? translate("atlasActivity.cancelledAfter", { done, total })
				: translate("atlasActivity.cancelled")
			: reportTitle;

	let meta = "";
	if (job.status === "failed") {
		meta = translate("atlas.stage.failed");
	} else if (job.status === "cancelled") {
		meta = translate("atlasActivity.stopped");
	} else if (isActive) {
		const questions =
			total > 0
				? translate("atlasActivity.questionsProgress", { done, total })
				: null;
		meta = [questions, elapsed].filter(Boolean).join(" · ");
	} else {
		const sources =
			job.sourceCounts.accepted > 0
				? translate("atlas.sourceCount", { count: job.sourceCounts.accepted })
				: null;
		meta = [sources, elapsed].filter(Boolean).join(" · ");
	}

	return {
		key: `atlas-job-${job.id}`,
		status,
		iconType: "file-production",
		verb: atlasVerb,
		object,
		meta,
		summaryLabel: `${atlasVerb} ${object}`.trim(),
		// A report is a deliverable: it never folds into the collapsed summary
		// strip, and while it runs the row and its body are one open element.
		pinned: true,
		alwaysOpen: isActive,
		title: object,
		body: { kind: "atlas" },
	};
}
