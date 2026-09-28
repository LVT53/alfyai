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
import type { Snippet } from "svelte";
import { t } from "$lib/i18n";
import ArtifactCard, {
	type ArtifactCardView,
} from "$lib/components/artifacts/ArtifactCard.svelte";
import type { DocumentAlfyActivity } from "$lib/components/artifacts/document/alfy-activity";
import { documentArtifactCardViewFromPreview } from "$lib/components/artifacts/document/card-view";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { APP_VERIFY_LINE_KEYS } from "$lib/shared/artifacts/app-verify-labels";
import {
	extractHostname,
	getFaviconUrl,
	isCitedSource,
} from "$lib/utils/tool-evidence-presentation";
import type {
	ToolActivityBody,
	ToolActivityItem,
} from "$lib/utils/tool-activity";
import RouteItinerary from "./RouteItinerary.svelte";
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
	bodyContent = undefined,
	conversationId = null,
	onToggleDocumentTask = undefined,
	alfyActivity = null,
	activeArtifactId = null,
}: {
	item: ToolActivityItem;
	open?: boolean;
	onToggle?: ((key: string) => void) | undefined;
	job?: FileProductionJob | undefined;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetryJob?: ((jobId: string) => void) | undefined;
	onCancelJob?: ((jobId: string) => void) | undefined;
	onDismissJob?: ((jobId: string) => void) | undefined;
	/**
	 * The panel for a body kind this component does not own — today only
	 * `atlas`, whose body (AtlasActivityBody) needs the Atlas job and its
	 * lifecycle callbacks. Passing it in as a snippet keeps this row free of
	 * Atlas-specific props while the row chrome (status glyph, verb, meta,
	 * chevron, open/close slide) stays shared.
	 */
	bodyContent?: Snippet | undefined;
	/**
	 * The conversation this row's message belongs to (Feature 2, ruling 51):
	 * a create_artifact/edit_artifact card's Open action needs it to resolve
	 * an incognito conversation's own item, exactly like `fetchArtifact` does
	 * elsewhere. Never used by any other body kind.
	 */
	conversationId?: string | null;
	/**
	 * The Document card's own tick (T9.7's contract, reused rather than a
	 * second write path): writes through the SAME `toggleDocumentTask` call
	 * the panel's list uses. Undefined for every other kind's card.
	 */
	onToggleDocumentTask?:
		| ((artifactId: string, blockId: string, checked: boolean) => void)
		| undefined;
	/**
	 * The same ephemeral, session-only "a change just landed" signal
	 * `DocumentWorkspace.svelte`'s own list rows already read (redesign §5.2,
	 * Wave 2.5 Step 12) — feeds the standalone in-chat card's
	 * `pendingReviewCount` ("N changes to review" + "Review ›") when this
	 * row's own artifact is the one the activity is about. `null` outside a
	 * live Document turn, or for every other body kind.
	 */
	alfyActivity?: DocumentAlfyActivity | null;
	/**
	 * Wave 2.5 Step 13: the bare artifact id of whatever item is actually open
	 * in the panel right now (the chat page's own `activeArtifactId`, resolved
	 * from `activeWorkspaceDocumentId` through `workspaceDocuments`' own
	 * `artifactId` field) — matched against this row's own
	 * `body.artifactId` to show "Open in panel" instead of "Open ›" for the
	 * one card that is the currently-open item. `null` when nothing is open,
	 * or the panel is showing the list rather than a specific item.
	 */
	activeArtifactId?: string | null;
} = $props();

type ArtifactActivityBody = Extract<ToolActivityBody, { kind: "artifact" }>;
type ArtifactCreatingBody = Extract<
	ToolActivityBody,
	{ kind: "artifact-creating" }
>;
type ArtifactFailedBody = Extract<
	ToolActivityBody,
	{ kind: "artifact-failed" }
>;

/**
 * The four new kinds' chat-card view (Feature 2, the cross-kind task): the
 * Document body reuses Slice 1's own bounded-preview builder verbatim when a
 * preview rode along on the tool-call's enrichment (`ThinkingBlock`'s
 * `preview`, attached from `ConversationDetail.artifacts` — never fetched
 * here); every other kind — and a Document with no preview yet, live mid-turn
 * — gets the bare header-only view, exactly what "the generic card until
 * their slices add previews" means for Canvas/Slides today.
 */
