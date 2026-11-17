<script lang="ts">
// The video card's body under `ArtifactCard`'s head (video plan, slice 3), on
// the one card shell every take card shares (`takes/TakeCardShell.svelte`: the
// stage, its states and shimmer, the actions row, the More menu, the countdown
// handed to the head). What is the clip's own is here: the player in the
// stage, the VIDEO badge and the clip's length laid over it, and Download,
// Download as GIF and a disabled History in the menu.
//
// A clip's versions are real but History is not shown for one yet: there is no
// takes strip, and Another replaces what the card shows. The card's data is
// worked out in `video-card-view.ts`.
import { Download, FileImage, History } from "@lucide/svelte";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import TakeCardShell from "../takes/TakeCardShell.svelte";
import { isTakeActive } from "../takes/take-card-view";
import { downloadClipAsGif } from "./clip-downloads";
import {
	type VideoCardAction,
	type VideoCardActionHandler,
	type VideoCardView,
	videoDurationLabel,
	videoFileUrl,
} from "./video-card-view";
import VideoPlayer from "./VideoPlayer.svelte";

let {
	card,
	conversationId = null,
	onAction = undefined,
	gone = null,
	onTime = undefined,
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
	/**
	 * The words the card's head shows beside the kind while the take is on its
	 * way ("Next up", "About 38 s left", "Almost done…"), null once it is not.
	 */
	onTime?: ((words: string | null) => void) | undefined;
} = $props();

/** The GIF is being made: the row wears the card's own disabled/busy look. */
let gifBusy = $state(false);
/** Anothers pressed whose take the card does not hold yet. */
let pendingAnothers = $state(0);
let takeBeforeAnother = $state<string | null>(null);

/** The chat scope every file URL carries: the caller's, or the card's own. */
let scope = $derived(conversationId ?? card.conversationId);
let take = $derived(card.take);
let clip = $derived(take?.clip ?? null);
let box = $derived(
	clip
		? { width: clip.width, height: clip.height }
		: { width: card.width, height: card.height },
);
// Another is offered once nothing of the card is on its way, and only where a
// page answers it: a button that would do nothing is a disabled one.
let anotherDisabled = $derived(
	Boolean(gone) || !onAction || pendingAnothers > 0 || isTakeActive(take),
);

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
	if (take && onAction) fire({ type: "retry", takeId: take.id });
}

function pressDownload(close: () => void): void {
	close();
	if (!clip) return;
	void startAuthenticatedDownload(
		videoFileUrl(clip.fileId, { download: true, conversationId: scope }),
	);
}

async function pressDownloadGif(close: () => void): Promise<void> {
	if (!clip || gifBusy) return;
	// The menu stays open while the GIF is made, so the row's disabled state is
	// the busy state the reader can see (the first GIF takes seconds of ffmpeg).
	gifBusy = true;
	try {
		await downloadClipAsGif(clip.fileId, {
			conversationId: scope,
			title: card.title,
		});
	} finally {
		gifBusy = false;
		close();
	}
}
</script>

<TakeCardShell
	kind="video"
	{take}
	landed={clip !== null}
	{box}
	cardId={card.id}
	title={card.title}
	{gone}
	canAct={Boolean(onAction)}
	{anotherDisabled}
	onAnother={pressAnother}
	onStop={pressStop}
	onRetry={pressRetry}
	{onTime}
>
	{#snippet result()}
		{#if clip}
			<VideoPlayer
				fileId={clip.fileId}
				posterFileId={clip.posterFileId}
				title={card.title}
				conversationId={scope}
				testId="video-card-player"
			/>
		{/if}
	{/snippet}

	{#snippet stage({ ready })}
		<!-- The kind's own word on the stage, whatever it shows (the picture card
		     carries none: its picture says what it is). -->
		<span class="video-card-badge" data-testid="video-card-badge"
			>{$t('artifacts.video.badge')}</span
		>
		{#if ready && clip}
			<!-- The clip's length, clear of the player's controls. A label over the
			     player, never a target: a press on it reaches the clip. -->
			<span
				class="take-card-chip video-card-duration"
				data-testid="video-card-duration"
				role="img"
				aria-label={$t('artifacts.video.card.lengthA11y', {
					count: Math.round(clip.durationMs / 1000),
				})}>{videoDurationLabel(clip.durationMs)}</span
			>
		{/if}
	{/snippet}

	{#snippet menu({ close, ready })}
		<button
			type="button"
			role="menuitem"
			class="take-card-menu-row"
			data-testid="video-card-download"
			disabled={!ready || !clip || gifBusy}
			onclick={() => pressDownload(close)}
		>
			<Download size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>{$t('artifacts.take.download')}</span>
		</button>
		<!-- The clip as a GIF: the same download row, under the mp4 that stays the
		     default, and disabled with it while there is no file. -->
		<button
			type="button"
			role="menuitem"
			class="take-card-menu-row"
			data-testid="video-card-download-gif"
			disabled={!ready || !clip || gifBusy}
			aria-busy={gifBusy ? 'true' : undefined}
			onclick={() => void pressDownloadGif(close)}
		>
			<FileImage size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>{$t('artifacts.video.card.downloadGif')}</span>
		</button>
		<button
			type="button"
			role="menuitem"
			class="take-card-menu-row"
			data-testid="video-card-history"
			title={$t('artifacts.video.card.historyUnavailable')}
			disabled
		>
			<History size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>{$t('artifacts.take.history')}</span>
		</button>
	{/snippet}
</TakeCardShell>

<style>
	/* The clip's length on the stage's top-right corner: the card's chip. */
	.video-card-duration {
		top: 0.5rem;
		right: 0.5rem;
	}

	/* The kind's own word on the stage's top-left corner. */
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
</style>
