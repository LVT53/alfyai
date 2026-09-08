<script lang="ts">
// One unified tool activity row — the single shape EVERY tool call renders
// as, everywhere: the live stack while the model is thinking, the expanded
// thinking rail, and a pinned deliverable under the collapsed summary strip.
// It replaces the old pill family (.tool-call-row / .thought-rail-chip /
// .tool-call-item) and the standalone MapRouteCard / FileProductionCard
// shells.
//
// Anatomy (approved mockup):
//   [status 14px] [tool icon 14px] verb  object …………………… meta  [chevron]
//
// Only rows with something to show carry a chevron, and only those render as
// a <button> — a row with no body must never look clickable. Opening joins
// the row and its body into one soft block on --surface-elevated (the row's
// bottom corners square off, the body's top corners do too), and the body
// slides open AND closed with the app's standard reduced-motion-aware
// transition.
import { Check, ChevronDown, LoaderCircle, X } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import {
	extractHostname,
	getFaviconUrl,
	isCitedSource,
} from "$lib/utils/tool-evidence-presentation";
import type { ToolActivityItem } from "$lib/utils/tool-activity";
import ToolActivityIcon from "./ToolActivityIcon.svelte";

let {
	item,
	open = false,
	onToggle = undefined,
	job = undefined,
	onOpenDocument = undefined,
	onRetryJob = undefined,
	onCancelJob = undefined,
	onDismissJob = undefined,
}: {
	item: ToolActivityItem;
	open?: boolean;
	onToggle?: ((key: string) => void) | undefined;
	job?: FileProductionJob | undefined;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetryJob?: ((jobId: string) => void) | undefined;
	onCancelJob?: ((jobId: string) => void) | undefined;
	onDismissJob?: ((jobId: string) => void) | undefined;
} = $props();

// The mockup's "no chevron yet" on a running row falls out of the data rather
// than being forced here: a call that has not returned anything has no body to
// reveal (see `buildToolActivityItem`), so it gets no chevron. A running call
// that DOES already carry something real — the URLs a read was given, the
// actions a connector group has already completed — keeps its disclosure.
const hasBody = $derived(item.body !== null);
// A file job that is still producing is pinned open: the owner's note is that
// the row must carry the body's background so the two read as one element.
const isOpen = $derived(hasBody && (item.alwaysOpen || open));
const isInteractive = $derived(hasBody && !item.alwaysOpen);

// The map body's MapLibre component is dynamic-imported the same way
// MessageBubble used to lazy-load MapRouteCard — the library never touches
// the entry chat bundle for a turn with no route.
let MapRouteBody = $state<
	typeof import("./MapRouteCard.svelte").default | null
>(null);
$effect(() => {
	if (item.body?.kind === "map" && isOpen && !MapRouteBody) {
		void import("./MapRouteCard.svelte").then((module) => {
			MapRouteBody = module.default;
		});
	}
});

let FileProductionBody = $state<
	typeof import("./FileProductionCard.svelte").default | null
>(null);
$effect(() => {
	if (item.body?.kind === "file-job" && isOpen && !FileProductionBody) {
		void import("./FileProductionCard.svelte").then((module) => {
			FileProductionBody = module.default;
		});
	}
});

function handleToggle() {
	if (!isInteractive) return;
	onToggle?.(item.key);
}
</script>

<script module>
	import { slide } from 'svelte/transition';
	import { reducedMotionAware } from '$lib/utils/motion';

	// The app's standard disclosure motion (200ms height slide), wrapped so
	// prefers-reduced-motion collapses it to zero without repeating the check
	// at each call site. Applied as `transition:` (not `in:`) so closing is
	// exactly as smooth as opening — the owner asked for both.
	const slideTransition = reducedMotionAware(slide);
</script>

