<script lang="ts">
	import type { ThinkingSegment } from '$lib/types';
	import {
		isFileProductionToolName,
		isVisibleThinkingSegment,
		isVisibleThinkingToolCall,
	} from '$lib/utils/tool-calls';

	let {
		content = '',
		thinkingIsDone = false,
		segments = []
	}: {
		content?: string;
		thinkingIsDone?: boolean;
		segments?: ThinkingSegment[];
	} = $props();

let expanded = $state(false);
let container = $state<HTMLDivElement | undefined>(undefined);
let prevContentLength = $state(0);
let contentFresh = $state(false);
let newCharStart = $state(-1);
let freshTimeout: ReturnType<typeof setTimeout> | undefined;

	const label = $derived(thinkingIsDone ? 'Thought' : 'Thinking');
const isActiveThinking = $derived(!thinkingIsDone);
const visibleSegments = $derived(segments.filter(isVisibleThinkingSegment));
const hasSegments = $derived(visibleSegments.length > 0);
const visibleTools = $derived(segments.filter(isVisibleThinkingToolCall));

$effect(() => {
const totalLength = hasSegments
? visibleSegments.reduce((sum, s) => sum + (s.type === 'text' ? s.content.length : 0), 0)
: content.length;
if (totalLength > prevContentLength && isActiveThinking) {
contentFresh = true;
newCharStart = prevContentLength;
clearTimeout(freshTimeout);
freshTimeout = setTimeout(() => { contentFresh = false; }, 500);
}
prevContentLength = totalLength;
});

	function extractHostname(raw: string): string {
		try {
			return new URL(raw).hostname.replace(/^www\./, '');
		} catch {
			return raw.slice(0, 40);
		}
	}

	function isFetchTool(name: string): boolean {
		const n = name.toLowerCase();
		return n.includes('fetch') || n.includes('url') || n.includes('web') || n.includes('browse');
	}

	function toUrlList(value: unknown): string[] {
		return String(value ?? '')
			.split(',')
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

	function formatToolCall(name: string, input: Record<string, unknown>): string {
		const n = name.toLowerCase();
		const firstVal = () => String(Object.values(input)[0] ?? '').slice(0, 200);
		if (isFileProductionToolName(name)) {
			return 'produce_file';
		}
		if (n.includes('search') || n.includes('tavily')) {
			const q = input.query ?? input.q ?? Object.values(input)[0];
			return `Searching: "${String(q ?? '').slice(0, 200)}"`;
		}
		if (isFetchTool(name)) {
			const raw = String(Object.values(input)[0] ?? '');
			return `Fetching: ${extractHostname(raw)}`;
		}
		return firstVal() ? `${name}: ${firstVal()}` : name;
	}

	function getToolTitle(name: string, input: Record<string, unknown>): string {
		const n = name.toLowerCase();
		if (n.includes('search') || n.includes('tavily')) {
			const q = input.query ?? input.q ?? Object.values(input)[0];
			return String(q ?? '');
		}
		if (isFileProductionToolName(name)) {
			const title = input.requestTitle ?? input.filename ?? input.documentIntent;
			return title ? String(title) : 'produce_file';
		}
		if (isFetchTool(name)) {
			return String(Object.values(input)[0] ?? '');
		}
		return String(Object.values(input)[0] ?? '');
	}

	async function toggle() {
		await preserveScrollOnToggle(container, expanded, () => { expanded = !expanded; });
	}
</script>

<script module>
	import { slide } from 'svelte/transition';
	import { preserveScrollOnToggle } from '$lib/actions/preserve-scroll';
</script>

<div class="thinking-block" bind:this={container}>
	<button
		type="button"
		class="thinking-header"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<span class="thinking-label" class:is-active={isActiveThinking}>{label}</span>
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

	{#if visibleTools.length > 0}
		<div class="tool-call-stack">
			{#each visibleTools as tool, i (tool.name + JSON.stringify(tool.input) + '-' + i)}
				{#if getFetchUrls(tool.name, tool.input).length > 0}
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
							<span class="tool-label-text">Fetching: <a class="tool-link" href={url} target="_blank" rel="noopener noreferrer" onclick={(event) => event.stopPropagation()}>{extractHostname(url)}</a></span>
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
				{#each visibleSegments as seg}
					{#if seg.type === 'text'}
						<pre class="thinking-text">{seg.content}</pre>
					{:else}
						{#if getFetchUrls(seg.name, seg.input).length > 0}
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
									<span class="tool-item-label">Fetching: <a class="tool-link" href={url} target="_blank" rel="noopener noreferrer">{extractHostname(url)}</a></span>
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
					{content.slice(0, newCharStart)}<span class="word-new">{content.slice(newCharStart)}</span>
				{:else}
					{content}
				{/if}
			</pre>
		{/if}
		</div>
	{/if}
</div>

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
		0%   { background-position: 200% center; }
		100% { background-position: -200% center; }
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
		animation: thinking-sweep 4s linear infinite;
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
