<script lang="ts">
import { t } from "$lib/i18n";
import type { ThinkingSegment } from "$lib/types";
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

function getFetchedSources(segment: ThinkingSegment): FetchedSource[] {
	if (segment.type !== "tool_call" || segment.name !== "research_web")
		return [];
	return dedupeSourcesByUrl(
		(segment.candidates ?? [])
			.filter((candidate) => candidate.sourceType === "web" && candidate.url)
			.map((candidate) => ({
				title: candidate.title || extractHostname(candidate.url ?? ""),
				url: candidate.url as string,
			})),
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

function fetchedSourceSummary(sources: FetchedSource[]): string {
	const count = sources.length;
	const label =
		count === 1 ? $t("toolCalls.fetchedSite") : $t("toolCalls.fetchedSites");
	return `${$t("toolCalls.fetched")}: ${count} ${label}`;
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

{#snippet fetchedSourceGroup(sources: FetchedSource[], summaryClass: string)}
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
				<span>{fetchedSourceSummary(sources)}</span>
			</span>
		</summary>
		<div class="fetched-source-list">
			{#each sources as source}
				{@const faviconUrl = getFaviconUrl(source.url)}
				<div class="fetched-source-item">
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
					<a
						class="tool-link fetched-source-link"
						href={source.url}
						target="_blank"
						rel="noopener noreferrer">{source.title}</a>
				</div>
			{/each}
		</div>
	</details>
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
			{#each visibleTools as tool, i (tool.callId ?? tool.name + JSON.stringify(tool.input) + '-' + i)}
				{@const fetchedSources = getFetchedSources(tool)}
				{#if fetchedSources.length > 0}
					<div class="tool-call-row" class:is-running={tool.status === 'running'}>
						{#if tool.status === 'running'}
							<span class="tool-dot"></span>
							{:else}
								<Check class="check-icon-header" size={12} strokeWidth={1.5} aria-hidden="true" />
						{/if}
							{@render fetchedSourceGroup(fetchedSources, 'tool-label-text')}
						</div>
					{:else if getFetchUrlSources(tool.name, tool.input).length > 0}
						{@const fetchUrlSources = getFetchUrlSources(tool.name, tool.input)}
					<div class="tool-call-row" class:is-running={tool.status === 'running'}>
						{#if tool.status === 'running'}
							<span class="tool-dot"></span>
						{:else}
							<Check class="check-icon-header" size={12} strokeWidth={1.5} aria-hidden="true" />
						{/if}
							{@render fetchedSourceGroup(fetchUrlSources, 'tool-label-text')}
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
			{/each}
		</div>
	{/if}

{#if expanded}
<div class="thinking-content" class:content-fresh={contentFresh} transition:slide>
				{#if hasSegments}
				{#each visibleSegments as seg, i (seg.type === 'tool_call' ? (seg.callId ?? seg.name + JSON.stringify(seg.input) + '-' + i) : seg.type === 'status' ? seg.id : `text-${i}`)}
				{#if seg.type === 'text'}
					<pre class="thinking-text">{formatThinkingTextForDisplay(seg.content)}</pre>
				{:else if seg.type === 'status'}
					{@const statusSeg = seg as any}
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
					{:else}
						{@const fetchedSources = getFetchedSources(seg)}
						{#if fetchedSources.length > 0}
							<div class="tool-call-item">
								{#if seg.status === 'done'}
									<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
								{:else}
									<span class="tool-dot-inline"></span>
								{/if}
								{@render fetchedSourceGroup(fetchedSources, 'tool-item-label')}
							</div>
						{:else if getFetchUrlSources(seg.name, seg.input).length > 0}
							{@const fetchUrlSources = getFetchUrlSources(seg.name, seg.input)}
							<div class="tool-call-item">
								{#if seg.status === 'done'}
									<Check class="check-icon" size={12} strokeWidth={1.5} aria-hidden="true" />
								{:else}
									<span class="tool-dot-inline"></span>
								{/if}
								{@render fetchedSourceGroup(fetchUrlSources, 'tool-item-label')}
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

	.fetched-source-item {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
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

	.fetched-source-list {
		display: grid;
		gap: 4px;
		margin-top: 4px;
		padding-left: 16px;
	}

	.fetched-source-link {
		display: block;
		width: fit-content;
		max-width: 100%;
	}

	.tool-link {
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.tool-link:hover {
		text-decoration-color: currentColor;
	}

	.check-icon-header {
		color: var(--success);
		width: 12px;
		height: 12px;
		flex-shrink: 0;
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
