<script lang="ts">
// The video card's body under `ArtifactCard`'s head (video plan, slice 3): the
// picture card's shell, its reserved stage, its one shimmer and its actions
// row, with a VIDEO badge on the stage, the clip's length once it is ready and
// a player in place of the picture.
//
// Nothing here changes height when the take changes state: the stage keeps the
// clip's shape from the first paint (720p before a clip exists), and the state
// and the player are stacked layers that crossfade on opacity. While a take
// waits, starts or is made the stage shows only the shimmer (one layer) and
// the words are the sr-only status; the estimate — or the phase's `m:ss`
// clock — is a chip laid over the stage (`aria-hidden`, so the live region
// never re-announces it), the same rule the picture card follows.
//
// A clip has no versions: More offers Download and a History that is disabled
// on purpose, and there is no takes strip. The whole card is worked out in
// `video-card-view.ts`.
import {
	Download,
	Ellipsis,
	EyeOff,
	FileImage,
	History,
	RefreshCw,
	TriangleAlert,
	VideoOff,
} from "@lucide/svelte";
import { fade } from "svelte/transition";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import AnchoredPopover from "../AnchoredPopover.svelte";
import {
	type VideoCardAction,
	type VideoCardActionHandler,
	type VideoCardView,
	isVideoTakeActive,
	videoDurationLabel,
	videoFileUrl,
	videoStateWords,
	videoTakeState,
} from "./video-card-view";
import VideoPlayer from "./VideoPlayer.svelte";

let {
	card,
	conversationId = null,
	onAction = undefined,
	gone = null,
}: {
	card: VideoCardView;
	conversationId?: string | null;
	onAction?: VideoCardActionHandler | undefined;
	/**
	 * The Video this card is about was deleted, or is out of this chat's reach
	 * (made in the chat this one was forked from). The card keeps its box and
	 * rows, says so in the box, and offers nothing to press.
	 */
	gone?: "deleted" | "unreachable" | null;
} = $props();

const crossfade = reducedMotionAware(fade);

let now = $state(Date.now());
let menuOpen = $state(false);
/** Anothers pressed whose take the card does not hold yet. */
let pendingAnothers = $state(0);
let takeBeforeAnother = $state<string | null>(null);

/** The chat scope every file URL carries: the caller's, or the card's own. */
let scope = $derived(conversationId ?? card.conversationId);
let take = $derived(card.take);
let cardState = $derived(videoTakeState(take, now));
let words = $derived(videoStateWords(cardState, now, $t));
let box = $derived(
	take?.clip
		? { width: take.clip.width, height: take.clip.height }
		: { width: card.width, height: card.height },
);
let ready = $derived(!gone && cardState.kind === "ready" && take?.clip != null);
let clip = $derived(ready ? (take?.clip ?? null) : null);
/**
 * Waiting, starting up and being made are one look: the same shimmer layer
 * from the first state to the last, so it never restarts between them.
 */
let busy = $derived(
	!gone &&
		(cardState.kind === "waiting" ||
			cardState.kind === "starting" ||
			cardState.kind === "making"),
);
let statusText = $derived(busy ? words.line : "");
let statusDetail = $derived(busy ? (words.detail ?? "") : "");
let durationLabel = $derived(
	videoDurationLabel(clip?.durationMs ?? card.durationMs),
);
let canRetry = $derived(
	!gone &&
		take != null &&
		(cardState.kind === "failed" ||
			cardState.kind === "stopped" ||
			(cardState.kind === "blocked" && cardState.unchecked)),
);
// Another is offered once nothing of the card is on its way, and only where a
// page answers it: a button that would do nothing is a disabled one.
let anotherDisabled = $derived(
	Boolean(gone) || !onAction || pendingAnothers > 0 || isVideoTakeActive(take),
);
let menuAnchorId = $derived(`video-card-more-${card.id}`);

