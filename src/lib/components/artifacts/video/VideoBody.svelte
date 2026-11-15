<script lang="ts">
// The Video kind's body in the family's panel (video plan, slice 3). It reads
// the stored item, parses its version body (the shared `VideoVersionBody`) and
// draws the one player; the panel's open, dock, expand, Delete and History are
// the shell's, never this file's.
//
// A clip's versions are real but History is not shown for one yet, so there is
// no strip and no compare. The body
// registers the header's Download for the clip's own file, and reloads when
// the page hears of a newer version (a restore, or a late landing), the same
// contract the picture body follows.
import { untrack } from "svelte";
import { get } from "svelte/store";
import { fetchArtifact } from "$lib/client/api/artifacts";
import {
	downloadAuthenticatedBlob,
	startAuthenticatedDownload,
} from "$lib/client/downloads";
import { t } from "$lib/i18n";
import {
	parseVideoVersionBody,
	type VideoVersionBody,
} from "$lib/shared/artifacts/video-body";
import { showToast } from "$lib/stores/toast";
import AnchoredPopover from "../AnchoredPopover.svelte";
import type { ArtifactBodyProps } from "../artifact-bodies";
import { videoDurationLabel, videoFileUrl } from "./video-card-view";
import VideoPlayer from "./VideoPlayer.svelte";

let {
	artifactId,
	title,
	conversationId = null,
	versionNumber = null,
	registerPanelActions,
}: ArtifactBodyProps = $props();

let status = $state<"loading" | "ready" | "error">("loading");
let clip = $state.raw<VideoVersionBody | null>(null);
/** The version `clip` is: the page's own number rising past it reads the item again. */
let loadedVersion = $state(0);
/** The panel header's Download chooses the mp4 (the default) or a GIF here. */
let downloadOpen = $state(false);
/** The GIF is being made: the row wears the card's own disabled/busy look. */
let gifBusy = $state(false);
let loading = false;
let loadAgain = false;

async function readOnce(): Promise<void> {
	try {
		const detail = await fetchArtifact(artifactId, conversationId);
		const parsed = parseVideoVersionBody(detail.artifact.body ?? null);
		if (!parsed) {
			if (!untrack(() => clip)) status = "error";
			return;
		}
		clip = parsed;
		loadedVersion = detail.artifact.versionNumber;
		status = "ready";
	} catch {
		if (!untrack(() => clip)) status = "error";
	}
}

/** One read at a time; a read asked for while one is out runs once it answers. */
async function load(): Promise<void> {
	if (loading) {
		loadAgain = true;
		return;
	}
	loading = true;
	do {
		loadAgain = false;
		await readOnce();
	} while (loadAgain);
	loading = false;
}

function reload(): void {
	void load();
}

// The body is mounted per item (`DocumentWorkspace` keys it), so this runs once.
$effect(() => {
	untrack(reload);
});

// A newer version the page heard of is read here too (the picture body's F23
// contract); before the first load there is nothing to be behind.
$effect(() => {
	const heard = versionNumber;
	if (status !== "ready" || heard === null || heard <= loadedVersion) return;
	untrack(reload);
});

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
	gifBusy = true;
	try {
		// The GIF is made on request and its 503/500 is a sentence to say, never a
		// file to save; the popover stays open while it runs so the row's disabled
		// state is the busy state (the first GIF takes seconds of ffmpeg).
		const started = await downloadAuthenticatedBlob(
			videoFileUrl(fileId, { download: true, format, conversationId }),
			{ fallbackFilename: `${title || "clip"}.gif` },
		);
		if (!started) {
			showToast({
				type: "error",
				message: get(t)("artifacts.image.card.actionFailed"),
			});
		}
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
		reload,
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
		<div class="video-body-shimmer" aria-hidden="true">
			<span class="video-body-shimmer-band"></span>
		</div>
		<span class="sr-only" role="status" data-testid="video-body-loading"
			>{$t('artifacts.video.panel.loading')}</span
		>
	{:else if status === 'error'}
		<p class="video-body-error" role="alert">
			{$t('artifacts.video.panel.loadFailed')}
		</p>
	{:else if clip}
		<div
			class="video-body-stage"
			data-testid="video-body-stage"
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
		<span class="video-body-length">{lengthLabel}</span>
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
		/* The stage's size is measured against this box, both ways: `100cqw` and
		   `100cqh` are the panel's own width and height, never the viewport's. */
		container-type: size;
	}

	/* The clip is fitted by CSS alone: its aspect-ratio box as large as the panel
	   allows in BOTH directions (a wide panel around a tall clip letterboxes no
	   more than a tall panel around a wide one). No ResizeObserver, so the dock's
	   width animation never re-flows it. */
	.video-body-stage {
		position: relative;
		width: min(100cqw, calc(100cqh * var(--ratio)));
		max-width: 100%;
		max-height: 100%;
		margin-block: auto;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.video-body-stage :global(.video-player) {
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

	/* The read before the clip arrives: the card's own calm shimmer, and gone
	   under reduced motion. */
	.video-body-shimmer {
		position: relative;
		width: min(100%, 60cqw);
		aspect-ratio: 16 / 9;
		margin: auto;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--text-muted) 8%, var(--surface-elevated));
	}

	.video-body-shimmer-band {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent 0%,
			var(--shimmer-highlight) 50%,
			transparent 100%
		);
		transform: translateX(-100%);
		animation: video-body-shimmer var(--duration-shimmer) var(--ease-out) infinite;
		will-change: transform;
	}

	@keyframes video-body-shimmer {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.video-body-shimmer-band {
			animation: none;
			visibility: hidden;
		}
	}
</style>
