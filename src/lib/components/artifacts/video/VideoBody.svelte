<script lang="ts">
// The Video kind's body in the family's panel (video plan, slice 3). It reads
// the stored item through the take bodies' one reader (`takes/item-reader`:
// the first read, and again whenever the page hears of a newer version, the
// picture body's F23 contract), parses its version body (the shared
// `VideoVersionBody`) and draws the one player; the panel's open, dock,
// expand, Delete and History are the shell's, never this file's.
//
// A clip's versions are real but History is not shown for one yet, so there is
// no strip and no compare. The body registers the header's Download for the
// clip's own file: the mp4, or the GIF made on request.
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import { parseVideoVersionBody } from "$lib/shared/artifacts/video-body";
import AnchoredPopover from "../AnchoredPopover.svelte";
import type { ArtifactBodyProps } from "../artifact-bodies";
import { createItemReader } from "../takes/item-reader.svelte";
import "../takes/take-card.css";
import { downloadClipAsGif } from "./clip-downloads";
import { videoFileUrl } from "./video-card-view";
import VideoPlayer from "./VideoPlayer.svelte";

let {
	artifactId,
	title,
	conversationId = null,
	versionNumber = null,
	registerPanelActions,
}: ArtifactBodyProps = $props();

const reader = createItemReader({
	artifactId: () => artifactId,
	conversationId: () => conversationId,
	versionNumber: () => versionNumber,
	parse: parseVideoVersionBody,
});
let status = $derived(reader.status);
let clip = $derived(reader.item);
/** The panel header's Download chooses the mp4 (the default) or a GIF here. */
let downloadOpen = $state(false);
/** The GIF is being made: the row wears the card's own disabled/busy look. */
let gifBusy = $state(false);

async function choose(format: "mp4" | "gif"): Promise<void> {
	const fileId = clip?.fileId;
	if (!fileId) return;
	if (format === "mp4") {
		downloadOpen = false;
		void startAuthenticatedDownload(
			videoFileUrl(fileId, { download: true, format, conversationId }),
		);
		return;
	}
	if (gifBusy) return;
	// The popover stays open while the GIF is made, so the row's disabled state
	// is the busy state the reader can see.
	gifBusy = true;
	try {
		await downloadClipAsGif(fileId, { conversationId, title });
	} finally {
		gifBusy = false;
		downloadOpen = false;
	}
}

$effect(() => {
	registerPanelActions?.({
		// With no clip there is nothing to download, so the panel offers no
		// Download at all (the button is not drawn without this function).
		openDownload: clip ? () => (downloadOpen = true) : undefined,
		reload: reader.reload,
	});
});

/** The clip's length, read out with its unit; the player's own controls carry the rest. */
let lengthLabel = $derived(
	clip
		? $t("artifacts.video.card.lengthA11y", {
				count: Math.round(clip.durationMs / 1000),
			})
		: "",
);
</script>

<div class="video-body" data-testid="video-body" data-state={status}>
	{#if status === 'loading'}
		<div class="video-body-shimmer take-shimmer" aria-hidden="true">
			<span class="take-shimmer-band"></span>
		</div>
		<span class="sr-only" role="status" data-testid="video-body-loading"
			>{$t('artifacts.video.panel.loading')}</span
		>
	{:else if status === 'error'}
		<p class="video-body-error" role="alert">
			{$t('artifacts.video.panel.loadFailed')}
		</p>
	{:else if clip}
		<!-- The stage is the size container (the picture body's shape): its box is
		     what `100cqw`/`100cqh` mean, and the length row below is outside it, so
		     the clip's height budget never has to pay for the gap and the row. -->
		<div class="video-body-stage" data-testid="video-body-stage">
			<div
				class="video-body-frame"
				data-testid="video-body-frame"
				style:--ratio={clip.width / clip.height}
				style:aspect-ratio="{clip.width} / {clip.height}"
			>
				<VideoPlayer
					fileId={clip.fileId}
					posterFileId={clip.posterFileId}
					{title}
					{conversationId}
					testId="video-body-player"
				/>
			</div>
		</div>
		<span class="video-body-length" data-testid="video-body-length"
			>{lengthLabel}</span
		>
	{/if}
</div>

{#if downloadOpen && clip}
	<!-- The panel header's Download offers the two files a clip has: the mp4,
	     which stays the default, and the GIF made on request. -->
	<AnchoredPopover
		title={$t('artifacts.video.panel.downloadTitle', { title })}
		anchorTestId="artifact-download-button"
		popoverTestId="video-download-popover"
		closeLabel={$t('common.close')}
		width={300}
		onClose={() => (downloadOpen = false)}
	>
		<div class="video-download-options">
			<button
				type="button"
				class="btn-secondary"
				data-testid="video-download-mp4"
				disabled={gifBusy}
				onclick={() => void choose('mp4')}
			>
				{$t('artifacts.video.panel.downloadMp4')}
			</button>
			<button
				type="button"
				class="btn-secondary"
				data-testid="video-download-gif"
				disabled={gifBusy}
				aria-busy={gifBusy ? 'true' : undefined}
				onclick={() => void choose('gif')}
			>
				{$t('artifacts.video.panel.downloadGif')}
			</button>
		</div>
	</AnchoredPopover>
{/if}

<style>
	.video-body {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* The family's room, as the picture body keeps it. */
		gap: var(--space-md);
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: var(--space-md);
		box-sizing: border-box;
	}

	/* The stage is the space the clip may take AND the container its box is
	   measured against, as the picture body's stage is. It takes the height the
	   length row and the gap leave, so those can never be counted twice. */
	.video-body-stage {
		position: relative;
		display: grid;
		place-items: center;
		flex: 1 1 auto;
		width: 100%;
		min-height: 0;
		overflow: hidden;
		container-type: size;
	}

	/* The clip's own rectangle: its aspect ratio, as large as the stage allows
	   both ways, worked out in the stage's container units. No ResizeObserver, so
	   the dock's width animation never re-flows it. */
	.video-body-frame {
		position: relative;
		width: min(100cqw, calc(100cqh * var(--ratio)));
		max-width: 100%;
		max-height: 100%;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.video-body-frame :global(.video-player) {
		width: 100%;
		height: 100%;
	}

	.video-body-length {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.video-download-options {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.5rem;
		padding: 0 0.875rem 0.875rem;
	}

	.video-body-error {
		margin: auto;
		padding: 1rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.875rem;
		text-align: center;
	}

	/* The read before the clip arrives: the card's own calm shimmer
	   (`take-shimmer`, gone under reduced motion), in a 16:9 box of its own. */
	.video-body-shimmer {
		position: relative;
		width: min(100%, 60cqw);
		aspect-ratio: 16 / 9;
		margin: auto;
		border-radius: var(--radius-md);
	}
</style>