// The card's clock: it ticks once a second only while the take is making and
// the render reports no estimate of its own.
$effect(() => {
	const running = take;
	if (
		gone ||
		!running ||
		running.status !== "running" ||
		running.phase === "submitted"
	) {
		return;
	}
	now = Date.now();
	if (running.etaSeconds !== null && running.etaSeconds > 0) return;
	if (
		running.phase === "starting" &&
		running.phaseAt !== null &&
		Date.now() - running.phaseAt >= 3_000
	) {
		return;
	}
	const timer = setInterval(() => (now = Date.now()), 1_000);
	return () => clearInterval(timer);
});

// The page refreshed the card with the take Another queued: Another is offered
// again.
$effect(() => {
	if (pendingAnothers > 0 && take?.id !== takeBeforeAnother) {
		pendingAnothers = 0;
	}
});

function fire(action: VideoCardAction): void {
	void onAction?.(action)?.catch(() => undefined);
}

async function pressAnother(): Promise<void> {
	if (anotherDisabled) return;
	if (pendingAnothers === 0) takeBeforeAnother = take?.id ?? null;
	pendingAnothers += 1;
	try {
		await onAction?.({ type: "another", cardId: card.id });
	} catch {
		pendingAnothers = Math.max(0, pendingAnothers - 1);
	}
}

function pressStop(): void {
	if (take && onAction) fire({ type: "stop", takeId: take.id });
}

function pressRetry(): void {
	if (take && canRetry) fire({ type: "retry", takeId: take.id });
}

function pressDownload(): void {
	menuOpen = false;
	if (!clip) return;
	void startAuthenticatedDownload(
		videoFileUrl(clip.fileId, { download: true, conversationId: scope }),
	);
}

function pressDownloadGif(): void {
	menuOpen = false;
	if (!clip) return;
	void startAuthenticatedDownload(
		videoFileUrl(clip.fileId, {
			download: true,
			format: "gif",
			conversationId: scope,
		}),
	);
}
</script>

<div
	class="video-card-body"
	data-testid="video-card-body"
	data-state={cardState.kind}