function artifactCardView(body: ArtifactActivityBody): ArtifactCardView {
	const documentPreview =
		body.artifactKind === "document"
			? body.preview?.documentPreview
			: undefined;
	// Mirrors `DocumentWorkspace.svelte`'s own `artifactCardViewFor` exactly
	// (redesign §5.2, Wave 2.5 Step 12): the standalone card's "N changes to
	// review" pill and "Review ›" affordance read the same ephemeral signal
	// the panel list's row already does, matched to THIS card's own artifact.
	const pendingReviewCount =
		alfyActivity &&
		alfyActivity.artifactId === body.artifactId &&
		(alfyActivity.status === "applied" || alfyActivity.status === "refused")
			? Math.max(alfyActivity.appliedCount, 1)
			: null;
	// Wave 2.5 Step 13: matched against the bare artifact id, never the
	// workspace item id ("artifact:" + id) the panel itself uses — see
	// `activeArtifactId`'s own prop doc above.
	const current =
		activeArtifactId != null && activeArtifactId === body.artifactId;
	// App only, and only once its facts were actually checked — the same
	// gate `AppBody.svelte`'s own status row uses (`verification?.checked`).
	const appVerification =
		body.artifactKind === "app" ? body.preview?.appVerification : undefined;
	const factCheckLine = appVerification?.checked
		? $t(APP_VERIFY_LINE_KEYS[appVerification.verdict])
		: null;
	if (documentPreview) {
		return {
			...documentArtifactCardViewFromPreview({
				artifactId: body.artifactId,
				title: body.artifactTitle,
				versionNumber: body.preview?.versionNumber ?? 0,
				subtitle: $t("artifacts.document.cardSubtitle", {
					count: documentPreview.tabCount,
				}),
				preview: documentPreview,
				onToggleTask: (blockId, checked) =>
					onToggleDocumentTask?.(body.artifactId, blockId, checked),
			}),
			pendingReviewCount,
			current,
		};
	}
	return {
		id: body.artifactId,
		kind: body.artifactKind,
		title: body.artifactTitle,
		openTargetId: body.artifactId,
		pendingReviewCount,
		current,
		factCheckLine,
	};
}

/** Wave 2.5 Step 12: the running create_artifact skeleton card — see the `"artifact-creating"` body's own doc comment in tool-activity.ts. */
function artifactCreatingCardView(
	body: ArtifactCreatingBody,
): ArtifactCardView {
	return {
		id: `creating:${body.title}`,
		kind: body.artifactKind,
		title: body.title,
		creating: true,
	};
}

/**
 * Wave 2.5 Step 12: the refused create_artifact "could not be made" card —
 * see the `"artifact-failed"` body's own doc comment in tool-activity.ts.
 * `reason` is effectively always set in practice (`runCreateArtifactTool`'s
 * own failure path always writes an `outputSummary`); the fallback below is
 * only a defensive backstop against a genuinely empty one, and is
 * deliberately a DIFFERENT sentence than the card's own fixed title so the
 * two lines never repeat each other.
 */
function artifactFailedCardView(body: ArtifactFailedBody): ArtifactCardView {
	return {
		id: `failed:${body.title}`,
		kind: body.artifactKind,
		title: body.title,
		failedReason: body.reason || $t("artifacts.error.load"),
	};
}

/**
 * Reuses the chat page's existing panel-open path (`onOpenDocument`, already
 * threaded here for the File body's per-file Open) rather than a second
 * callback: a minimal, ready-to-open item built straight from the tool
 * call's own metadata, mirroring `MessageBubble.svelte`'s
 * `handleViewAttachment`. Never requires the artifact to already be in any
 * list — the item this builds IS the thing to open.
 */
