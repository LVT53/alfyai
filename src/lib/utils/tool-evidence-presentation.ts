// Tier B1 (chat-experience-elevation §5) — the pure tool-evidence
// presentation layer extracted out of the ~3k-line ThinkingBlock.svelte.
//
// Everything here is the per-tool DOMAIN logic that shapes a completed tool
// call's raw candidates/inputs into the compact view-models the thinking
// block renders: source lists (web search + read-page), the favicon proxy
// URL, cited-first ordering + dedupe, the search-card summary, the
// agenda/photo peeks, the Immich thumbnail URL rewrite, and the tool-call
// labels. It mirrors the existing `reasoning-spine.ts` /
// `thought-step-anchor.ts` extractions: pure functions returning plain data,
// unit-tested directly rather than only reachable through the huge component
// test.
//
// Boundary rule (per the B1 brief): nothing Svelte-reactive and nothing that
// imports the `$t` store lives here. The two functions that are i18n-coupled
// (`buildFetchedSourceSummary`, `formatToolCall`) take the translator as a
// plain `Translate` parameter — the component threads its own `$t` in — so
// the branching/assembly logic (the part actually worth testing) stays here
// and directly testable with a fake translator, while ThinkingBlock keeps
// only a one-line binding shell. `Intl`-based time formatting and DOM
// error-handlers stay in the component (presentational, not domain logic).
//
// All server-type imports are `import type` only — they are erased at compile
// time, so this stays a client-safe module even though the types originate
// under `$lib/server` (same pattern ThinkingBlock already relies on).
import type { I18nKey } from "$lib/i18n";
import type {
	MessageEvidenceStatus,
	ToolEvidenceCandidate,
} from "$lib/server/services/message-evidence";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import {
	formatConnectionToolAction,
	getHumanReadableToolNameKey,
	isConnectionToolName,
	isFileProductionToolName,
} from "$lib/utils/tool-calls";

/** A tool_call thinking segment, narrowed to the tool-call variant. */
export type ToolCallSegment = ThinkingSegment & { type: "tool_call" };

/**
 * A single source chip rendered under a search/read tool call. Web-search
 * sources carry a citation-driven `status` ("selected" = the answer cited it);
 * plain read (fetch_url) pages have no citation concept and omit it.
 */
export type FetchedSource = {
	title: string;
	url: string;
	// Citation-driven status from C1: "selected" = the answer cited this
	// source; "reference"/"rejected" = retrieved but not cited. Absent for
	// plain read (fetch_url) pages, which have no citation concept.
	status?: MessageEvidenceStatus;
	// Compact reason/snippet surfaced in the chip's hover tooltip.
	reason?: string;
};

/** Whether a source group summarizes a web search or a read-page (fetch_url) call. */
export type FetchedSourceKind = "search" | "read";

/**
 * The translator shape the component's `$t` store already satisfies. Threaded
 * in as a parameter so the i18n-coupled label/summary builders stay pure and
 * unit-testable without pulling the Svelte i18n store into this module.
 */
export type Translate = (
	key: I18nKey,
	params?: Record<string, string | number>,
) => string;

// Task 11b — agenda peek + photo strip caps. Both peeks read exclusively from
// segment.candidates (the user's own tool-evidence data), so these are
// display-only slices, not a new data channel.
const AGENDA_PEEK_MAX = 5;
const PHOTO_STRIP_MAX = 8;

export function extractHostname(raw: string): string {
	try {
		return new URL(raw).hostname.replace(/^www\./, "");
	} catch {
		return raw.slice(0, 40);
	}
}

export function getFaviconUrl(raw: string): string | null {
	// Privacy proxy (ADR 0043, Slice 12): route the favicon through our own
	// /api/favicon endpoint so researched domains are no longer leaked to
	// Google's s2/favicons. The endpoint always returns an image (a globe
	// fallback when no icon exists), so the `onerror` hide-img path in the
	// template is now rarely exercised but retained as a safety net.
	try {
		const parsed = new URL(raw);
		const host = parsed.hostname.replace(/^www\./, "");
		return `/api/favicon?domain=${encodeURIComponent(host)}`;
	} catch {
		return null;
	}
}

function isFetchTool(name: string): boolean {
	const n = name.toLowerCase();
	return (
		n.includes("fetch") ||
		n.includes("url") ||
		n.includes("web") ||
		n.includes("browse")
	);
}