>
	<div
		class="video-card-stage"
		style:--box-ratio={box.width / box.height}
		style:aspect-ratio="{box.width} / {box.height}"
		data-testid="video-card-stage"
	>
		{#if gone}
			<!-- The Video is gone, or lives in another chat: the box keeps its
			     shape and says so; nothing in the card can be pressed. -->
			<div
				class="video-card-layer video-card-state video-card-gone"
				data-testid="video-card-gone"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
			>
				<VideoOff size={20} strokeWidth={1.75} aria-hidden="true" />
				<span class="video-card-state-detail">
					{gone === 'unreachable'
						? $t('artifacts.video.card.elsewhereDetail')
						: $t('artifacts.video.card.goneDetail')}
				</span>
			</div>
		{:else if ready && clip}
			<div class="video-card-layer" transition:crossfade={{ duration: MOTION_DURATION.standard }}>
				<VideoPlayer
					fileId={clip.fileId}
					posterFileId={clip.posterFileId}
					title={card.title}
					conversationId={scope}
					testId="video-card-player"
				/>
			</div>
		{:else if busy}
			<!-- Waiting, starting up, being made: only a calm light sweeping across
			     the whole box. The words are the sr-only status below. -->
			<div
				class="video-card-layer video-card-shimmer"
				data-testid="video-card-shimmer"
				aria-hidden="true"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
			>
				<span class="video-card-shimmer-band"></span>
				{#if cardState.kind === 'making'}
					<!-- The estimate, or the time this phase has taken: the same string
					     the sr-only detail carries, laid over the box so it adds no
					     height and hidden from screen readers. -->
					<span
						class="video-card-time"
						data-testid="video-card-time"
						aria-hidden="true">{statusDetail}</span
					>
				{/if}
			</div>
		{:else}
			{#key cardState.kind}
				<!-- Failure, a filtered-back clip and a Stop keep their words in the
				     box, the picture card's layout with the video's own words. -->
				<div
					class="video-card-layer video-card-state"
					class:video-card-blocked={cardState.kind === 'blocked'}
					data-testid={cardState.kind === 'blocked' ? 'video-card-blocked' : 'video-card-state'}
					transition:crossfade={{ duration: MOTION_DURATION.standard }}
				>
					<span class="video-card-state-line">
						{#if cardState.kind === 'failed'}
							<TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
						{:else if cardState.kind === 'blocked'}
							<EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
						{/if}
						<span>{words.line}</span>
					</span>
					<span class="video-card-state-detail">{words.detail ?? ''}</span>
					{#if canRetry}
						<button
							type="button"
							class="video-card-button"
							data-testid="video-card-retry"
							disabled={!onAction}
							onclick={pressRetry}
						>
							{$t('artifacts.video.card.tryAgain')}
						</button>
					{/if}
				</div>
			{/key}
		{/if}
		<span class="video-card-badge" data-testid="video-card-badge"
			>{$t('artifacts.video.badge')}</span
		>
		{#if ready && clip}
			<span
				class="video-card-duration"
				data-testid="video-card-duration"
				role="img"
				aria-label={$t('artifacts.video.card.lengthA11y', {
					count: Math.round((clip?.durationMs ?? card.durationMs) / 1000),
				})}>{durationLabel}</span
			>
		{/if}
	</div>
	<span class="sr-only" role="status" data-testid="video-card-status"
		>{statusText}</span
	>
	<span class="sr-only" data-testid="video-card-status-detail"
		>{statusDetail}</span
	>

	<div class="video-card-actions" data-testid="video-card-actions">
		<button
			type="button"
			class="video-card-button"
			data-testid="video-card-another"
			disabled={anotherDisabled}
			onclick={() => void pressAnother()}
		>
			<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.video.card.another')}
		</button>
		<!-- Stop sits in the same one grid cell the picture card keeps for Stop
		     and Use this, so nothing jumps when a clip lands. -->
		<span class="video-card-swap" data-testid="video-card-swap">
			{#if take && busy}
				<button
					type="button"
					class="video-card-button"
					data-testid="video-card-stop"
					disabled={!onAction}
					transition:crossfade={{ duration: MOTION_DURATION.standard }}
					onclick={pressStop}
				>
					{$t('artifacts.video.card.stop')}
				</button>
			{/if}
		</span>
		<span class="video-card-grow"></span>
		<button
			type="button"
			class="video-card-icon-button"
			aria-label={$t('artifacts.video.card.more')}
			aria-haspopup="dialog"
			disabled={Boolean(gone)}
			data-testid={menuAnchorId}
			onclick={() => (menuOpen = !menuOpen)}
		>
			<Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
</div>

{#if menuOpen}
	<AnchoredPopover
		title={card.title}
		anchorTestId={menuAnchorId}
		popoverTestId="video-card-menu"
		closeLabel={$t('common.close')}
		width={220}
		boundarySelector=".chat-main"
		onClose={() => (menuOpen = false)}
	>
		<div
			class="video-card-menu"
			role="menu"
			aria-label={$t('artifacts.video.card.more')}
		>
			<button
				type="button"
				role="menuitem"
				class="video-card-menu-row"
				data-testid="video-card-download"
				disabled={!ready || !clip}
				onclick={pressDownload}
			>
				<Download size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>{$t('artifacts.video.card.download')}</span>
			</button>
			<!-- The clip as a GIF: the same download row, under the mp4 that stays
			     the default, and disabled with it while there is no file. -->
			<button
				type="button"
				role="menuitem"
				class="video-card-menu-row"
				data-testid="video-card-download-gif"
				disabled={!ready || !clip}
				onclick={pressDownloadGif}
			>
				<FileImage size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>{$t('artifacts.video.card.downloadGif')}</span>
			</button>
			<button
				type="button"
				role="menuitem"
				class="video-card-menu-row"
				data-testid="video-card-history"
				title={$t('artifacts.video.card.historyUnavailable')}
				disabled
			>
				<History size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>{$t('artifacts.video.card.history')}</span>
			</button>
		</div>
	</AnchoredPopover>
{/if}

<style>
	.video-card-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.75rem 0.75rem;
	}

	/* The reserved box (the picture card's stage): the clip's shape from the
	   first paint, never taller than 22rem or 45% of the window. */
	.video-card-stage {
		position: relative;
		display: grid;
		width: min(100%, calc(min(22rem, 45vh) * var(--box-ratio)));
		margin-inline: auto;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	/* Every layer fills the box: the state and the player are stacked in one
	   grid cell and crossfade, so a state change never changes the box. */
	.video-card-layer {
		grid-area: 1 / 1;
		position: relative;
		min-width: 0;
		min-height: 0;
	}

	.video-card-gone,
	.video-card-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding: 0.75rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		text-align: center;
	}

	.video-card-state-line {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-primary);
		font-weight: 600;
	}

	.video-card-state-detail {
		min-height: 1.2em;
		max-width: 22rem;
		font-size: 0.75rem;
	}

	/* Kept back by the explicit filter: calmer than a failure. */
	.video-card-blocked {
		background: var(--surface-elevated);
	}

	.video-card-blocked .video-card-state-line {
		font-weight: 400;
	}

	.video-card-blocked .video-card-state-line :global(svg) {
		color: var(--icon-muted);
	}

	/* Waiting, starting up, being made: a soft tint over the whole box with a
	   lighter band sweeping slowly left to right (`transform` only). Under
	   reduced motion the band is gone and the tint stays still. */
	.video-card-shimmer {
		overflow: hidden;
		background: color-mix(in srgb, var(--text-muted) 8%, var(--surface-elevated));
	}

	.video-card-shimmer-band {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent 0%,
			var(--shimmer-highlight) 50%,
			transparent 100%
		);
		transform: translateX(-100%);
		animation: video-card-shimmer var(--duration-shimmer) var(--ease-out) infinite;
		will-change: transform;
	}

	@keyframes video-card-shimmer {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.video-card-shimmer-band {
			animation: none;
			visibility: hidden;
		}
	}

	/* The estimate/time chip and the clip's length: quiet chips laid over the
	   box (no height of their own), clear of each other and of the player's
	   controls. */
	.video-card-time,
	.video-card-duration {
		position: absolute;
		bottom: 0.5rem;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.75rem;
	}

	.video-card-time {
		left: 0.5rem;
		max-width: calc(100% - 3.5rem);
		pointer-events: none;
	}

	.video-card-duration {
		top: 0.5rem;
		right: 0.5rem;
		bottom: auto;
	}

	/* The kind's own word on the stage (the picture card carries none: its
	   picture says what it is). */
	.video-card-badge {
		position: absolute;
		top: 0.5rem;
		left: 0.5rem;
		z-index: 1;
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius-full);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		pointer-events: none;
	}

	.video-card-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.video-card-swap {
		display: grid;
		align-items: center;
		justify-items: start;
	}

	.video-card-swap > :global(*) {
		grid-area: 1 / 1;
	}

	.video-card-grow {
		flex: 1 1 auto;
	}

	.video-card-button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.375rem;
		min-height: 2rem;
		padding: 0 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.video-card-button:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.video-card-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.video-card-button:focus-visible,
	.video-card-icon-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.video-card-icon-button {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
	}

	.video-card-icon-button:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.video-card-icon-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.video-card-menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0 6px 6px;
	}

	.video-card-menu-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.25rem;
		padding: 0 0.625rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.84rem;
		text-align: left;
		cursor: pointer;
	}

	.video-card-menu-row:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.video-card-menu-row:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (hover: none) and (pointer: coarse) {
		.video-card-button,
		.video-card-icon-button,
		.video-card-menu-row {
			min-height: 44px;
		}

		.video-card-icon-button {
			width: 44px;
		}
	}
</style>
