<script lang="ts">
import { t } from "$lib/i18n";
import type {
	MessageEvidenceStatus,
	ThinkingSegment,
	ToolEvidenceCandidate,
} from "$lib/types";
import { untrack } from "svelte";
import {
	Check,
	ChevronDown,
	ClipboardCheck,
	Bot,
	Languages,
	Layers,
	Search,
	ShieldAlert,
} from "@lucide/svelte";
import {
	formatConnectionToolAction,
	getConnectionToolLabelKey,
	getHumanReadableToolNameKey,
	isConnectionToolName,
	isFileProductionToolName,
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
} from "$lib/utils/tool-calls";

type DeliberationStatusSegment = {
	type: "status";
	id: string;
	label: string;
	status: "running" | "done" | "error";
	passIndex?: number;
	passTotal?: number;
	passKind?: string;
};

let {
	content = "",
	thinkingIsDone = false,
	segments = [],
	streaming = false,
	thinkingDurationSeconds = 0,
}: {
	content?: string;
	thinkingIsDone?: boolean;
	segments?: ThinkingSegment[];
	streaming?: boolean;
	thinkingDurationSeconds?: number;
} = $props();

let expanded = $state(false);
let container = $state<HTMLDivElement | undefined>(undefined);
let prevContentLength = $state(0);
let contentFresh = $state(false);
let newCharStart = $state(-1);
let freshTimeout: ReturnType<typeof setTimeout> | undefined;
let thinkingSeconds = $state(untrack(() => thinkingDurationSeconds));
let thinkingTimerInterval: ReturnType<typeof setInterval> | undefined;

type FetchedSource = {
	title: string;
	url: string;
	// Citation-driven status from C1: "selected" = the answer cited this
	// source; "reference"/"rejected" = retrieved but not cited. Absent for
	// plain read (fetch_url) pages, which have no citation concept.
	status?: MessageEvidenceStatus;
	// Compact reason/snippet surfaced in the chip's hover tooltip.
	reason?: string;
};

const isActiveThinking = $derived(!thinkingIsDone);
const visibleSegmentsRaw = $derived(segments.filter(isVisibleThinkingSegment));

function isDeliberationStatusSegment(
	segment: ThinkingSegment,
): segment is DeliberationStatusSegment {
	return (
		segment.type === "status" &&
		segment.id.startsWith("deliberation-pass-") &&
		segment.label.trim().length > 0
	);
}