function toUrlList(value: unknown): string[] {
	return String(value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => {
			try {
				new URL(part);
				return true;
			} catch {
				return false;
			}
		});
}

export function getFetchUrls(
	name: string,
	input: Record<string, unknown>,
): string[] {
	if (isFileProductionToolName(name)) return [];
	if (!isFetchTool(name)) return [];
	return Object.values(input).flatMap(toUrlList);
}

// Reduce a web title/excerpt to clean, readable plain text for the hover
// tooltip: strip HTML tags + common entities and markdown syntax (emphasis,
// inline code, links/images, heading/quote/list markers), then collapse
// whitespace — so the popover never surfaces raw <tags> or **markdown** noise
// from a search provider's snippet. Unpaired `*`/`_` are left alone so prose
// and identifiers aren't mangled.
export function stripToPlainText(raw: string): string {
	return raw
		.replace(/<[^>]*>/g, " ") // HTML tags
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // ![alt](url) -> alt
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
		.replace(/(\*\*|__)(.+?)\1/g, "$2") // **bold** / __bold__
		.replace(/(\*|_)(.+?)\1/g, "$2") // *italic* / _italic_
		.replace(/~~(.+?)~~/g, "$1") // ~~strike~~
		.replace(/`([^`]+)`/g, "$1") // `code`
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "") // block markers
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

// Pull a compact tooltip reason for a web candidate: prefer its snippet, then
// fall back to a reasoning/description/reason field the server may attach on
// the candidate's metadata bag.
export function candidateReason(
	candidate: ToolEvidenceCandidate,
): string | undefined {
	if (candidate.snippet?.trim()) return candidate.snippet.trim();
	const meta = candidate.metadata ?? {};
	for (const key of ["reason", "reasoning", "description", "summary"]) {
		const value = meta[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function isCitedSource(source: FetchedSource): boolean {
	return source.status === "selected";
}

// Cited (status "selected") sources lead; everything else keeps its original
// order behind them. Stable so the collapsed favicon stack and the expanded
// chip row agree on ordering.
export function orderCitedFirst(sources: FetchedSource[]): FetchedSource[] {
	const cited = sources.filter(isCitedSource);
	const rest = sources.filter((source) => !isCitedSource(source));
	return [...cited, ...rest];
}

export function dedupeSourcesByUrl(sources: FetchedSource[]): FetchedSource[] {
	const indexByUrl = new Map<string, number>();
	const deduped: FetchedSource[] = [];
	for (const source of sources) {
		const existingIndex = indexByUrl.get(source.url);
		if (existingIndex === undefined) {
			indexByUrl.set(source.url, deduped.length);
			deduped.push(source);
			continue;
		}
		// On a URL collision, prefer the cited ("selected") copy so a divergent
		// status (e.g. the same URL retrieved once as a reference and once as a
		// citation) never drops the citation. First-occurrence position is kept.
		const existing = deduped[existingIndex];
		if (source.status === "selected" && existing.status !== "selected") {
			deduped[existingIndex] = source;
		}
	}
	return deduped;
}

export function getFetchedSources(segment: ThinkingSegment): FetchedSource[] {
	if (segment.type !== "tool_call" || segment.name !== "research_web")
		return [];
	return orderCitedFirst(
		dedupeSourcesByUrl(
			(segment.candidates ?? [])
				.filter((candidate) => candidate.sourceType === "web" && candidate.url)
				.map((candidate) => {
					const reason = candidateReason(candidate);
					return {
						title: stripToPlainText(
							candidate.title || extractHostname(candidate.url ?? ""),
						),
						url: candidate.url as string,
						status: candidate.status,
						// Clean plain text for the hover excerpt — no raw markdown/HTML.
						reason: reason ? stripToPlainText(reason) : undefined,
					};
				}),
		),
	);
}

export function getFetchUrlSources(
	name: string,
	input: Record<string, unknown>,
): FetchedSource[] {
	return dedupeSourcesByUrl(
		getFetchUrls(name, input).map((url) => ({
			title: extractHostname(url),
			url,
		})),
	);
}

export function citedCount(sources: FetchedSource[]): number {
	return sources.filter(isCitedSource).length;
}

// The search-card / read-card summary text. i18n-coupled, so the translator is
// threaded in: for "read" it is "Read N page(s)"; for "search" it is
// "Searched the web · N source(s)" with a "· M cited" clause appended only when
// at least one source was cited.
export function buildFetchedSourceSummary(
	sources: FetchedSource[],
	kind: FetchedSourceKind,
	translate: Translate,
): string {
	const count = sources.length;
	if (kind === "read") {
		return translate("toolCalls.readPagesCount", { count });
	}
	const base = `${translate("toolCalls.searchedWeb")} · ${translate("toolCalls.sourcesCount", { count })}`;
	const cited = citedCount(sources);
	if (cited > 0) {
		return `${base} · ${translate("toolCalls.citedCount", { count: cited })}`;
	}
	return base;
}

export function isCalendarToolName(name: string): boolean {
	return name.toLowerCase() === "calendar";
}

export function isPhotosToolName(name: string): boolean {
	return name.toLowerCase() === "photos";
}

export function getAgendaCandidates(
	tools: ToolCallSegment[],
): ToolEvidenceCandidate[] {
	return tools
		.flatMap((tool) => tool.candidates ?? [])
		.filter((candidate) => typeof candidate.metadata?.start === "string")
		.slice(0, AGENDA_PEEK_MAX);
}

export function getPhotoCandidates(
	tools: ToolCallSegment[],
): ToolEvidenceCandidate[] {
	return tools
		.flatMap((tool) => tool.candidates ?? [])
		.filter(
			(candidate) => typeof candidate.metadata?.thumbnailPath === "string",
		)
		.slice(0, PHOTO_STRIP_MAX);
}

// Maps a photo candidate's server-internal thumbnailPath
// ("/api/assets/{assetId}/thumbnail" — see photos.ts's toCandidate) to the
// Task 11a authed per-user proxy route that actually serves the bytes
// ("/api/connections/immich/thumbnail/{assetId}"). The Immich API key never
// reaches the client either way — this is purely a URL rewrite.
export function immichThumbnailUrl(thumbnailPath: unknown): string | null {
	if (typeof thumbnailPath !== "string") return null;
	const match = thumbnailPath.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
	return match ? `/api/connections/immich/thumbnail/${match[1]}` : null;
}

// The tool-call chip label ("Searched the web: \"query\"", "Fetch page:
// example.com", "Calendar: list events", ...). i18n-coupled, so the translator
// is threaded in; every other decision (which branch, which argument to slice)
// is pure.
export function formatToolCall(
	name: string,
	input: Record<string, unknown>,
	translate: Translate,
): string {
	const n = name.toLowerCase();
	const firstVal = () => String(Object.values(input)[0] ?? "").slice(0, 200);
	const toolLabel = translate(getHumanReadableToolNameKey(name));
	if (isFileProductionToolName(name)) {
		return toolLabel;
	}
	if (n.includes("search") || n.includes("tavily")) {
		const q = input.query ?? input.q ?? Object.values(input)[0];
		const label =
			n === "research_web" || n.includes("web")
				? toolLabel
				: translate("toolCalls.search");
		return `${label}: "${String(q ?? "").slice(0, 200)}"`;
	}
	if (isFetchTool(name)) {
		const raw = String(Object.values(input)[0] ?? "");
		return `${toolLabel}: ${extractHostname(raw)}`;
	}
	// Connection tools ("calendar", "files", ...) label by their capability +
	// the human-formatted action ("Calendar: list events"), never the raw
	// "list_events" first-value that read vague to end users.
	if (isConnectionToolName(name)) {
		const action =
			typeof input.action === "string"
				? formatConnectionToolAction(input.action)
				: "";
		return action ? `${toolLabel}: ${action}` : toolLabel;
	}
	return firstVal() ? `${toolLabel}: ${firstVal()}` : toolLabel;
}

export function getToolTitle(
	name: string,
	input: Record<string, unknown>,
): string {
	const n = name.toLowerCase();
	if (n.includes("search") || n.includes("tavily")) {
		const q = input.query ?? input.q ?? Object.values(input)[0];
		return String(q ?? "");
	}
	if (isFileProductionToolName(name)) {
		const title = input.requestTitle ?? input.filename ?? input.documentIntent;
		return title ? String(title) : "produce_file";
	}
	if (isFetchTool(name)) {
		return String(Object.values(input)[0] ?? "");
	}
	return String(Object.values(input)[0] ?? "");
}
