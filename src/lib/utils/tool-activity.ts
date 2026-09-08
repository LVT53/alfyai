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

import type { I18nKey } from "$lib/i18n";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type {
	ThinkingSegment,
	ToolCallMapData,
} from "$lib/server/services/messages-types";
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

export type ToolActivityStatus = "running" | "done" | "failed";

/** The opened panel under a row. One variant per tool shape in the mockup. */
export type ToolActivityBody =
	| { kind: "sources"; sources: FetchedSource[]; citedCount: number }
	| { kind: "page"; sources: FetchedSource[]; excerpt: string | null }
	| { kind: "python"; program: string; output: string | null }
	| { kind: "map"; map: ToolCallMapData; summary: string }
	| { kind: "text"; text: string }
	| { kind: "bullets"; items: string[] }
	| {
			kind: "actions";
			actions: { key: string; label: string; status: ToolActivityStatus }[];
	  }
	| { kind: "error"; reason: string }
	| {
			kind: "generic";
			args: { key: string; value: string }[];
			result: string | null;
	  }
	// The file-production body is rendered by FileProductionCard.svelte (the
	// reduced, body-only component); the job itself is threaded through the
	// component prop rather than flattened here.
	| { kind: "file-job" };

export type ToolActivityItem = {
	key: string;
	status: ToolActivityStatus;
	iconType: ToolCallIconType;
	/** Muted leading word ("Searched", "Reading", "Created"). */
	verb: string;
	/** Primary text — the thing the tool acted on. May be empty. */
	object: string;
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
	creating: "toolActivity.creating",
	usedSkill: "toolActivity.usedSkill",
	usingSkill: "toolActivity.usingSkill",
	recalled: "toolActivity.recalled",
	recalling: "toolActivity.recalling",
} as const satisfies Record<string, I18nKey>;

type VerbName = keyof typeof VERB_KEYS;

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
	"toolCalls.detailArguments",
	"toolCalls.detailResult",
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
 * A tool call's elapsed time, when the segment honestly carries one. No
 * server-side timing rides on a tool-call segment today, so this is silent
 * (returns null) unless a future `metadata.durationMs` shows up — never a
 * fabricated number.
 */
