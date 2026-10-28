<script lang="ts">
// The Image kind's body in the family's panel (plan 2b T3, design 5.6): the
// picture large and, in one row below it, the strip of its versions and the
// tools (Before / After, Mark). It is a body like the Document's, inside `DocumentWorkspace`:
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
//
// Mark (T6): with Mark on, one pointer draws lettered boxes on the picture
// (`MarkLayer`, in the picture's own rectangle, so they zoom with it). The page
// holds them (`marks`, `onMarksChange`) and sends them with the next message as
// one chip; a newer picture under them lets them go. Mark is off while Before
// shows: the marks belong to the picture, not to the one it was made from.
import SquareDashed from "@lucide/svelte/icons/square-dashed";
import { untrack } from "svelte";
import { fetchArtifact, fetchArtifactHistory } from "$lib/client/api/artifacts";
import { imageFileUrl } from "$lib/client/api/images";
import { startAuthenticatedDownload } from "$lib/client/downloads";
import { t } from "$lib/i18n";
import type { ArtifactMoment } from "$lib/shared/artifacts/history";
import {
	type ImageMark,
	type ImageVersionBody,
	MAX_MARKS,
	parseImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import type { ArtifactBodyProps } from "../artifact-bodies";
import BeforeAfterSwitch from "./BeforeAfterSwitch.svelte";
import ImagePicture from "./ImagePicture.svelte";
import MarkLayer from "./MarkLayer.svelte";
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
	marks = null,
	onMarksChange,
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

let marking = $state(false);
/** A ninth box was drawn: "Up to 8 marks" shows until a box goes or Mark is off. */
let refused = $state(false);
let canMark = $derived(Boolean(onMarksChange) && picture !== null);

$effect(() => {
	if (showing === "before") marking = false;
});
$effect(() => {
	if (!marking || shownMarks.length < MAX_MARKS) refused = false;
});

function changeMarks(next: ImageMark[]): void {
	const fileId = picture?.fileId;
	if (!fileId) return;
	// Set for this let-go only: a box drawn after it clears it, so a let-go the
	// page did not answer never leaves Mark on after a later send.
	letGoHere = next.length === 0;
	onMarksChange?.(
		next.length > 0 ? { imageFileId: fileId, marks: next } : null,
	);
}

// Marks the page lets go (the message they went with was sent or queued, or the
// chip's x) switch Mark off: an armed tool after a send drew a new box on the
// next drag (Task 17). A let-go of the body's own (its last box removed, or
// marks on another file) leaves the tool as it is.
let letGoHere = false;
let hadMarks = false;
$effect(() => {
	const has = marks != null;
	if (hadMarks && !has && !letGoHere) untrack(() => (marking = false));
	if (has || hadMarks) letGoHere = false;
	hadMarks = has;
});

// The marks belong to the file they were drawn on, and show only on it. Marks
// on another file (a newer picture landed under them, or a restored turn's
// marks on an older version) are never drawn here and go, chip and all.
let shownMarks = $derived(
	marks && picture && marks.imageFileId === picture.fileId ? marks.marks : [],
);
$effect(() => {
	const fileId = picture?.fileId ?? null;
	const markedOn = marks?.imageFileId ?? null;
	if (status !== "ready" || !fileId || !markedOn || markedOn === fileId) return;
	letGoHere = true;
	untrack(() => onMarksChange?.(null));
});

let markNote = $derived(
	refused
		? $t("artifacts.image.panel.tooManyMarks")
		: marking
			? $t("artifacts.image.panel.markHint")
			: "",
);
</script>

<div class="image-body" data-testid="image-body">
	<div class="image-body-stage" use:pinchZoom={{ enabled: isPhone, resetKey: picture?.fileId ?? null, doubleTapReset: !marking }} data-testid="image-body-stage">
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
				{#if onMarksChange}
					<div class="image-body-marks" class:is-hidden={showing === 'before'} inert={showing === 'before'}>
						<MarkLayer
							marks={shownMarks}
							active={marking && showing === 'after'}
							onChange={changeMarks}
							onRefused={() => (refused = true)}
						/>
					</div>
				{/if}
			</div>
		{#if canMark}
			<!-- Over the stage, outside the zoomed picture, so it never scales. -->
			<p class="image-body-mark-note" class:is-shown={markNote !== ''} role="status" data-testid="image-body-mark-note">
				{markNote}
			</p>
		{/if}
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
			{#if canMark}
				<button
					type="button"
					class="image-body-mark"
					aria-pressed={marking}
					aria-label={$t('artifacts.image.panel.mark')}
					title={$t('artifacts.image.panel.mark')}
					disabled={showing === 'before'}
					data-testid="image-body-mark"
					onclick={() => (marking = !marking)}
				>
					<SquareDashed size={16} strokeWidth={2} aria-hidden="true" />
					<span class="image-body-mark-label">{$t('artifacts.image.panel.mark')}</span>
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.image-body {
		display: flex;
		flex-direction: column;
		/* The family's room (Task 12): expanded, the picture used to stand 12 px
		   under the header and over its row; a space-md all round keeps it clear of
		   both in every shape, docked beside an open sidebar included. */
		gap: var(--space-md);
		height: 100%;
		min-height: 0;
		padding: var(--space-md);
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

	/* The marks lie on the picture's own rectangle; while Before shows they are
	   not on the picture shown, so they fade out (opacity only). */
	.image-body-marks {
		position: absolute;
		inset: 0;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.image-body-marks.is-hidden {
		opacity: 0;
	}

	.image-body-mark-note {
		position: absolute;
		top: var(--space-sm);
		left: 50%;
		z-index: 1;
		margin: 0;
		max-width: calc(100% - 2 * var(--space-md));
		padding: var(--space-xs) var(--space-md);
		border-radius: 999px;
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		opacity: 0;
		transform: translateX(-50%);
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.image-body-mark-note.is-shown {
		opacity: 1;
	}

	.image-body-mark {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		min-height: 2.25rem;
		padding: 0 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
	}

	.image-body-mark[aria-pressed='true'] {
		border-color: var(--text-primary);
		background: var(--text-primary);
		color: var(--surface-page);
	}

	.image-body-mark:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.image-body-mark:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* A phone's row holds the strip, Before / After and Mark at 360 px: Mark is
	   its icon there (named for a screen reader), a 44 px target. */
	@media (hover: none) and (pointer: coarse) {
		.image-body-mark {
			min-width: 44px;
			min-height: 44px;
			justify-content: center;
			padding: 0;
		}

		.image-body-mark-label {
			display: none;
		}
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
		gap: var(--space-md);
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
		gap: var(--space-sm);
		flex: none;
	}
</style>