{#snippet statusGlyph(status: 'running' | 'done' | 'failed')}
	<span class="act-status" class:running={status === 'running'} class:failed={status === 'failed'} aria-hidden="true">
		{#if status === 'running'}
			<LoaderCircle size={14} strokeWidth={2.4} aria-hidden="true" />
		{:else if status === 'failed'}
			<X size={13} strokeWidth={2.2} aria-hidden="true" />
		{:else}
			<Check size={13} strokeWidth={2.2} aria-hidden="true" />
		{/if}
	</span>
{/snippet}

{#snippet rowContents()}
	{@render statusGlyph(item.status)}
	<ToolActivityIcon iconType={item.iconType} />
	<span class="act-label">
		<span class="act-verb">{item.verb}</span>
		{#if item.object}
			<span class="act-object">{item.object}</span>
		{/if}
	</span>
	{#if item.meta}
		<span class="act-meta">{item.meta}</span>
	{/if}
	{#if isInteractive}
		<ChevronDown class="act-chevron" size={14} strokeWidth={2} aria-hidden="true" />
	{/if}
{/snippet}

{#snippet sourceRow(source: { title: string; url: string; status?: string; reason?: string })}
	{@const faviconUrl = getFaviconUrl(source.url)}
	{@const cited = isCitedSource(source as never)}
	{@const reason = source.reason?.trim()}
	{@const host = extractHostname(source.url)}
	<a
		class="act-src"
		class:is-cited={cited}
		href={source.url}
		target="_blank"
		rel="noopener noreferrer"
		title={source.reason ?? source.title}
	>
		<span class="act-favicon" aria-hidden="true">
			{#if faviconUrl}
				<img
					src={faviconUrl}
					alt=""
					loading="lazy"
					decoding="async"
					referrerpolicy="no-referrer"
					onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
				/>
			{/if}
		</span>
		<span class="act-src-title">{source.title}</span>
		{#if host && host !== source.title}
			<span class="act-src-host">{host}</span>
		{/if}
		{#if cited}
			<Check class="act-src-cited" size={12} strokeWidth={2.2} aria-hidden="true" />
		{/if}
		{#if reason}
			<span class="act-src-popover" role="tooltip" aria-hidden="true">
				<span class="act-src-popover-title">{source.title}</span>
				<span class="act-src-popover-reason">{reason}</span>
			</span>
		{/if}
	</a>
{/snippet}

<div class="act-entry" data-activity-key={item.key}>
	{#if isInteractive}
		<button
			type="button"
			class="act-row"
			class:is-open={isOpen}
			class:is-running={item.status === 'running'}
			class:is-failed={item.status === 'failed'}
			data-testid="tool-activity-row"
			data-status={item.status}
			data-icon-type={item.iconType}
			title={item.title}
			aria-expanded={isOpen}
			aria-label={`${item.verb} ${item.object}`.trim()}
			onclick={handleToggle}
		>
			{@render rowContents()}
		</button>
	{:else}
		<div
			class="act-row"
			class:is-open={isOpen}
			class:is-running={item.status === 'running'}
			class:is-failed={item.status === 'failed'}
			data-testid="tool-activity-row"
			data-status={item.status}
			data-icon-type={item.iconType}
			title={item.title}
		>
			{@render rowContents()}
		</div>
	{/if}

	{#if isOpen && item.body}
		{@const body = item.body}
		<div class="act-body" data-testid="tool-activity-body" transition:slideTransition={{ duration: 200 }}>
			{#if body.kind === 'sources'}
				<div class="act-eyebrow">
					{$t('toolActivity.sourcesEyebrow')}
					{#if body.citedCount > 0}
						· {$t('toolCalls.citedCount', { count: body.citedCount })}
					{/if}
				</div>
				{#each body.sources as source (source.url)}
					{@render sourceRow(source)}
				{/each}
			{:else if body.kind === 'page'}
				{#each body.sources as source (source.url)}
					{@render sourceRow(source)}
				{/each}
				{#if body.excerpt}
					<div class="act-excerpt">{body.excerpt}</div>
				{/if}
			{:else if body.kind === 'python'}
				<div class="act-eyebrow">{$t('toolActivity.program')}</div>
				<pre class="act-code">{body.program}</pre>
				{#if body.output}
					<div class="act-eyebrow">{$t('toolActivity.output')}</div>
					<pre class="act-code">{body.output}</pre>
				{/if}
			{:else if body.kind === 'map'}
				<div class="act-map-summary">{body.summary}</div>
				<!-- Public transport: the itinerary (or the next departures) reads
				     ABOVE the map, because the times and line names are the answer
				     and the drawn line is only context. -->
				{#if body.map.transitLegs?.length}
					<ol class="act-transit" data-testid="transit-legs">
						{#each body.map.transitLegs as leg, index (index)}
							<li class="act-transit-leg">
								<span class="act-transit-time">
									{leg.depart ?? ''}{leg.arrive ? `–${leg.arrive}` : ''}
								</span>
								{#if leg.type === 'pt'}
									<span class="act-transit-line">{leg.line ?? leg.vehicle ?? ''}</span>
								{:else}
									<span class="act-transit-walk">{$t('toolActivity.transitWalk')}</span>
								{/if}
								<span class="act-transit-where">
									{[leg.from, leg.to].filter(Boolean).join(' → ')}
									{#if leg.headsign}<span class="act-transit-headsign">{leg.headsign}</span>{/if}
								</span>
								<span class="act-transit-meta">
									{leg.stops !== undefined
										? `${$t('toolActivity.transitStops', { count: leg.stops })} · ${leg.minutes} min`
										: `${leg.minutes} min`}
								</span>
							</li>
						{/each}
					</ol>
				{:else if body.map.departures?.length}
					<ol class="act-transit" data-testid="transit-departures">
						{#each body.map.departures as departure, index (index)}
							<li class="act-transit-leg">
								<span class="act-transit-time">
									{departure.depart ?? ''}{departure.arrive ? `–${departure.arrive}` : ''}
								</span>
								{#if departure.line}
									<span class="act-transit-line">{departure.line}</span>
								{/if}
								<span class="act-transit-meta">
									{departure.minutes} min · {$t('toolActivity.transfersCount', {
										count: departure.transfers,
									})}
								</span>
							</li>
						{/each}
					</ol>
				{/if}
				{#if MapRouteBody}
					<MapRouteBody map={body.map} />
				{/if}
			{:else if body.kind === 'file-job'}
				{#if job && FileProductionBody}
					<FileProductionBody
						{job}
						{onOpenDocument}
						onRetry={onRetryJob}
						onCancel={onCancelJob}
						onDismiss={onDismissJob}
					/>
				{/if}
			{:else if body.kind === 'text'}
				<div class="act-excerpt">{body.text}</div>
			{:else if body.kind === 'bullets'}
				<ul class="act-bullets">
					{#each body.items as bullet, index (index)}
						<li>{bullet}</li>
					{/each}
				</ul>
			{:else if body.kind === 'actions'}
				{#each body.actions as action (action.key)}
					<div class="act-action-row" data-testid="tool-activity-action">
						{@render statusGlyph(action.status)}
						<span class="act-src-title">{action.label}</span>
					</div>
				{/each}
			{:else if body.kind === 'error'}
				<div class="act-error" data-testid="tool-activity-error">{body.reason}</div>
			{:else if body.kind === 'generic'}
				{#if body.args.length > 0}
					<div class="act-eyebrow">{$t('toolCalls.detailArguments')}</div>
					{#each body.args as arg (arg.key)}
						<div class="act-kv">
							<span class="act-kv-key">{arg.key}</span>
							<span class="act-kv-value">{arg.value}</span>
						</div>
					{/each}
				{/if}
				{#if body.result}
					<div class="act-eyebrow">{$t('toolCalls.detailResult')}</div>
					<div class="act-excerpt">{body.result}</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Both the entry and the body below stay explicitly un-clipped: the source
	   popover is absolutely positioned inside the body and hangs past its
	   bottom edge, so an `overflow: hidden` anywhere up this chain would trap
	   it. (.thinking-block above already carries the same note.) */
	.act-entry {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
		overflow: visible;
	}

	/* The row's -8px horizontal margin pulls its hover wash out past the text
	   column so the label still lines up with the thinking header above it. */
	.act-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: calc(100% + 16px);
		min-width: 0;
		min-height: 28px;
		margin: 0 -8px;
		padding: 2px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		color: var(--text-muted);
		text-align: left;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	button.act-row {
		cursor: pointer;
	}

	button.act-row:hover,
	button.act-row:focus-visible {
		background: var(--surface-elevated);
	}

	button.act-row:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Open: the row and its body join into one block — the row keeps only its
	   top corners rounded, the body only its bottom ones. */
	.act-row.is-open {
		background: var(--surface-elevated);
		border-radius: 6px 6px 0 0;
	}

	.act-status {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--success);
	}

	.act-status.running {
		color: var(--accent);
	}

	.act-status.running :global(svg) {
		animation: act-spin 0.9s linear infinite;
	}

	@keyframes act-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.act-status.failed {
		color: var(--danger);
	}

	.act-label {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 5px;
		overflow: hidden;
	}

	.act-verb {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	/* A running row's verb carries the same text sweep as the "Thinking"
	   header, so the live row reads as part of the same live surface. */
	.act-row.is-running .act-verb {
		background: linear-gradient(
			90deg,
			var(--text-muted) 0%,
			var(--text-muted) 35%,
			var(--text-primary) 50%,
			var(--text-muted) 65%,
			var(--text-muted) 100%
		);
		background-size: 250% auto;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: act-sweep 2.4s linear infinite;
	}

	@keyframes act-sweep {
		0% {
			background-position: 250% center;
		}
		100% {
			background-position: -250% center;
		}
	}

	.act-object {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.act-meta {
		flex: 0 0 auto;
		font-size: var(--text-xs);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.act-row.is-failed .act-meta {
		color: var(--danger);
	}

	:global(.act-chevron) {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		color: var(--text-muted);
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.act-row.is-open :global(.act-chevron) {
		transform: rotate(180deg);
	}

	.act-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		margin: 0 -8px 6px;
		padding: 8px 10px 10px 30px;
		border-radius: 0 0 6px 6px;
		background: var(--surface-elevated);
		overflow: visible;
		/* The body sits inside the message's serif prose column; tool detail is
		   UI, not prose, so it pins the sans face like the row above it. */
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.act-eyebrow {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}

	.act-src,
	.act-action-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		margin: 0 -6px;
		padding: 3px 6px;
		border-radius: 5px;
		color: inherit;
		text-decoration: none;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.act-src:hover,
	.act-src:focus-visible {
		background: var(--surface-overlay);
	}

	/* The hovered source row lifts above the rows BELOW it, so its popover —
	   which hangs off the bottom edge — is painted over the next source
	   instead of under it. The z-index drop is delayed by the popover's own
	   duration (an instant step at the end, not an interpolation), so the
	   fade-out is never cut off by the row falling back into place. */
	.act-src {
		z-index: 0;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			z-index 0s linear var(--duration-standard);
	}

	.act-src:hover,
	.act-src:focus-within {
		z-index: 30;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			z-index 0s linear 0s;
	}

	.act-src:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.act-favicon {
		flex: 0 0 14px;
		width: 14px;
		height: 14px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		overflow: hidden;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
	}

	.act-favicon img {
		width: 14px;
		height: 14px;
		object-fit: contain;
	}

	.act-src-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.act-src-host {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	:global(.act-src-cited) {
		flex: 0 0 auto;
		margin-left: auto;
		color: var(--success);
	}

	/* The full excerpt, un-clipped, on hover — the native `title` attribute
	   above stays as the non-hover / assistive-tech fallback.
	   It is ALWAYS rendered (it used to be display:none, which cannot
	   animate) and fades + slides in and out. `visibility` carries the
	   "not there" semantics — it keeps the hidden popover out of hit-testing
	   and out of the a11y tree — and is switched in one step at the END of
	   the fade-out (a 0s transition delayed by the full duration) so the
	   closing animation actually plays. `pointer-events: none` throughout:
	   this is a tooltip, never a target. */
	.act-src-popover {
		position: absolute;
		left: 0;
		top: calc(100% + 4px);
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-width: min(28rem, 90vw);
		padding: 8px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
		white-space: normal;
		opacity: 0;
		visibility: hidden;
		transform: translateY(-4px);
		pointer-events: none;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility 0s linear var(--duration-standard);
	}

	.act-src:hover .act-src-popover,
	.act-src:focus-visible .act-src-popover {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility 0s linear 0s;
	}

	.act-src-popover-title {
		font-weight: 600;
		color: var(--text-primary);
	}

	.act-src-popover-reason {
		color: var(--text-secondary);
		line-height: 1.45;
	}

	.act-excerpt,
	.act-map-summary {
		line-height: 1.45;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.act-map-summary {
		color: var(--text-primary);
	}

	.act-transit {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.act-transit-leg {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.act-transit-time {
		min-width: 5.5em;
		color: var(--text-primary);
		font-variant-numeric: tabular-nums;
	}

	.act-transit-line {
		padding: 0 5px;
		border-radius: 4px;
		background: var(--accent);
		color: var(--surface-page);
		font-weight: 600;
	}

	.act-transit-walk {
		color: var(--text-muted);
	}

	.act-transit-where {
		flex: 1 1 8em;
		min-width: 0;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.act-transit-headsign {
		margin-left: 6px;
		color: var(--text-muted);
	}

	.act-transit-meta {
		margin-left: auto;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.act-code {
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: 5px;
		background: var(--surface-code);
		color: var(--text-primary);
		font-family: var(--font-mono, monospace);
		font-size: 0.72rem;
		line-height: 1.5;
		white-space: pre;
		overflow: auto;
	}

	/* Tailwind's preflight strips list markers app-wide, so the bullets are
	   restored explicitly here — without them the memory body reads as a
	   run-on paragraph. */
	.act-bullets {
		margin: 0;
		padding-left: 14px;
		line-height: 1.5;
		list-style: disc outside;
	}

	.act-bullets li::marker {
		color: color-mix(in srgb, var(--text-muted) 60%, transparent);
	}

	.act-error {
		color: var(--danger);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.act-kv {
		display: flex;
		gap: 6px;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.72rem;
	}

	.act-kv-key {
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.act-kv-key::after {
		content: ':';
	}

	.act-kv-value {
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text-primary);
	}

	@media (prefers-reduced-motion: reduce) {
		.act-status.running :global(svg) {
			animation: none;
		}

		.act-row.is-running .act-verb {
			animation: none;
			background: none;
			color: var(--text-muted);
			-webkit-text-fill-color: var(--text-muted);
		}

		:global(.act-chevron) {
			transition: none;
		}

		/* The popover still fades (a cross-fade is not vestibular motion) but
		   never slides. */
		.act-src-popover,
		.act-src:hover .act-src-popover,
		.act-src:focus-visible .act-src-popover {
			transform: none;
		}
	}
</style>