function getDeliberationPassIndex(segmentId: string): number {
	const match = segmentId.match(/deliberation-pass-(\d+)/i);
	const parsed = match ? Number.parseInt(match[1], 10) : NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function getDeliberationStatusIconType(
	segment: DeliberationStatusSegment,
):
	| "search"
	| "clipboard-check"
	| "shield-alert"
	| "languages"
	| "layers"
	| "bot" {
	if (segment.type !== "status") return "search";
	const passKind = segment.passKind;
	if (
		passKind === "context_source_gap_review" ||
		passKind === "evidence_gap_review" ||
		passKind === "source_reconciliation"
	)
		return "search";
	if (
		passKind === "missed_user_need_check" ||
		passKind === "answer_plan_critique" ||
		passKind === "final_format_style_check"
	)
		return "clipboard-check";
	if (
		passKind === "contradiction_risk_check" ||
		passKind === "adversarial_edge_case_check"
	)
		return "shield-alert";
	if (passKind === "hungarian_parity_check") return "languages";
	if (passKind === "workspace_synthesis") return "layers";
	if (passKind === "viable_alternatives_preservation") return "bot";
	const pass = getDeliberationPassIndex(segment.id);
	if (pass === 1) return "search";
	if (pass === 2) return "clipboard-check";
	return "shield-alert";
}

function formatDeliberationStatusLabel(
	segment: DeliberationStatusSegment,
): string {
	const label = segment.label.trim();
	if (!label) return "";
	const current =
		typeof segment.passIndex === "number" && Number.isInteger(segment.passIndex)
			? segment.passIndex
			: getDeliberationPassIndex(segment.id);
	const total = segment.passTotal;
	if (typeof total === "number" && Number.isInteger(total) && total > 0) {
		return $t("chat.deliberatingProgress", { current, total, label });
	}
	return label;
}

const latestDeliberationStatusSegment = $derived.by(() => {
	for (let i = visibleSegmentsRaw.length - 1; i >= 0; i -= 1) {
		if (isDeliberationStatusSegment(visibleSegmentsRaw[i])) {
			return visibleSegmentsRaw[i];
		}
	}
	return undefined;
});

const latestDeliberationStatusSegmentId = $derived.by(() =>
	latestDeliberationStatusSegment?.type === "status"
		? latestDeliberationStatusSegment.id
		: null,
);

const visibleSegments = $derived(
	streaming
		? visibleSegmentsRaw.filter((segment) => {
				if (!isDeliberationStatusSegment(segment)) return true;
				return latestDeliberationStatusSegmentId
					? segment.id === latestDeliberationStatusSegmentId
					: false;
			})
		: visibleSegmentsRaw,
);
const hasSegments = $derived(visibleSegments.length > 0);
const visibleTools = $derived(segments.filter(isVisibleThinkingToolCall));
const hasVisibleSurface = $derived(
	content.trim().length > 0 || hasSegments || visibleTools.length > 0,
);

type ToolCallSegment = ThinkingSegment & { type: "tool_call" };
type TextSegment = ThinkingSegment & { type: "text" };
type StatusSegment = ThinkingSegment & { type: "status" };

// Connector tool calls (calendar/contacts/email/files/location/media/photos)
// can fire dozens of times per turn. Collapse repeated calls to the same
// capability into a single expandable group instead of spamming one row per
// call — mirrors the existing fetchedSourceGroup collapse precedent below.
type ToolStackEntry =
	| { kind: "tool"; tool: ToolCallSegment; key: string }
	| {
			kind: "connector-group";
			name: string;
			tools: ToolCallSegment[];
			key: string;
	  };

const toolStackEntries: ToolStackEntry[] = $derived.by(() => {
	const entries: ToolStackEntry[] = [];
	let groupIndexByName: Map<string, number> | null = null;
	visibleTools.forEach((tool, i) => {
		if (isConnectionToolName(tool.name)) {
			if (!groupIndexByName) groupIndexByName = new Map();
			const existingIndex = groupIndexByName.get(tool.name);
			if (existingIndex !== undefined) {
				const entry = entries[existingIndex];
				if (entry.kind === "connector-group") entry.tools.push(tool);
				return;
			}
			groupIndexByName.set(tool.name, entries.length);
			entries.push({
				kind: "connector-group",
				name: tool.name,
				tools: [tool],
				key: `group-${tool.name}-${i}`,
			});
			return;
		}
		groupIndexByName = null;
		entries.push({
			kind: "tool",
			tool,
			key: tool.callId ?? `${tool.name + JSON.stringify(tool.input)}-${i}`,
		});
	});
	return entries;
});

// Interleaved thinking view: group connector calls only within a contiguous
// run of connector tool_call segments. Any non-connector segment (thinking
// text, a status step, or a non-connector tool call) breaks the run, so the
// grouping never reorders content relative to the surrounding narration.
type InterleavedEntry =
	| { kind: "text"; segment: TextSegment; key: string }
	| { kind: "status"; segment: StatusSegment; key: string }
	| { kind: "tool"; segment: ToolCallSegment; key: string }
	| {
			kind: "connector-group";
			name: string;
			tools: ToolCallSegment[];
			key: string;
	  };

const interleavedEntries: InterleavedEntry[] = $derived.by(() => {
	const entries: InterleavedEntry[] = [];
	let runGroupIndexByName: Map<string, number> | null = null;
	visibleSegments.forEach((seg, i) => {
		if (seg.type === "tool_call" && isConnectionToolName(seg.name)) {
			if (!runGroupIndexByName) runGroupIndexByName = new Map();
			const existingIndex = runGroupIndexByName.get(seg.name);
			if (existingIndex !== undefined) {
				const entry = entries[existingIndex];
				if (entry.kind === "connector-group") entry.tools.push(seg);
				return;
			}
			runGroupIndexByName.set(seg.name, entries.length);
			entries.push({
				kind: "connector-group",
				name: seg.name,
				tools: [seg],
				key: `group-${seg.name}-${i}`,
			});
			return;
		}
		runGroupIndexByName = null;
		if (seg.type === "tool_call") {
			entries.push({
				kind: "tool",
				segment: seg,
				key: seg.callId ?? `${seg.name + JSON.stringify(seg.input)}-${i}`,
			});
		} else if (seg.type === "status") {
			entries.push({ kind: "status", segment: seg, key: seg.id });
		} else {
			entries.push({ kind: "text", segment: seg, key: `text-${i}` });
		}
	});
	return entries;
});

function connectorGroupLabel(name: string): string {
	const key = getConnectionToolLabelKey(name);
	return $t(key ?? "toolCalls.generic");
}

function connectorGroupSummary(name: string, count: number): string {
	return `${connectorGroupLabel(name)} · ${$t("toolCalls.actionsCount", { count })}`;
}

function formatGroupedConnectorAction(tool: ToolCallSegment): string {
	const action =
		typeof tool.input.action === "string"
			? formatConnectionToolAction(tool.input.action)
			: "";
	return action || formatToolCall(tool.name, tool.input);
}

$effect(() => {
	const totalLength = hasSegments
		? visibleSegments.reduce(
				(sum, s) =>
					sum +
					(s.type === "text"
						? s.content.length
						: s.type === "status"
							? s.label.length
							: 0),
				0,
			)
		: content.length;
	if (totalLength > prevContentLength && isActiveThinking) {
		contentFresh = true;
		newCharStart = prevContentLength;
		clearTimeout(freshTimeout);
		freshTimeout = setTimeout(() => {
			contentFresh = false;
		}, 500);
	}
	prevContentLength = totalLength;
	return () => {
		clearTimeout(freshTimeout);
	};
});

$effect(() => {
	if (isActiveThinking) {
		thinkingTimerInterval = setInterval(() => {
			thinkingSeconds += 1;
		}, 1000);
	} else {
		clearInterval(thinkingTimerInterval);
	}
	return () => {
		clearInterval(thinkingTimerInterval);
	};
});

const formattedThinkingTime = $derived.by(() => {
	const seconds = thinkingIsDone ? thinkingDurationSeconds : thinkingSeconds;
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
});

function extractHostname(raw: string): string {
	try {
		return new URL(raw).hostname.replace(/^www\./, "");
	} catch {
		return raw.slice(0, 40);
	}
}

function getFaviconUrl(raw: string): string | null {
	// Privacy proxy (ADR 0043, Slice 12): route the favicon through our own
	// /api/favicon endpoint so researched domains are no longer leaked to
	// Google's s2/favicons. The endpoint always returns an image (a globe
	// fallback when no icon exists), so the `onerror` hide-img path below is
	// now rarely exercised but retained as a safety net.
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

function getFetchUrls(name: string, input: Record<string, unknown>): string[] {
	if (isFileProductionToolName(name)) return [];
	if (!isFetchTool(name)) return [];
	return Object.values(input).flatMap(toUrlList);
}

// Pull a compact tooltip reason for a web candidate: prefer its snippet, then
// fall back to a reasoning/description/reason field the server may attach on
// the candidate's metadata bag.
function candidateReason(candidate: ToolEvidenceCandidate): string | undefined {
	if (candidate.snippet && candidate.snippet.trim())
		return candidate.snippet.trim();
	const meta = candidate.metadata ?? {};
	for (const key of ["reason", "reasoning", "description", "summary"]) {
		const value = meta[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isCitedSource(source: FetchedSource): boolean {
	return source.status === "selected";
}

// Cited (status "selected") sources lead; everything else keeps its original
// order behind them. Stable so the collapsed favicon stack and the expanded
// chip row agree on ordering.
function orderCitedFirst(sources: FetchedSource[]): FetchedSource[] {
	const cited = sources.filter(isCitedSource);
	const rest = sources.filter((source) => !isCitedSource(source));
	return [...cited, ...rest];
}

function getFetchedSources(segment: ThinkingSegment): FetchedSource[] {
	if (segment.type !== "tool_call" || segment.name !== "research_web")
		return [];
	return orderCitedFirst(
		dedupeSourcesByUrl(
			(segment.candidates ?? [])
				.filter((candidate) => candidate.sourceType === "web" && candidate.url)
				.map((candidate) => ({
					title: candidate.title || extractHostname(candidate.url ?? ""),
					url: candidate.url as string,
					status: candidate.status,
					reason: candidateReason(candidate),
				})),
		),
	);
}

function getFetchUrlSources(
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

function dedupeSourcesByUrl(sources: FetchedSource[]): FetchedSource[] {
	const seen = new Set<string>();
	const deduped: FetchedSource[] = [];
	for (const source of sources) {
		if (seen.has(source.url)) continue;
		seen.add(source.url);
		deduped.push(source);
	}
	return deduped;
}

// Uncited chips beyond this count fold behind a "+N" reveal so a long tail of
// "also found" sources can't dominate the compact chip row. Cited chips are
// always shown in full — they're the answer's actual citations (and already
// capped server-side to MAX_PAYLOAD_SOURCES).
const UNCITED_CHIP_LIMIT = 6;

function citedCount(sources: FetchedSource[]): number {
	return sources.filter(isCitedSource).length;
}

function uncitedSources(sources: FetchedSource[]): FetchedSource[] {
	return sources.filter((source) => !isCitedSource(source));
}

function fetchedSourceSummary(
	sources: FetchedSource[],
	kind: "search" | "read",
): string {
	const count = sources.length;
	if (kind === "read") {
		return $t("toolCalls.readPagesCount", { count });
	}
	const base = `${$t("toolCalls.searchedWeb")} · ${$t("toolCalls.sourcesCount", { count })}`;
	const cited = citedCount(sources);
	if (cited > 0) {
		return `${base} · ${$t("toolCalls.citedCount", { count: cited })}`;
	}
	return base;
}

function chipTooltip(source: FetchedSource): string {
	return source.reason ? `${source.title}\n${source.reason}` : source.title;
}

// Task 11b — agenda peek + photo strip. Both read exclusively from
// segment.candidates (never modelPayload): candidates are the user's own
// tool-evidence data, already streamed to the client on every tool_call
// segment for the Sources tab, so this is a display-only peek reusing that
// same channel rather than a new server event. Gated on the connector
// tool's NAME first (calendar/photos always group into a connector-group
// entry, even for a single call — see toolStackEntries above), so a web or
// document candidate can never be mistaken for an agenda/photo item even if
// it happened to carry a similarly-named metadata key.
const AGENDA_PEEK_MAX = 5;
const PHOTO_STRIP_MAX = 8;

function isCalendarToolName(name: string): boolean {
	return name.toLowerCase() === "calendar";
}

function isPhotosToolName(name: string): boolean {
	return name.toLowerCase() === "photos";
}

function getAgendaCandidates(
	tools: ToolCallSegment[],
): ToolEvidenceCandidate[] {
	return tools
		.flatMap((tool) => tool.candidates ?? [])
		.filter((candidate) => typeof candidate.metadata?.start === "string")
		.slice(0, AGENDA_PEEK_MAX);
}

function getPhotoCandidates(tools: ToolCallSegment[]): ToolEvidenceCandidate[] {
	return tools
		.flatMap((tool) => tool.candidates ?? [])
		.filter(
			(candidate) => typeof candidate.metadata?.thumbnailPath === "string",
		)
		.slice(0, PHOTO_STRIP_MAX);
}

function formatEventTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

// Maps a photo candidate's server-internal thumbnailPath
// ("/api/assets/{assetId}/thumbnail" — see photos.ts's toCandidate) to the
// Task 11a authed per-user proxy route that actually serves the bytes
// ("/api/connections/immich/thumbnail/{assetId}"). The Immich API key never
// reaches the client either way — this is purely a URL rewrite.
function immichThumbnailUrl(thumbnailPath: unknown): string | null {
	if (typeof thumbnailPath !== "string") return null;
	const match = thumbnailPath.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
	return match ? `/api/connections/immich/thumbnail/${match[1]}` : null;
}

function hideBrokenThumbnail(event: Event): void {
	const img = event.currentTarget;
	if (img instanceof HTMLImageElement) img.style.display = "none";
}

function formatToolCall(name: string, input: Record<string, unknown>): string {
	const n = name.toLowerCase();
	const firstVal = () => String(Object.values(input)[0] ?? "").slice(0, 200);
	const toolLabel = $t(getHumanReadableToolNameKey(name));
	if (isFileProductionToolName(name)) {
		return toolLabel;
	}
	if (n.includes("search") || n.includes("tavily")) {
		const q = input.query ?? input.q ?? Object.values(input)[0];
		const label =
			n === "research_web" || n.includes("web")
				? toolLabel
				: $t("toolCalls.search");
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

function getToolTitle(name: string, input: Record<string, unknown>): string {
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

function formatThinkingTextForDisplay(text: string): string {
	return text.replace(/([a-z0-9)])([.!?])(?=[A-Z](?:[a-z]|\s))/g, "$1$2\n\n");
}

function getFormattedFreshStart(text: string, rawStart: number): number {
	return formatThinkingTextForDisplay(text.slice(0, rawStart)).length;
}

async function toggle() {
	await preserveScrollOnToggle(container, expanded, () => {
		expanded = !expanded;
	});
}
</script>

<script module>
	import { slide } from 'svelte/transition';
	import { preserveScrollOnToggle } from '$lib/actions/preserve-scroll';
</script>

{#snippet fetchedChip(source: FetchedSource)}
	{@const faviconUrl = getFaviconUrl(source.url)}
	{@const cited = isCitedSource(source)}
	<a
		class="fetched-source-chip"
		class:is-cited={cited}
		class:is-uncited={!cited}
		href={source.url}
		target="_blank"
		rel="noopener noreferrer"
		title={chipTooltip(source)}
		aria-label={source.title}
	>
		{#if faviconUrl}
			<img
				class="fetched-favicon"
				src={faviconUrl}
				alt=""
				loading="lazy"
				decoding="async"
				referrerpolicy="no-referrer"
				onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
			/>
		{/if}
		{#if cited}
			<span class="fetched-chip-cited-dot" aria-hidden="true"></span>
		{/if}
		<span class="fetched-source-tooltip" role="tooltip" aria-hidden="true">
			<span class="fetched-tooltip-title">
				{#if cited}
					<span class="fetched-tooltip-cited">{$t('toolCalls.citedMarker')}</span>
				{/if}
				{source.title}
			</span>
			{#if source.reason}
				<span class="fetched-tooltip-reason">{source.reason}</span>
			{/if}
		</span>
	</a>
{/snippet}

{#snippet fetchedSourceGroup(sources: FetchedSource[], summaryClass: string, kind: "search" | "read")}
	{@const cited = sources.filter(isCitedSource)}
	{@const uncited = uncitedSources(sources)}
	{@const visibleUncited = uncited.slice(0, UNCITED_CHIP_LIMIT)}
	{@const overflowUncited = uncited.slice(UNCITED_CHIP_LIMIT)}
	<details class="fetched-source-group">
		<summary class={summaryClass}>
			<span class="fetched-source-summary">
				<span class="fetched-favicon-stack" aria-hidden="true">
					{#each sources as source}
						{@const faviconUrl = getFaviconUrl(source.url)}
						{#if faviconUrl}
							<img
								class="fetched-favicon-stack-icon"
								src={faviconUrl}
								alt=""
								loading="lazy"
								decoding="async"
								referrerpolicy="no-referrer"
								onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
							/>
						{/if}
					{/each}
				</span>
				<span>{fetchedSourceSummary(sources, kind)}</span>
			</span>
		</summary>
		<div class="fetched-source-chips">
			{#each cited as source}
				{@render fetchedChip(source)}
			{/each}
			{#each visibleUncited as source}
				{@render fetchedChip(source)}
			{/each}
			{#if overflowUncited.length > 0}
				<details class="fetched-chip-more">
					<summary class="fetched-chip-more-summary">{$t('toolCalls.moreSourcesCount', { count: overflowUncited.length })}</summary>
					<div class="fetched-source-chips fetched-source-chips--overflow">
						{#each overflowUncited as source}
							{@render fetchedChip(source)}
						{/each}
					</div>
				</details>
			{/if}
		</div>
	</details>
{/snippet}

{#snippet connectorGroupDetails(tools: ToolCallSegment[], summaryClass: string)}
	<details class="connector-group">
		<summary class={summaryClass}>{connectorGroupSummary(tools[0].name, tools.length)}</summary>
		<div class="connector-action-list">
			{#each tools as tool, i (tool.callId ?? tool.name + JSON.stringify(tool.input) + '-' + i)}
				<div class="connector-action-item">
					{#if tool.status === 'running'}
						<span class="tool-dot-inline"></span>
					{:else}
						<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
					{/if}
					<span class="tool-item-label">{formatGroupedConnectorAction(tool)}</span>
				</div>
			{/each}
		</div>
	</details>
{/snippet}

{#snippet agendaPeek(items: ToolEvidenceCandidate[])}
	<div class="agenda-peek">
		<span class="peek-label">{$t('toolCalls.agendaUpcoming')}</span>
		<ul class="agenda-list">
			{#each items as item (item.id)}
				<li class="agenda-row">
					<span class="agenda-time">{formatEventTime(String(item.metadata?.start ?? ''))}</span>
					<span class="agenda-title">{item.title}</span>
					{#if item.metadata?.location}
						<span class="agenda-location">{item.metadata.location}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

{#snippet photoStrip(items: ToolEvidenceCandidate[])}
	<div class="photo-strip">
		<span class="peek-label">{$t('toolCalls.photos')}</span>
		<div class="photo-strip-row">
			{#each items as item (item.id)}
				{@const thumbUrl = immichThumbnailUrl(item.metadata?.thumbnailPath)}
				{#if thumbUrl}
					{#if item.url}
						<a
							class="photo-strip-link"
							href={item.url}
							target="_blank"
							rel="noopener noreferrer"
						>
							<img
								class="photo-strip-thumb"
								src={thumbUrl}
								alt={item.title}
								loading="lazy"
								decoding="async"
								onerror={hideBrokenThumbnail}
							/>
						</a>
					{:else}
						<img
							class="photo-strip-thumb"
							src={thumbUrl}
							alt={item.title}
							loading="lazy"
							decoding="async"
							onerror={hideBrokenThumbnail}
						/>
					{/if}
				{/if}
			{/each}
		</div>
	</div>
{/snippet}

{#snippet singleToolStackRow(tool: ToolCallSegment)}
	{@const fetchedSources = getFetchedSources(tool)}
	{#if fetchedSources.length > 0}
		<div class="tool-call-row" class:is-running={tool.status === 'running'}>
			{#if tool.status === 'running'}
				<span class="tool-dot"></span>
			{:else}
				<Check class="check-icon-header" size={12} strokeWidth={1.5} aria-hidden="true" />
			{/if}
			{@render fetchedSourceGroup(fetchedSources, 'tool-label-text', 'search')}
		</div>
	{:else if getFetchUrlSources(tool.name, tool.input).length > 0}
		{@const fetchUrlSources = getFetchUrlSources(tool.name, tool.input)}
		<div class="tool-call-row" class:is-running={tool.status === 'running'}>
			{#if tool.status === 'running'}
				<span class="tool-dot"></span>
			{:else}
				<Check class="check-icon-header" size={12} strokeWidth={1.5} aria-hidden="true" />
			{/if}
			{@render fetchedSourceGroup(fetchUrlSources, 'tool-label-text', 'read')}
		</div>
	{:else}
		<div class="tool-call-row" class:is-running={tool.status === 'running'}>
			{#if tool.status === 'running'}
				<span class="tool-dot"></span>
			{:else}
				<Check class="check-icon-header" size={12} strokeWidth={1.5} aria-hidden="true" />
			{/if}
			<span class="tool-label-text" title={getToolTitle(tool.name, tool.input)}>{formatToolCall(tool.name, tool.input)}</span>
		</div>
	{/if}
{/snippet}

{#snippet connectorGroupStackRow(tools: ToolCallSegment[])}
	{@const anyRunning = tools.some((t) => t.status === 'running')}
	<div class="tool-call-row" class:is-running={anyRunning}>
		{#if anyRunning}
			<span class="tool-dot"></span>
		{:else}
			<Check class="check-icon-header" size={12} strokeWidth={1.5} aria-hidden="true" />
		{/if}
		{@render connectorGroupDetails(tools, 'tool-label-text')}
	</div>
	{#if isCalendarToolName(tools[0].name)}
		{@const agendaItems = getAgendaCandidates(tools)}
		{#if agendaItems.length > 0}
			{@render agendaPeek(agendaItems)}
		{/if}
	{:else if isPhotosToolName(tools[0].name)}
		{@const photoItems = getPhotoCandidates(tools)}
		{#if photoItems.length > 0}
			{@render photoStrip(photoItems)}
		{/if}
	{/if}
{/snippet}

{#snippet singleToolItem(seg: ToolCallSegment)}
	{@const fetchedSources = getFetchedSources(seg)}
	{#if fetchedSources.length > 0}
		<div class="tool-call-item">
			{#if seg.status === 'done'}
				<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
			{:else}
				<span class="tool-dot-inline"></span>
			{/if}
			{@render fetchedSourceGroup(fetchedSources, 'tool-item-label', 'search')}
		</div>
	{:else if getFetchUrlSources(seg.name, seg.input).length > 0}
		{@const fetchUrlSources = getFetchUrlSources(seg.name, seg.input)}
		<div class="tool-call-item">
			{#if seg.status === 'done'}
				<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
			{:else}
				<span class="tool-dot-inline"></span>
			{/if}
			{@render fetchedSourceGroup(fetchUrlSources, 'tool-item-label', 'read')}
		</div>
	{:else}
		<div class="tool-call-item">
			{#if seg.status === 'done'}
				<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
			{:else}
				<span class="tool-dot-inline"></span>
			{/if}
			<span class="tool-item-label" title={getToolTitle(seg.name, seg.input)}>{formatToolCall(seg.name, seg.input)}</span>
		</div>
	{/if}
{/snippet}

{#snippet connectorGroupItem(tools: ToolCallSegment[])}
	{@const anyRunning = tools.some((t) => t.status === 'running')}
	<div class="tool-call-item">
		{#if anyRunning}
			<span class="tool-dot-inline"></span>
		{:else}
			<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
		{/if}
		{@render connectorGroupDetails(tools, 'tool-item-label')}
	</div>
{/snippet}

{#if hasVisibleSurface}
<div class="thinking-block" bind:this={container}>
	<button
		type="button"
		class="thinking-header"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<span class="thinking-label" class:is-active={isActiveThinking}>
			{#if isActiveThinking && formattedThinkingTime}
				{formattedThinkingTime} · {$t('chat.thinking')}
			{:else if thinkingIsDone && formattedThinkingTime}
				{$t('chat.thoughtFor', { time: formattedThinkingTime })}
			{:else if thinkingIsDone}
				{$t('chat.thought')}
			{:else}
				{$t('chat.thinking')}
			{/if}
		</span>
		<ChevronDown class={`chevron${expanded ? ' expanded' : ''}`} size={14} strokeWidth={2} aria-hidden="true" />
	</button>

	{#if visibleTools.length > 0 || thinkingIsDone}
		<div class="tool-call-stack" class:fade-out={thinkingIsDone}>
			{#each toolStackEntries as entry (entry.key)}
				{#if entry.kind === 'connector-group'}
					{@render connectorGroupStackRow(entry.tools)}
				{:else}
					{@render singleToolStackRow(entry.tool)}
				{/if}
			{/each}
		</div>
	{/if}

{#if expanded}
<div class="thinking-content" class:content-fresh={contentFresh} transition:slide>
				{#if hasSegments}
				{#each interleavedEntries as entry (entry.key)}
				{#if entry.kind === 'text'}
					<pre class="thinking-text">{formatThinkingTextForDisplay(entry.segment.content)}</pre>
				{:else if entry.kind === 'status'}
					{@const statusSeg = entry.segment as any}
					{@const isDeliberationStatus = isDeliberationStatusSegment(statusSeg)}
					<div
						class="status-step"
						class:status-deliberation={isDeliberationStatus}
						class:is-running={statusSeg.status === 'running'}
						>
								{#if isDeliberationStatus}
										{@const iconType = getDeliberationStatusIconType(statusSeg)}
									{#if iconType === 'search'}
										<Search
											class="deliberation-status-icon"
											data-deliberation-icon="search"
											size={14}
											strokeWidth={2}
											aria-hidden="true"
										/>
									{:else if iconType === 'clipboard-check'}
										<ClipboardCheck
											class="deliberation-status-icon"
											data-deliberation-icon="clipboard-check"
											size={14}
											strokeWidth={2}
											aria-hidden="true"
										/>
									{:else if iconType === 'shield-alert'}
										<ShieldAlert
											class="deliberation-status-icon"
											data-deliberation-icon="shield-alert"
											size={14}
											strokeWidth={2}
											aria-hidden="true"
										/>
									{:else if iconType === 'languages'}
										<Languages
											class="deliberation-status-icon"
											data-deliberation-icon="languages"
											size={14}
											strokeWidth={2}
											aria-hidden="true"
										/>
									{:else if iconType === 'layers'}
										<Layers
											class="deliberation-status-icon"
											data-deliberation-icon="layers"
											size={14}
											strokeWidth={2}
											aria-hidden="true"
										/>
									{:else}
										<Bot
											class="deliberation-status-icon"
											data-deliberation-icon="bot"
											size={14}
											strokeWidth={2}
											aria-hidden="true"
										/>
									{/if}
									{:else if statusSeg.status === 'running'}
										<span class="tool-dot-inline"></span>
								{:else}
					<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
									{/if}
									<span class="status-step-label">{isDeliberationStatus ? formatDeliberationStatusLabel(statusSeg) : statusSeg.label}</span>
								</div>
					{:else if entry.kind === 'tool'}
						{@render singleToolItem(entry.segment)}
					{:else}
						{@render connectorGroupItem(entry.tools)}
					{/if}
				{/each}
		{:else}
			<pre class="thinking-text">
				{#if isActiveThinking && newCharStart > 0 && newCharStart < content.length}
					{@const formattedContent = formatThinkingTextForDisplay(content)}
					{@const formattedNewCharStart = getFormattedFreshStart(content, newCharStart)}
					{formattedContent.slice(0, formattedNewCharStart)}<span class="word-new">{formattedContent.slice(formattedNewCharStart)}</span>
				{:else}
					{formatThinkingTextForDisplay(content)}
				{/if}
			</pre>
		{/if}
		</div>
	{/if}
</div>
{/if}

<style>
	.thinking-block {
		margin-bottom: var(--space-md);
		width: 100%;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
	}

	.thinking-header {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-xs) 0;
		background: transparent;
		border: none;
		cursor: pointer;
		max-width: 100%;
		width: 100%;
		min-width: 0;
	}

	.thinking-header:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.thinking-label {
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 500;
		color: var(--text-muted);
	}

	@keyframes thinking-sweep {
		0%   { background-position: 250% center; }
		100% { background-position: -250% center; }
	}

	.thinking-label.is-active {
		background: linear-gradient(
			90deg,
			var(--text-muted)    0%,
			var(--text-muted)    35%,
			var(--accent)        47%,
			var(--text-primary)  50%,
			var(--accent)        53%,
			var(--text-muted)    65%,
			var(--text-muted)    100%
		);
		background-size: 500% 100%;
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
		-webkit-text-fill-color: transparent;
		animation: thinking-sweep 6s linear infinite;
	}

	.chevron {
		color: var(--icon-muted);
		transition: transform var(--duration-standard) var(--ease-out);
		flex-shrink: 0;
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	/* Tool call stack — accumulates all tool rows, visible without expanding */
	.tool-call-stack {
		padding: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
		transition: opacity 400ms var(--ease-out), max-height 400ms var(--ease-out);
		max-height: 999px;
		overflow: hidden;
	}

	.tool-call-stack.fade-out {
		opacity: 0;
		max-height: 0;
		padding: 0;
		pointer-events: none;
	}

	.tool-call-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: 3px 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		width: 100%;
		min-width: 0;
	}

	.tool-call-row.is-running {
		color: var(--text-secondary);
	}

	.tool-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		animation: tool-pulse 1.5s ease-in-out infinite;
	}

	@keyframes tool-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	.tool-label-text {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.fetched-source-group {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.fetched-source-group summary {
		cursor: pointer;
		list-style-position: inside;
	}

	.fetched-source-summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		vertical-align: middle;
	}

	.fetched-favicon-stack {
		display: inline-flex;
		align-items: center;
		flex: 0 1 auto;
		min-width: 0;
		max-width: min(260px, 45vw);
		overflow: hidden;
		padding: 1px 0 1px 1px;
	}

	.fetched-favicon-stack-icon {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid var(--surface-elevated);
		background: var(--surface-elevated);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-default) 55%, transparent);
		flex: 0 0 auto;
		object-fit: cover;
	}

	.fetched-favicon-stack-icon + .fetched-favicon-stack-icon {
		margin-left: -5px;
	}

	.fetched-favicon {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid var(--surface-elevated);
		background: var(--surface-elevated);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-default) 55%, transparent);
		flex: 0 0 auto;
		object-fit: cover;
	}

	/* Compact cited-first chip row: reuses the 14px favicon circle tokens from
	   the collapsed stack, wrapping into a tidy grid instead of the old
	   full-width vertical link list. */
	.fetched-source-chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
		padding-left: 16px;
	}

	.fetched-source-chips--overflow {
		margin-top: 6px;
		padding-left: 0;
	}

	.fetched-source-chip {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.fetched-source-chip .fetched-favicon {
		width: 14px;
		height: 14px;
	}

	/* Cited chips lead and carry a subtle accent ring so the answer's actual
	   citations read as primary; uncited ("also found") chips sit dimmed. */
	.fetched-source-chip.is-cited {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.fetched-source-chip.is-uncited {
		opacity: 0.55;
	}

	.fetched-source-chip.is-uncited:hover,
	.fetched-source-chip.is-uncited:focus-visible {
		opacity: 1;
	}

	.fetched-source-chip:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.fetched-chip-cited-dot {
		position: absolute;
		right: -1px;
		bottom: -1px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		border: 1px solid var(--surface-page);
	}

	/* Hover/focus tooltip: favicon-adjacent card with title (line 1) + compact
	   reason (line 2). Absolutely positioned within the chip (never fixed), so
	   it never leaks out of the thinking block's own scroll context. */
	.fetched-source-tooltip {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		display: none;
		flex-direction: column;
		gap: 2px;
		width: max-content;
		max-width: min(260px, 60vw);
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		border: 1px solid var(--border-default);
		box-shadow: 0 4px 14px color-mix(in srgb, var(--shadow-color, #000) 18%, transparent);
		font-family: var(--font-sans);
		text-align: left;
		pointer-events: none;
	}

	.fetched-source-chip:hover .fetched-source-tooltip,
	.fetched-source-chip:focus-visible .fetched-source-tooltip {
		display: flex;
	}

	.fetched-tooltip-title {
		font-size: var(--text-xs, 0.75rem);
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.fetched-tooltip-cited {
		display: inline-block;
		margin-right: 4px;
		padding: 0 5px;
		border-radius: 9999px;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.fetched-tooltip-reason {
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.fetched-chip-more {
		flex: 0 0 auto;
	}

	.fetched-chip-more-summary {
		cursor: pointer;
		list-style: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 22px;
		padding: 0 6px;
		border-radius: 9999px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-default);
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		color: var(--text-muted);
	}

	.fetched-chip-more-summary::-webkit-details-marker {
		display: none;
	}

	.connector-group {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.connector-group summary {
		cursor: pointer;
		list-style-position: inside;
	}

	.connector-action-list {
		display: grid;
		gap: 4px;
		margin-top: 4px;
		padding-left: 16px;
	}

	.connector-action-item {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.check-icon-header {
		color: var(--success);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	/* Agenda peek + photo strip (Task 11b) — subtle, tasteful peeks rendered
	   alongside the connector group's stack row, visible without expanding. */
	.agenda-peek,
	.photo-strip {
		margin: 4px 0 2px;
		padding-left: 16px;
	}

	.peek-label {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--text-xs, 0.75rem);
		font-weight: 500;
		color: var(--text-muted);
		margin-bottom: 4px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.agenda-list {
		display: grid;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.agenda-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 6px;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-secondary);
		min-width: 0;
	}

	.agenda-time {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.agenda-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.agenda-location {
		flex: 0 1 auto;
		min-width: 0;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.agenda-location::before {
		content: "· ";
	}

	.photo-strip-row {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding-bottom: 2px;
	}

	.photo-strip-link {
		flex: 0 0 auto;
		display: block;
		line-height: 0;
	}

	.photo-strip-thumb {
		width: 48px;
		height: 48px;
		flex: 0 0 auto;
		border-radius: 6px;
		object-fit: cover;
		border: 1px solid var(--border-default);
		background: var(--surface-elevated);
	}

	.thinking-content {
		padding: var(--space-sm) 0 var(--space-sm);
		width: 100%;
		min-width: 0;
}

.word-new {
animation: wordFadeIn 300ms ease-out forwards;
}

@keyframes wordFadeIn {
from { opacity: 0; transform: translateY(2px); }
to   { opacity: 1; transform: translateY(0); }
}

@keyframes thinkContentFadeIn {
from { opacity: 0.5; }
to   { opacity: 1; }
}

	@keyframes deliberationStatusFade {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.thinking-content.content-fresh {
animation: thinkContentFadeIn 300ms ease-out;
}

	.thinking-text {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 1.5;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Inline tool call rows between thinking text segments */
	.tool-call-item {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
	}

	.status-step {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		margin: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
	}

	.status-step.is-running {
		color: var(--text-secondary);
	}

	.status-step-label {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.status-step.status-deliberation {
		font-size: var(--text-sm);
		font-weight: 600;
		animation: deliberationStatusFade 220ms var(--ease-out) both;
	}

	:global(.deliberation-status-icon) {
		color: currentColor;
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}

	.tool-dot-inline {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		opacity: 0.6;
		animation: tool-pulse 1.5s ease-in-out infinite;
	}

	.tool-item-label {
		flex: 1 1 auto;
		min-width: 0;
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.check-icon {
		color: var(--success);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

@media (prefers-reduced-motion: reduce) {
	.thinking-label.is-active {
		color: var(--text-muted);
		-webkit-text-fill-color: var(--text-muted);
		background: none;
		animation: none;
	}

	.chevron {
		transition: none;
	}

	.tool-dot,
	.tool-dot-inline {
		animation: none;
		opacity: 0.7;
	}

	.thinking-content.content-fresh {
		animation: none;
		opacity: 1;
	}

	.word-new {
		animation: none;
		opacity: 1;
	}
}
</style>