export function toolElapsedLabel(
	metadata: Record<string, string | number | boolean | null> | undefined,
): string | null {
	const raw = metadata?.durationMs;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
	if (raw < 1000) return `${Math.round(raw)} ms`;
	const seconds = raw / 1000;
	return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

/**
 * The sources shown under a search/read row. Prefers the call's own web
 * candidates (they carry real titles, citation status and excerpts) and falls
 * back to the URLs the call was given, so a read row never renders empty.
 */
export function getToolWebSources(segment: ToolCallSegment): FetchedSource[] {
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
		? getFetchUrlSources(segment.name, segment.input)
		: [];
}

function citedCount(sources: FetchedSource[]): number {
	return sources.filter(isCitedSource).length;
}

function firstStringInput(input: Record<string, unknown>): string {
	return String(Object.values(input ?? {})[0] ?? "").trim();
}

/** The failure reason a failed row's body carries — never invented. */
export function toolFailureReason(segment: {
	outputSummary?: string | null;
	metadata?: Record<string, string | number | boolean | null>;
}): string | null {
	const fromMetadata = segment.metadata?.error;
	if (typeof fromMetadata === "string" && fromMetadata.trim()) {
		return fromMetadata.trim();
	}
	const summary = segment.outputSummary?.trim();
	return summary ? summary : null;
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
export function transitMeta(
	map: ToolCallMapData,
	translate: Translate,
): string {
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
export function journeyMeta(
	map: ToolCallMapData,
	translate: Translate,
): string {
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

function genericArguments(
	input: Record<string, unknown>,
): { key: string; value: string }[] {
	return Object.entries(input ?? {})
		.map(([key, value]) => [key, String(value ?? "").trim()] as const)
		.filter(([, value]) => value.length > 0)
		.map(([key, value]) => ({ key, value: value.slice(0, 500) }));
}

function genericBody(segment: ToolCallSegment): ToolActivityBody | null {
	const args = genericArguments(segment.input);
	const result = segment.outputSummary?.trim() || null;
	if (args.length === 0 && !result) return null;
	return { kind: "generic", args, result };
}

/**
 * Builds the view-model for one non-connector tool call.
 *
 * A failed call keeps the SAME label a successful one would have had ("Read
 * weather.metoffice.gov.uk", not a neutral tool name): per the approved
 * mockup, only the status glyph and the right-hand word go red, and the body
 * becomes the reason. So the grammar is built first, and failure is applied
 * on top of it.
 */
export function buildToolActivityItem(
	segment: ToolCallSegment,
	key: string,
	translate: Translate,
): ToolActivityItem {
	const item = buildSettledToolActivityItem(segment, key, translate);
	if (segment.status !== "failed") return item;
	const failedMeta = translate("toolCalls.failed");
	const reason = toolFailureReason(segment);
	return {
		...item,
		meta: failedMeta,
		summaryLabel: `${item.verb} ${failedMeta}`,
		// A call that failed contributed nothing to count up.
		summaryCount: 0,
		// Nothing failed is a deliverable, and nothing failed pins itself open.
		pinned: false,
		alwaysOpen: false,
		body: reason ? { kind: "error", reason } : null,
	};
}

function buildSettledToolActivityItem(
	segment: ToolCallSegment,
	key: string,
	translate: Translate,
): ToolActivityItem {
	const status = segment.status;
	const iconType = getToolCallIconType(segment.name);
	const elapsed = toolElapsedLabel(segment.metadata);
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
				: (elapsed ?? "");
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
			meta: elapsed ?? "",
			summaryLabel: imageVerb,
			title: query,
			body: genericBody(segment),
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
			meta: elapsed ?? "",
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
			meta: elapsed ?? "",
			summaryLabel: pythonVerb,
			title: object,
			body: program
				? {
						kind: "python",
						program,
						output: segment.outputSummary?.trim() || null,
					}
				: genericBody(segment),
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
			: (elapsed ?? "");
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
				: genericBody(segment),
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
			meta: elapsed ?? "",
			summaryLabel: `${skillVerb} ${displayName}`.trim(),
			title: displayName,
			body: description ? { kind: "text", text: description } : null,
		};
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
			meta: elapsed ?? "",
			summaryLabel: `${memoryVerb} ${object}`.trim(),
			summaryUnit: "memories",
			summaryCount: bullets.length,
			title: object,
			body:
				bullets.length > 0
					? { kind: "bullets", items: bullets }
					: genericBody(segment),
		};
	}

	const identity = describeToolIdentity(segment, translate);
	return {
		...base,
		verb: identity.verb,
		object: identity.object,
		meta: elapsed ?? "",
		summaryLabel: identity.verb,
		title: identity.title,
		body: genericBody(segment),
	};
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
	return {
		key,
		status,
		iconType: getToolCallIconType(tools[0].name),
		verb: label,
		object,
		meta: anyFailed ? translate("toolCalls.failed") : "",
		summaryLabel: `${label} ${object}`,
		summaryUnit: "actions",
		summaryCount: tools.length,
		pinned: false,
		alwaysOpen: false,
		title: `${label} · ${object}`,
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
	failed: boolean;
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
	if (group.failed) {
		return translate("toolActivity.summaryFailedCount", {
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
		const failed = item.status === "failed";
		const groupKey = `${item.iconType} ${item.verb} ${failed}`;
		const existing = groups.get(groupKey);
		if (existing) {
			existing.occurrences += 1;
			existing.total += item.summaryCount ?? 0;
			continue;
		}
		groups.set(groupKey, {
			key: item.key,
			iconType: item.iconType,
			verb: item.verb,
			failed,
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
		alwaysOpen: isActive,
		title: object,
		body: { kind: "file-job" },
	};
}

/** Narrowing helper so callers can share one guard. */
export function isToolCallSegment(
	segment: ThinkingSegment,
): segment is ToolCallSegment {
	return segment.type === "tool_call";
}

export { formatByteSize };
