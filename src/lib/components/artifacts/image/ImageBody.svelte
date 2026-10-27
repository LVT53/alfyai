<script lang="ts">
// The Image kind's body in the family's panel (plan 2b T3, design 5.6): the
// picture large and, in one row below it, the strip of its versions and the
// tools (Before / After; T6 adds Mark). It is a body like the Document's, inside `DocumentWorkspace`:
// the panel's open, dock, expand and phone sheet are the shell's, never this
// file's.
//
// The picture is fitted by CSS alone (F24): a box with the picture's aspect
// ratio, as wide as the stage allows in both directions (container units), never
// wider than the picture itself. No ResizeObserver re-fit, so the dock's width
// animation never re-flows it, and T6's marks can be drawn in the picture's own
// rectangle (no `object-fit: contain` box around it, F15). The panel loads the
// full picture; the strip loads thumbnails.
//
// A version can land while the panel is open without a stream to follow (a late
// take, Use this, a restore): the page's latest moment for the item rises, and the
// body reads the item and History's first page again (F23).
import { untrack } from "svelte";
import { fetchArtifact, fetchArtifactHistory } from "$lib/client/api/artifacts";
import { imageFileUrl } from "$lib/client/api/images";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import type { ArtifactMoment } from "$lib/shared/artifacts/history";
import {
	type ImageVersionBody,
	parseImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import type { ArtifactBodyProps } from "../artifact-bodies";
import BeforeAfterSwitch from "./BeforeAfterSwitch.svelte";
import ImagePicture from "./ImagePicture.svelte";
import { pinchZoom } from "./pinch-zoom";
import VersionStrip from "./VersionStrip.svelte";

let {
	artifactId,
	title,
	conversationId = null,
	versionNumber = null,
	registerPanelActions,
	onOpenHistory,
	onAttachPicture,
}: ArtifactBodyProps = $props();

/** History's first page is enough for the strip: a picture is rarely changed fifty times. */
const STRIP_PAGE_SIZE = 50;

let status = $state<"loading" | "ready" | "error">("loading");
let picture = $state.raw<ImageVersionBody | null>(null);
/** The version `picture` is: the page's own number rising past it reads the item again. */
let loadedVersion = $state(0);
let loading = false;
/** A load was asked for while one was out (a restore landing mid-read): one more runs when it answers. */
let loadAgain = false;
/** Only the newest History read may draw the strip: an older one can answer last. */
let stripRequest = 0;
let moments = $state.raw<ArtifactMoment[]>([]);
let showing = $state<"before" | "after">("after");
let isPhone = $state(isPhoneViewport());

$effect(() => watchPhoneViewport((phone) => (isPhone = phone)));

/** Reads the stored item once and shows it; never throws. */
async function readOnce(): Promise<void> {
	try {
		const detail = await fetchArtifact(artifactId, conversationId);
		const parsed = parseImageVersionBody(detail.artifact.body ?? null);
		if (!parsed) {
			if (!untrack(() => picture)) status = "error";
			return;
		}
		// Another picture: show its After (its Before may be another base, or none).
		if (parsed.fileId !== untrack(() => picture)?.fileId) showing = "after";
		picture = parsed;
		loadedVersion = detail.artifact.versionNumber;
		status = "ready";
	} catch {
		if (!untrack(() => picture)) status = "error";
	}
}

/** One read at a time; a read asked for while one is out runs once that one answers. */
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

async function loadStrip(): Promise<void> {
	const request = ++stripRequest;
	try {
		const result = await fetchArtifactHistory(artifactId, {
			limit: STRIP_PAGE_SIZE,
			conversationId,
		});
		if (request === stripRequest && result.ok) moments = result.moments;
	} catch {
		// The strip keeps what it showed; the next version asks again.
	}
}

function reload(): void {
	void load();
	void loadStrip();
}

// The body is mounted per item (DocumentWorkspace keys it), so this runs once.
$effect(() => {
	untrack(reload);
});

// F23: a newer version the page heard of (the poll's rows, any response that
// announced one) is read here too. Waits for the first load: before it there is
// nothing to be behind.
$effect(() => {
	const heard = versionNumber;
	if (status !== "ready" || heard === null || heard <= loadedVersion) return;
	untrack(reload);
});

function download(fileId: string): void {
	void startAuthenticatedDownload(
		imageFileUrl(fileId, { download: true, conversationId }),
	);
}

$effect(() => {
	const fileId = picture?.fileId ?? null;
	registerPanelActions?.({
		openDownload: fileId ? () => download(fileId) : undefined,
		// After a restore in History the stored picture is another one.
		reload,
	});
});

let canFlip = $derived(picture?.baseFileId != null);
</script>

<div class="image-body" data-testid="image-body">
	<div class="image-body-stage" use:pinchZoom={{ enabled: isPhone, resetKey: picture?.fileId ?? null }} data-testid="image-body-stage">
		{#if picture}
			<div
				class="image-body-frame"
				data-pinch-target
				style:--ratio={picture.width / picture.height}
				style:--natural-width="{picture.width}px"
				data-testid="image-body-frame"
			>
				<div class="image-body-picture" data-testid="image-body-picture">
					<ImagePicture
						fileId={picture.fileId}
						width={picture.width}
						height={picture.height}
						hasAlpha={picture.hasAlpha}
						alt={title}
						{conversationId}
						beforeFileId={picture.baseFileId}
						{showing}
						variant="original"
					/>
				</div>
			</div>
		{:else if status === 'error'}
			<p class="image-body-error" role="alert" data-testid="image-body-error">
				{$t('artifacts.image.panel.loadFailed')}
			</p>
		{/if}
	</div>

	<!-- One row under the picture: the strip, then the tools (Before / After; T6's
	     Mark). Reserved whatever it holds, so a version landing moves nothing, and
	     the only row, so the picture has the rest of the height in every shape. -->
	<div class="image-body-foot" data-testid="image-body-foot">
		<div class="image-body-strip">
			<VersionStrip {moments} {conversationId} {title} onOpenHistory={(versionId) => onOpenHistory?.(versionId)} {onAttachPicture} />
		</div>
		<div class="image-body-toolbar">
			{#if canFlip}
				<BeforeAfterSwitch
					{showing}
					onChange={(next) => (showing = next)}
					label={$t('artifacts.image.panel.compare')}
					size="md"
					testIdPrefix="image-body"
				/>
			{/if}
		</div>
	</div>
</div>

<style>
	.image-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		height: 100%;
		min-height: 0;
		padding: 0.75rem 1rem 1rem;
		box-sizing: border-box;
	}

	/* The stage is the space the picture may take; its size is the container the
	   picture's box is measured against (no script measures anything). */
	.image-body-stage {
		position: relative;
		display: grid;
		place-items: center;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		container-type: size;
	}

	/* The picture's own rectangle: its aspect ratio, as large as the stage allows
	   both ways, never past the picture's own width. Marks (T6) live inside it. */
	.image-body-frame {
		position: relative;
		width: min(100cqw, calc(100cqh * var(--ratio)), var(--natural-width));
		aspect-ratio: var(--ratio);
		border-radius: var(--radius-md);
		overflow: hidden;
		transform-origin: center;
		will-change: transform;
	}

	.image-body-picture,
	.image-body-picture :global(.image-picture) {
		width: 100%;
		height: 100%;
	}

	.image-body-error {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.875rem;
	}

	.image-body-foot {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: none;
		min-height: 3.5rem;
	}

	.image-body-strip {
		flex: 1 1 auto;
		min-width: 0;
	}

	.image-body-toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
	}
</style>
