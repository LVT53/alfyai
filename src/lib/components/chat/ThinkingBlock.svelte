<script lang="ts">
import { t } from "$lib/i18n";
import type { ThinkingSegment } from "$lib/types";
import {
	getHumanReadableToolNameKey,
	isFileProductionToolName,
	isVisibleThinkingSegment,
	isVisibleThinkingToolCall,
} from "$lib/utils/tool-calls";

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
let thinkingSeconds = $state(0);
let thinkingTimerInterval: ReturnType<typeof setInterval> | undefined;

const isActiveThinking = $derived(!thinkingIsDone);
const visibleSegmentsRaw = $derived(segments.filter(isVisibleThinkingSegment));

function isDeliberationStatusSegment(segment: ThinkingSegment): boolean {
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
	segmentId: string,
): "search" | "file" | "check" {
	const pass = getDeliberationPassIndex(segmentId);
	if (pass === 1) return "search";
	if (pass === 2) return "file";
	return "check";
}

const latestDeliberationStatusSegment = $derived.by(() => {
	for (let i = visibleSegmentsRaw.length - 1; i >= 0; i -= 1) {
		if (isDeliberationStatusSegment(visibleSegmentsRaw[i])) {
			return visibleSegmentsRaw[i];
		}
	}
	return undefined;
});

const visibleSegments = $derived(
	streaming
		? visibleSegmentsRaw.filter((segment) => {
				if (!isDeliberationStatusSegment(segment)) return true;
				return latestDeliberationStatusSegment
					? segment.id === latestDeliberationStatusSegment.id
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

function getFetchedSources(
	segment: ThinkingSegment,
): Array<{ title: string; url: string }> {
	if (segment.type !== "tool_call" || segment.name !== "research_web")
		return [];
	return (segment.candidates ?? [])
		.filter((candidate) => candidate.sourceType === "web" && candidate.url)
		.slice(0, 6)
		.map((candidate) => ({
			title: candidate.title || extractHostname(candidate.url ?? ""),
			url: candidate.url as string,
		}));
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
		<svg
			class="chevron"
			class:expanded
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	</button>

	{#if visibleTools.length > 0 || thinkingIsDone}
		<div class="tool-call-stack" class:fade-out={thinkingIsDone}>
			{#each visibleTools as tool, i (tool.callId ?? tool.name + JSON.stringify(tool.input) + '-' + i)}
				{@const fetchedSources = getFetchedSources(tool)}
				{#if fetchedSources.length > 0}
					{#each fetchedSources as source}
						<div class="tool-call-row" class:is-running={tool.status === 'running'}>
							{#if tool.status === 'running'}
								<span class="tool-dot"></span>
							{:else}
								<svg class="check-icon-header" viewBox="0 0 12 12" fill="none">
									<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
										stroke-linecap="round" stroke-linejoin="round"/>
								</svg>
							{/if}
							<span class="tool-label-text">
								Fetched:
								<a
									class="tool-link"
									href={source.url}
									target="_blank"
									rel="noopener noreferrer"
									onclick={(event) => event.stopPropagation()}>{source.title}</a>
							</span>
						</div>
					{/each}
				{:else if getFetchUrls(tool.name, tool.input).length > 0}
					{#each getFetchUrls(tool.name, tool.input) as url}
						<div class="tool-call-row" class:is-running={tool.status === 'running'}>
							{#if tool.status === 'running'}
								<span class="tool-dot"></span>
							{:else}
								<svg class="check-icon-header" viewBox="0 0 12 12" fill="none">
									<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
									stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
						{/if}
							<span class="tool-label-text">{$t('toolCalls.fetchPage')}: <a class="tool-link" href={url} target="_blank" rel="noopener noreferrer" onclick={(event) => event.stopPropagation()}>{extractHostname(url)}</a></span>
						</div>
					{/each}
				{:else}
					<div class="tool-call-row" class:is-running={tool.status === 'running'}>
						{#if tool.status === 'running'}
							<span class="tool-dot"></span>
						{:else}
							<svg class="check-icon-header" viewBox="0 0 12 12" fill="none">
								<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
									stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
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
						{@const isDeliberationStatus = isDeliberationStatusSegment(seg)}
						<div
							class="status-step"
							class:status-deliberation={isDeliberationStatus}
							class:is-running={seg.status === 'running'}
						>
							{#if isDeliberationStatus}
								{@const iconType = getDeliberationStatusIconType(seg.id)}
								{#if iconType === 'search'}
									<svg
										class="deliberation-status-icon"
										data-deliberation-icon="search"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<circle cx="10.5" cy="10.5" r="7.5" />
										<path d="m20.5 20.5-4.35-4.35" />
									</svg>
								{:else if iconType === 'file'}
									<svg
										class="deliberation-status-icon"
										data-deliberation-icon="file"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="M4 4h10l5 5v13H4Z" />
										<path d="m14 4 5 5h-5Z" />
										<path d="M7 11h9" />
										<path d="M7 15h9" />
									</svg>
								{:else}
									<svg
										class="deliberation-status-icon"
										data-deliberation-icon="check"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<circle cx="12" cy="12" r="9" />
										<path d="M8 12l2.5 2.5 5-5" />
									</svg>
								{/if}
							{:else if seg.status === 'running'}
								<span class="tool-dot-inline"></span>
							{:else}
								<svg class="check-icon" viewBox="0 0 12 12" fill="none">
									<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
										stroke-linecap="round" stroke-linejoin="round"/>
								</svg>
							{/if}
							<span class="status-step-label">{seg.label}</span>
						</div>
					{:else}
						{@const fetchedSources = getFetchedSources(seg)}
						{#if fetchedSources.length > 0}
							{#each fetchedSources as source}
								<div class="tool-call-item">
									{#if seg.status === 'done'}
										<svg class="check-icon" viewBox="0 0 12 12" fill="none">
											<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
												stroke-linecap="round" stroke-linejoin="round"/>
										</svg>
									{:else}
										<span class="tool-dot-inline"></span>
									{/if}
									<span class="tool-item-label">
										Fetched:
										<a
											class="tool-link"
											href={source.url}
											target="_blank"
											rel="noopener noreferrer">{source.title}</a>
									</span>
								</div>
							{/each}
						{:else if getFetchUrls(seg.name, seg.input).length > 0}
							{#each getFetchUrls(seg.name, seg.input) as url}
								<div class="tool-call-item">
									{#if seg.status === 'done'}
										<svg class="check-icon" viewBox="0 0 12 12" fill="none">
											<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
												stroke-linecap="round" stroke-linejoin="round"/>
										</svg>
									{:else}
										<span class="tool-dot-inline"></span>
									{/if}
									<span class="tool-item-label">{$t('toolCalls.fetchPage')}: <a class="tool-link" href={url} target="_blank" rel="noopener noreferrer">{extractHostname(url)}</a></span>
								</div>
							{/each}
						{:else}
							<div class="tool-call-item">
								{#if seg.status === 'done'}
									<svg class="check-icon" viewBox="0 0 12 12" fill="none">
										<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5"
											stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 14px;
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 12px;
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
animation: wordFadeIn 200ms ease-out forwards;
}

@keyframes wordFadeIn {
from { opacity: 0.3; }
to   { opacity: 1; }
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 13px;
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
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 12px;
		color: var(--text-muted);
		margin: var(--space-xs) 0;
		width: 100%;
		min-width: 0;
	}

	.status-step {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 12px;
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
		font-size: 14px;
		font-weight: 600;
		animation: deliberationStatusFade 220ms var(--ease-out) both;
	}

	.deliberation-status-icon {
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