function handleOpenArtifact(body: ArtifactActivityBody): void {
	onOpenDocument?.({
		id: `artifact:${body.artifactId}`,
		source: "knowledge_artifact",
		filename: body.artifactTitle,
		title: body.artifactTitle,
		mimeType: null,
		artifactId: body.artifactId,
		conversationId,
		kind: body.artifactKind,
	});
}

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
// Redesign §5.1 problem 7 / §5.2 (Wave 2.5 Step 12): a create_artifact/
// edit_artifact card must "stand on its own, below the tool row and outside
// the collapsible thinking area" instead of reading like another line inside
// the grey `.act-body` box — unlike every other body kind (including
// file-job, left exactly as it was), which still joins the row into one
// shaded block. `isJoinedOpen` drives that shared box/join styling; the
// artifact card renders through its own standalone wrapper below instead.
const isStandaloneCard = $derived(
	item.body?.kind === "artifact" ||
		item.body?.kind === "artifact-creating" ||
		item.body?.kind === "artifact-failed",
);
const isJoinedOpen = $derived(isOpen && !isStandaloneCard);

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

/**
 * The File kind's card view (Slice 0 Task S6): ArtifactCard's chrome="body"
 * mode owns the lazy FileProductionCard import itself now, so this row only
 * has to describe the job, not fetch its body's chunk.
 */
function fileArtifactCardView(job: FileProductionJob): ArtifactCardView {
	return { id: job.id, kind: "file", title: job.title };
}

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
			class:is-open={isJoinedOpen}
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
			class:is-open={isJoinedOpen}
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

	{#if isOpen && item.body?.kind === 'artifact'}
		{@const body = item.body}
		<!-- Redesign §5.1 problem 7 / §5.2 (Wave 2.5 Step 12): a create_artifact/
		     edit_artifact card stands on its own below the tool row, never
		     joined into its grey `.act-body` box — chrome="full" now, not
		     "body", so the card draws its own head ("the head is one button"),
		     matching the approved mockup's `.a-card` next to a compact
		     `.tool-row`-style status line instead of nesting inside it. -->
		<div class="act-standalone-card" data-testid="tool-activity-standalone-card">
			<ArtifactCard
				view={artifactCardView(body)}
				chrome="full"
				onOpen={() => handleOpenArtifact(body)}
			/>
		</div>
	{/if}

	{#if isOpen && item.body?.kind === 'artifact-creating'}
		{@const body = item.body}
		<!-- Wave 2.5 Step 12: the skeleton standalone card while create_artifact
		     is still running — same standalone placement as the settled card
		     above, no Open handler (nothing exists to open yet). -->
		<div class="act-standalone-card" data-testid="tool-activity-standalone-card">
			<ArtifactCard view={artifactCreatingCardView(body)} chrome="full" />
		</div>
	{/if}

	{#if isOpen && item.body?.kind === 'artifact-failed'}
		{@const body = item.body}
		<!-- Wave 2.5 Step 12: the "could not be made" standalone card for a
		     refused create_artifact — same standalone placement, no Open
		     handler and no Retry: there is no real retry path for this call
		     today (see rd5b's own report). -->
		<div class="act-standalone-card" data-testid="tool-activity-standalone-card">
			<ArtifactCard view={artifactFailedCardView(body)} chrome="full" />
		</div>
	{/if}

	{#if isOpen && item.body && item.body.kind !== 'artifact' && item.body.kind !== 'artifact-creating' && item.body.kind !== 'artifact-failed'}
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
				<!-- The whole route body — mode strip, summary, map, and the
				     step-by-step directions or timeline — is RouteItinerary's.
				     The map itself is handed in as a snippet so MapLibre stays
				     lazily imported, and so the itinerary can pass the hovered
				     step's span straight into the map's highlight layer. -->
				<RouteItinerary map={body.map} summary={body.summary}>
					{#snippet mapSurface(highlightRange, focusRange)}
						{#if MapRouteBody}
							<MapRouteBody map={body.map} {highlightRange} {focusRange} />
						{/if}
					{/snippet}
				</RouteItinerary>
			{:else if body.kind === 'file-job'}
				{#if job}
					<ArtifactCard
						view={fileArtifactCardView(job)}
						{job}
						chrome="body"
						{onOpenDocument}
						onRetry={onRetryJob}
						onCancel={onCancelJob}
						onDismiss={onDismissJob}
					/>
				{/if}
			{:else if body.kind === 'atlas'}
				{@render bodyContent?.()}
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

	/* The standalone in-chat card (redesign §5.1 problem 7 / §5.2): plain
	   vertical spacing only — no shared background, join, or negative margin
	   pulling it under the row like `.act-body` below, since it is
	   deliberately NOT part of that joined box. */
	.act-standalone-card {
		margin: 6px 0 10px;
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
