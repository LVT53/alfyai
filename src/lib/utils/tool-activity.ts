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
import {
	imageThumbnailRouteUrl,
	isBraveThumbnailUrl,
} from "$lib/shared/url-provenance";
import {
	connectorCountOf,
	connectorPhraseKey,
	connectorThingsIcon,
	connectorUnitKey,
	localizedThingTitle,
} from "$lib/utils/connector-row-words";
import { formatByteSize } from "$lib/utils/format";
import {
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
	formatEventTime,
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
	UNFINISHED_CODE,
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

/** The little glyph before each thing a `things` body names: a tool's own, or a chat's. */
export type ToolThingIcon = ToolCallIconType | "chat";

/** The opened panel under a row. One variant per tool shape in the mockup. */
export type ToolActivityBody =
	| { kind: "sources"; sources: ToolWebSource[]; citedCount: number }
	| { kind: "page"; sources: ToolWebSource[]; excerpt: string | null }
	// What a calculation printed, as plain text: never its program, and never the
	// note the tool wrote for the model about it.
	| { kind: "result"; text: string }
	| { kind: "map"; map: ToolCallMapData; summary: string }
	| { kind: "bullets"; items: string[] }
	// The pictures a picture search found, small, each with its site. `src` is the
	// app's own thumbnail route for an address on Brave's image proxy, never the
	// address itself.
	| {
			kind: "thumbs";
			items: { src: string; host: string; title: string }[];
	  }
	// The things a tool found or touched, by their own names: at most five, then
	// `more` says how many were left out.
	| {
			kind: "things";
			icon: ToolThingIcon;
			items: { title: string; sub?: string }[];
			more: number;
	  }
	// One run of an account's calls: each call in plain words with the glyph of how
	// it went, what it found beside it, the things it found by their own names, or
	// one sentence about why it did not work.
	| {
			kind: "actions";
			/** The glyph before each thing a call names (the account's own). */
			icon: ToolThingIcon;
			actions: {
				key: string;
				label: string;
				status: ToolActivityStatus;
				/** What the call found, on its right ("3 found"). */
				sub?: string;
				things?: { items: { title: string; sub?: string }[]; more: number };
				/** Why it did not work, or one line of information: a sentence, never a code. */
				reason?: string;
			}[];
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
	"toolRows.meta.pictures",
	"toolRows.meta.pastChats",
	"toolRows.more",
	"toolRows.verb.didntOpen",
	"toolRows.verb.lookedThrough",
	"toolRows.verb.noSkillCalled",
	"toolRows.verb.suggestedInstruction",
	"toolRows.verb.leftAsItWas",
	"toolRows.verb.adjustingRequest",
	"toolRows.verb.videoNotMade",
	"toolRows.verb.adjustingVideo",
	"toolRows.suffix.page",
	"toolRows.suffix.part",
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

/** The title of every candidate a memory lookup returned, as plain text: a memory's statement, or a past chat's title. */
function memoryTitles(candidates: ToolEvidenceCandidate[]): string[] {
	return candidates
		.map((candidate) => stripToPlainText(candidate.title ?? ""))
		.filter((title) => title.length > 0);
}

/**
 * What the reply a row belongs to ended as, when it is over: `turnEnded` (it is no
 * longer streaming) and `turnStopped` (the person pressed Stop: the message's own
 * `wasStopped`). A reply can end without a Stop, an update or a crash cut it, and
 * then no step of it was stopped by the person.
 */
type TurnEnd = { turnEnded?: boolean; turnStopped?: boolean };

/**
 * A call still marked running in a reply that is over was cut off before the call's
 * closing event came. It reads as a quiet stop, never as a spinner that cannot end.
 * The row is built as the settled call it would have been. When the person pressed
 * Stop it carries the server's `stopped` code (and the flags a picture's and a
 * clip's own rows read their Stop from): "You stopped this before it finished."
 * When the reply ended some other way it carries the browser's own `unfinished`:
 * "This step didn't finish before the reply ended.", because nobody pressed Stop.
 */
function cutOffCall(
	segment: ToolCallSegment,
	stoppedByPerson: boolean,
): ToolCallSegment {
	const metadata: Record<string, string | number | boolean | null> = {
		...segment.metadata,
		reasonCode: stoppedByPerson ? "stopped" : UNFINISHED_CODE,
	};
	if (stoppedByPerson) {
		if (segment.name === "make_image") metadata.imageStopped = true;
		if (segment.name === "make_video") metadata.videoStopped = true;
	}
	return { ...segment, status: "done", metadata };
}

/** What a call's outcome says: its kind, and its one sentence (none when the row's own words say it all). */
type RowReason = { code: string | null; kind: ReasonKind; text: string | null };

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
		code: words.code,
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
 * marked running was cut off and reads as a quiet stop. `options.turnStopped`: the
 * person pressed Stop on it, so the stop is theirs; without it the call "did not
 * finish before the reply ended" (an update or a crash cut the reply).
 */
export function buildToolActivityItem(
	segment: ToolCallSegment,
	key: string,
	translate: Translate,
	options?: TurnEnd,
): ToolActivityItem {
	const call =
		options?.turnEnded === true && segment.status === "running"
			? cutOffCall(segment, options.turnStopped === true)
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

/**
 * How a picture's or a clip's call ended, from the registry: its code, and the
 * code's kind and sentence. A call that simply worked has none. The code comes from
 * the fields the tool already writes (`imageRefusal`, `imageError`, a Stop's flag,
 * `videoError`) and the envelope's shared one; a call that failed with no code at
 * all, or one this version does not know, reads as the tool's own fallback sentence.
 */
function takeOutcome(
	toolName: "make_image" | "make_video",
	segment: ToolCallSegment,
): { code: string | null; kind: ReasonKind; key: I18nKey | null } | null {
	const code = readReasonCode(toolName, segment.metadata);
	const failed = segment.status === "failed" || segment.metadata?.ok === false;
	if (code === null && !failed) return null;
	const words = resolveToolReason(toolName, code);
	return { code, kind: words.kind, key: words.key };
}

/** The glyph an outcome's kind draws: broke is the red cross, a stop on purpose the quiet dash, information a tick. */
function takeStatus(kind: ReasonKind): ToolActivityStatus {
	return kind === "fail" ? "failed" : kind === "stop" ? "skipped" : "done";
}

/**
 * A make_image call's row: its verb, title and failure words. The glyph follows the
 * code's kind like every row's: a Stop, a refusal the model corrects by itself, the
 * explicit-picture refusal, the transparency refusal and the filter's block are the
 * quiet dash; a breakage is the red cross, and so is "the picture could not be
 * checked" (the check failed, and later it may not); the envelope giving up while the
 * take still renders is a tick, as before. The words are the code's sentence, never
 * what the model was told.
 */
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
	const outcome = takeOutcome("make_image", segment);
	if (outcome) {
		// The verb says what happened to the picture; a sentence follows when there is
		// more to say (a Stop, a still-rendering take and a model's correction say it
		// all in their verb).
		const verbKey =
			outcome.code === "stopped"
				? VERB_KEYS.pictureStopped
				: outcome.code === "image_tool_timeout"
					? VERB_KEYS.pictureStillMaking
					: outcome.kind === "stop" && outcome.key === null
						? VERB_KEYS.pictureRequestAdjusted
						: outcome.code === "image_blocked" ||
								outcome.code === "image_unchecked"
							? VERB_KEYS.pictureBlocked
							: outcome.kind === "stop"
								? VERB_KEYS.pictureNotMade
								: VERB_KEYS.pictureFailed;
		const outcomeVerb = translate(verbKey);
		return {
			...base,
			status: takeStatus(outcome.kind),
			verb: outcomeVerb,
			object: title,
			meta: "",
			summaryLabel: outcomeVerb,
			title: title ? `${outcomeVerb}: ${title}` : outcomeVerb,
			body: outcome.key
				? { kind: "reason", text: translate(outcome.key) }
				: null,
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

/**
 * A make_video call's row, in the picture row's grammar and the video's own
 * language. The stops on purpose (the explicit-request refusal, a request that did
 * not clearly ask for a video, the filter's block, a Stop) are the quiet dash, with
 * "Video not made" and a sentence, "The video was blocked", or "Stopped the video";
 * a request the model corrects by itself is "Adjusting the video request" with no
 * body; every breakage code is the red cross with its own sentence, in the row's
 * body when there is no card and on the clip's card when there is; "the clip could
 * not be checked" stays a failure (the check failed, and later it may not).
 */
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
	const outcome = takeOutcome("make_video", segment);
	if (outcome) {
		// The tool's envelope giving up while the take still renders, a Stop and a
		// correction for the model say it all in their verb; a stop on purpose and a
		// breakage add their sentence.
		const verbKey: I18nKey =
			outcome.code === "stopped"
				? "artifacts.video.row.stopped"
				: outcome.code === "video_tool_timeout"
					? "artifacts.video.row.stillMaking"
					: outcome.kind === "stop" && outcome.key === null
						? "toolRows.verb.adjustingVideo"
						: outcome.code === "video_blocked" ||
								outcome.code === "video_unchecked"
							? "artifacts.video.row.blocked"
							: outcome.kind === "stop"
								? "toolRows.verb.videoNotMade"
								: "artifacts.video.row.failed";
		const outcomeVerb = translate(verbKey);
		return {
			...base,
			status: takeStatus(outcome.kind),
			verb: outcomeVerb,
			object: title,
			meta: "",
			summaryLabel: outcomeVerb,
			title: title ? `${outcomeVerb}: ${title}` : outcomeVerb,
			body: outcome.key
				? { kind: "reason", text: translate(outcome.key) }
				: null,
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

/** How many named things a list in a body shows before it says "and N more". */
const THINGS_SHOWN = 5;

/**
 * The pictures a picture search found: how many, and the small copies a row can
 * show. A thumbnail is shown only when it is an address on Brave's image proxy (the
 * one the app's own thumbnail route will ask for), through that route and never by
 * its own address; a picture whose thumbnail is anything else is counted, not shown
 * (ADR-0068: an address the app requests without a click comes from a tool's result,
 * never from the model's words). Each carries the site the search said it came from.
 */
function foundPictures(candidates: ToolEvidenceCandidate[] | undefined): {
	count: number;
	thumbs: { src: string; host: string; title: string }[];
} {
	const found = (candidates ?? []).filter(
		(candidate) => typeof candidate.url === "string" && candidate.url.trim(),
	);
	const thumbs: { src: string; host: string; title: string }[] = [];
	for (const candidate of found) {
		const thumbnail = candidate.metadata?.thumbnail;
		if (typeof thumbnail !== "string" || !isBraveThumbnailUrl(thumbnail)) {
			continue;
		}
		const source =
			typeof candidate.metadata?.source === "string"
				? candidate.metadata.source
				: (candidate.snippet ?? "");
		const host =
			stripToPlainText(source).trim() || extractHostname(candidate.url ?? "");
		thumbs.push({
			src: imageThumbnailRouteUrl(thumbnail.trim()),
			host,
			title: stripToPlainText(candidate.title || host),
		});
	}
	return { count: found.length, thumbs: thumbs.slice(0, 8) };
}

/** A whole, positive number the model named ("page": 3, "part": "2"); anything else is none. */
function wholeNumber(value: unknown): number | null {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d{1,6}$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN;
	return Number.isInteger(number) && number > 0 ? number : null;
}

/** A place a route call named: a name, or the coordinates it gave instead. */
function placeText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value && typeof value === "object") {
		const { lat, lng } = value as Record<string, unknown>;
		if (typeof lat === "number" && typeof lng === "number") {
			return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
		}
	}
	return "";
}

/**
 * What a route call is about when it drew no map (a refusal, a failure, a call
 * still running): the two ends of the trip, or the one place looked up. Never the
 * first word of the request ("drive"), which the row used to print.
 */
function routeInputLabel(input: Record<string, unknown>): string {
	const origin = placeText(input.origin);
	const destination = placeText(input.destination);
	if (origin && destination) return `${origin} → ${destination}`;
	return (origin || destination || placeText(input.query)).slice(0, 200);
}

/** A verb that ends in a colon to introduce a free-form title, with the colon only when a title follows. */
function verbBeforeTitle(verbText: string, named: boolean): string {
	const bare = verbText.replace(/:\s*$/, "");
	return named ? `${bare}:` : bare;
}

function buildSettledToolActivityItem(
	segment: ToolCallSegment,
	key: string,
	translate: Translate,
): ToolActivityItem {
	const status = segment.status;
	const iconType = getToolCallIconType(segment.name);
	const code = readReasonCode(segment.name, segment.metadata);
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
		// How many pictures it found is the row's own fact ("8 pictures"); opened, it
		// shows the pictures themselves, small, each with its site.
		const pictures = foundPictures(segment.candidates);
		return {
			...base,
			verb: imageVerb,
			object: query,
			meta:
				pictures.count > 0
					? translate("toolRows.meta.pictures", { count: pictures.count })
					: "",
			summaryLabel: imageVerb,
			title: query,
			body:
				pictures.thumbs.length > 0
					? { kind: "thumbs", items: pictures.thumbs }
					: null,
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
		// A link the app turned down on purpose (it came from neither the person nor
		// a search) was not opened: the row says so, and names only the host.
		const refused = code === "link_not_from_a_source";
		const fetchVerb = refused
			? translate("toolRows.verb.didntOpen")
			: verb(translate, "reading", "read", status);
		return {
			...base,
			verb: fetchVerb,
			object: refused ? host : object,
			meta: "",
			summaryLabel: refused
				? fetchVerb
				: translate("toolCalls.readPagesCount", { count: 1 }),
			summaryUnit: "pages",
			summaryCount: 1,
			title: refused ? host : object,
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
		const pythonVerb = verb(translate, "runningPython", "ranPython", status);
		// What the program printed, from the short copy the server keeps for the row
		// (`displayOutput`, never sent to the model): plain text, no program, and no
		// body at all when it printed nothing or the call is older than the copy.
		const printed =
			typeof segment.metadata?.displayOutput === "string"
				? segment.metadata.displayOutput.replace(/^\s*\n/, "").trimEnd()
				: "";
		return {
			...base,
			verb: pythonVerb,
			object,
			meta: "",
			summaryLabel: pythonVerb,
			title: object,
			body: printed ? { kind: "result", text: printed } : null,
		};
	}

	if (iconType === "map-route") {
		const map = segment.map ?? null;
		const object = map ? mapRouteLabel(map) : routeInputLabel(segment.input);
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
		// A skill that was loaded does not open: its name says it, and the note the
		// tool wrote for the model ("Loaded skill …") is the model's. A name that no
		// skill has says so in its verb, and has nothing more to say.
		const skillVerb =
			code === "skill_not_found"
				? translate("toolRows.verb.noSkillCalled")
				: verb(translate, "usingSkill", "usedSkill", status);
		return {
			...base,
			verb: skillVerb,
			object: displayName,
			meta: "",
			summaryLabel: `${skillVerb} ${displayName}`.trim(),
			title: displayName,
			body: null,
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
		// A call that came back ok can still carry a code that says it left things as
		// they were: a Document edit whose every op was stale is a success to the
		// server (the version is written, no op was refused as a whole) and names
		// `changed_since_read` beside `ok: true`. That is no "Edited <title>" with a
		// tick and a card: a code of a stop or a failure takes the row down the
		// quiet-row path below, with "Left as it was" and its sentence.
		const codeKind =
			code === null
				? null
				: resolveToolReason(segment.name, code, {
						artifactKind: artifactKind ?? null,
					}).kind;
		const hasCard =
			metadata?.ok === true &&
			codeKind !== "stop" &&
			codeKind !== "fail" &&
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
		// A SETTLED, business-level refusal of create_artifact (never edit_artifact:
		// its refusals are rows, below) that has something to say gets a standalone
		// card saying so, in the reason's own sentence (the per-turn cap, a kind that
		// cannot be made, the create fallback), never in the words the tool wrote for
		// the model. The glyph follows the code's kind like any row: a stop on
		// purpose (the cap) is the quiet dash, a breakage the red cross. A refusal
		// the model corrects by itself (`request_adjusted`) has no sentence and
		// draws no card: it is the quiet "Adjusting the request" row below.
		const reason = resolveToolReason(segment.name, code, {
			artifactKind: artifactKind ?? null,
		});
		const reasonText = reason.key ? translate(reason.key) : null;
		if (
			!isEdit &&
			status === "done" &&
			metadata?.ok === false &&
			artifactKind &&
			object &&
			reasonText !== null
		) {
			return {
				...base,
				status: reason.kind === "stop" ? "skipped" : "failed",
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
					reason: reasonText,
				},
			};
		}
		// A call that failed (a thrown error), was refused (`ok: false`) or carries a
		// code, and made no card (RC-A #2): the row says what was tried and on what,
		// in the reader's language, and never shows the model's own words (English,
		// written for the model) or the call's parameters. Its glyph and its sentence
		// come from the code (`withReason`). Two codes say it in the verb: the edit
		// that left the person's own changes alone ("Left as it was"), and a request
		// the model had to correct ("Adjusting the request"), both quiet. It used to
		// fall through to the generic identity below: "Tool <id>", opened on
		// `patches: [object Object]`.
		if (status === "failed" || metadata?.ok === false || code !== null) {
			const failedVerb = verbBeforeTitle(
				translate(
					code === "changed_since_read"
						? "toolRows.verb.leftAsItWas"
						: code === "request_adjusted"
							? "toolRows.verb.adjustingRequest"
							: VERB_KEYS[isEdit ? "editFailed" : "createFailed"],
				),
				false,
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
		// Every title the call returned: a memory's statement, or a past chat's title.
		const titles = memoryTitles(segment.candidates ?? []);
		const memoryVerb = verb(translate, "recalling", "recalled", status);
		// A look into past chats (`history`) or the project's chats (`project`) is not
		// "Recalled N memories": the things it found are chats, and the row says so,
		// and lists their titles. A look into one chat alone has nothing worth
		// listing. Persona keeps the memories as they were, as bullets.
		const mode =
			typeof segment.metadata?.mode === "string" ? segment.metadata.mode : null;
		if ((mode === "history" || mode === "project") && titles.length > 0) {
			const inOneChat = [
				"historyConversationId",
				"siblingConversationId",
				"selectedConversationId",
			].some((name) => Boolean(segment.input?.[name]));
			const chatsVerb = translate("toolRows.verb.lookedThrough");
			const chats = translate("toolRows.meta.pastChats", {
				count: inOneChat ? 1 : titles.length,
			});
			return {
				...base,
				verb: chatsVerb,
				object: chats,
				meta: "",
				summaryLabel: `${chatsVerb} ${chats}`,
				title: chats,
				body: inOneChat
					? null
					: {
							kind: "things",
							icon: "chat",
							items: titles.slice(0, THINGS_SHOWN).map((title) => ({ title })),
							more: Math.max(0, titles.length - THINGS_SHOWN),
						},
			};
		}
		const bullets = titles.slice(0, 8);
		// A recall that returned nothing (or has not returned yet) must not
		// claim "0 memories" — it names what it was looking FOR (the query, never
		// the mode it was asked in) instead, and says nothing at all when it has
		// neither.
		const object =
			bullets.length > 0
				? translate("toolActivity.memoriesCount", { count: bullets.length })
				: typeof segment.input?.query === "string"
					? segment.input.query.trim().slice(0, 200)
					: "";
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
	// below would say "Tool <id>", and in a Hungarian turn "Eszköz e4d471c7-...". The
	// name is enough, so the row does not open; the part of a file it read (a page,
	// a part) shows after the name.
	if (
		segment.name === "read_artifact" ||
		segment.name === "read_generated_file"
	) {
		const readVerb = verb(translate, "reading", "read", status);
		const object = readItemName(segment);
		const page = wholeNumber(segment.input?.page);
		const part = wholeNumber(segment.input?.part);
		const objectSuffix =
			page !== null
				? translate("toolRows.suffix.page", { number: page })
				: part !== null
					? translate("toolRows.suffix.part", { number: part })
					: undefined;
		return {
			...base,
			verb: readVerb,
			object,
			...(objectSuffix ? { objectSuffix } : {}),
			meta: "",
			summaryLabel: readVerb,
			title: object ? `${readVerb}: ${object}` : readVerb,
			body: null,
		};
	}

	// The offer of an instruction the person may keep: the row names it, and the
	// offer itself has its own card (`message.instructionSuggestions`), so it does
	// not open.
	if (segment.name === "suggest_instruction") {
		const offered =
			typeof segment.input?.text === "string"
				? segment.input.text.trim().slice(0, 200)
				: "";
		const suggestVerb = translate("toolRows.verb.suggestedInstruction");
		return {
			...base,
			verb: suggestVerb,
			object: offered,
			meta: "",
			summaryLabel: suggestVerb,
			title: offered ? `${suggestVerb} ${offered}` : suggestVerb,
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

type ConnectorCallView = {
	key: string;
	label: string;
	status: ToolActivityStatus;
	code: string | null;
	count: number | null;
	sub?: string;
	things?: { items: { title: string; sub?: string }[]; more: number };
	reason?: string;
};

/**
 * One call of an account tool in plain words: what it did (the phrase for its
 * action), how it went (the glyph of its code's kind), what it found (a count and
 * the things by their own names) or why it did not work (one sentence). A call
 * still marked running in a reply that is over was cut off and reads as stopped.
 */
function describeConnectorCall(
	tool: ToolCallSegment,
	index: number,
	translate: Translate,
	options: TurnEnd & { locale?: string; timeZone?: string },
): ConnectorCallView {
	const call =
		options.turnEnded === true && tool.status === "running"
			? cutOffCall(tool, options.turnStopped === true)
			: tool;
	const key = tool.callId ?? `${tool.name}-${index}`;
	const phraseKey = connectorPhraseKey(call.name, call.input?.action);
	const label = phraseKey
		? translate(phraseKey)
		: translate(getHumanReadableToolNameKey(call.name));
	if (call.status === "running") {
		return { key, label, status: "running", code: null, count: null };
	}
	const reason = describeReason(call, translate);
	if (reason && (reason.kind === "fail" || reason.kind === "stop")) {
		return {
			key,
			label,
			status: reason.kind === "fail" ? "failed" : "skipped",
			code: reason.code,
			count: null,
			...(reason.text ? { reason: reason.text } : {}),
		};
	}
	// It worked (or worked, and says one thing about it): what it found.
	const count = connectorCountOf(call.name, call.metadata);
	const thingsIcon = connectorThingsIcon(call.name);
	const formatTime = (iso: string) =>
		formatEventTime(iso, options.locale, {
			withDay: true,
			...(options.timeZone ? { timeZone: options.timeZone } : {}),
		});
	const named = thingsIcon
		? (call.candidates ?? [])
				.map((candidate) => {
					const title = localizedThingTitle(
						stripToPlainText(candidate.title ?? ""),
						translate,
						formatTime,
					);
					const start =
						call.name === "calendar" &&
						typeof candidate.metadata?.start === "string"
							? formatTime(candidate.metadata.start)
							: undefined;
					return { title, ...(start ? { sub: start } : {}) };
				})
				.filter((thing) => thing.title.length > 0)
		: [];
	const shown = named.slice(0, THINGS_SHOWN);
	return {
		key,
		label,
		status: "done",
		code: reason?.code ?? null,
		count,
		...(count !== null
			? { sub: translate("toolRows.unit.found", { count }) }
			: {}),
		...(shown.length > 0
			? {
					things: {
						items: shown,
						more: Math.max(
							0,
							Math.max(count ?? 0, named.length) - shown.length,
						),
					},
				}
			: {}),
		...(reason?.text ? { reason: reason.text } : {}),
	};
}

/**
 * Builds the view-model for a collapsed run of an account's calls: the row says
 * what came back across the run in the account's own unit ("Calendar · 3 events"),
 * its glyph is the worst of how its calls went (a failure over a stop over a
 * success), and opened it lists each call in plain words with what it found.
 *
 * `options.turnEnded`: the reply is over, so a call still marked running was cut
 * off and reads as a quiet stop; `options.turnStopped` says the person pressed
 * Stop, as for any row (`buildToolActivityItem`). `options.locale` is the
 * reader's own (`eventLocale`), for the times it names.
 */
export function buildConnectorActivityItem(
	tools: ToolCallSegment[],
	key: string,
	translate: Translate,
	options: TurnEnd & { locale?: string; timeZone?: string } = {},
): ToolActivityItem {
	const calls = tools.map((tool, index) =>
		describeConnectorCall(tool, index, translate, options),
	);
	const anyRunning = calls.some((call) => call.status === "running");
	const status: ToolActivityStatus = anyRunning
		? "running"
		: calls.some((call) => call.status === "failed")
			? "failed"
			: calls.some((call) => call.status === "skipped")
				? "skipped"
				: "done";
	const labelKey =
		getConnectionToolLabelKey(tools[0].name) ?? "toolCalls.generic";
	const label = translate(labelKey);
	// What came back across the run, in the account's own unit; "N actions" only
	// when nothing the run did was countable. An account that is not connected says
	// so, since that is the whole of what the run has to tell.
	const counted = calls.filter((call) => call.count !== null);
	const notConnected = calls.every((call) => call.code === "not_connected");
	const object = notConnected
		? translate("toolRows.object.notConnected")
		: counted.length > 0
			? translate(connectorUnitKey(tools[0].name), {
					count: counted.reduce((sum, call) => sum + (call.count ?? 0), 0),
				})
			: translate("toolCalls.actionsCount", { count: tools.length });
	const viewed = photosViewedIn(tools);
	// The model was shown photos, and the row says so instead of counting
	// actions: "Looked at 6 photos". Those words are the whole row (no object
	// after them), so repeats fold into "Looked at 6 photos x2" like any other
	// row with nothing countable behind it. The opened panel still lists every
	// action.
	const looked =
		viewed > 0 ? translate(VERB_KEYS.photosViewed, { count: viewed }) : null;
	const failedMeta = translate("toolCalls.failed");
	const summaryLabel =
		status === "failed"
			? `${looked ?? label} ${failedMeta}`
			: status === "skipped"
				? (looked ?? label)
				: (looked ?? `${label} ${object}`);
	return {
		key,
		status,
		iconType: getToolCallIconType(tools[0].name),
		verb: looked ?? label,
		object: looked === null ? object : "",
		meta: status === "failed" ? failedMeta : "",
		summaryLabel,
		...(looked === null
			? { summaryUnit: "actions" as const, summaryCount: tools.length }
			: {}),
		pinned: false,
		alwaysOpen: false,
		title: `${label} · ${looked ?? object}`,
		body: {
			kind: "actions",
			icon: getToolCallIconType(tools[0].name),
			actions: calls.map((call) => ({
				key: call.key,
				label: call.label,
				status: call.status,
				...(call.sub ? { sub: call.sub } : {}),
				...(call.things ? { things: call.things } : {}),
				...(call.reason ? { reason: call.reason } : {}),
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
