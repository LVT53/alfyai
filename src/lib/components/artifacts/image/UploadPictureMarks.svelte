<script lang="ts">
// An uploaded photo open in the panel, with the Mark tool (design 5.7). The
// usual preview stays until Mark is on; then the photo is laid out as an Image's
// is, so `MarkLayer` lies on its own rectangle and every box is a fraction of it.
// The photo is never changed: the page holds the boxes and sends them with the
// next message.
import type { Snippet } from "svelte";
import { t } from "$lib/i18n";
import type { ImageMark } from "$lib/shared/artifacts/image-body";
import { MAX_MARKS } from "$lib/shared/artifacts/image-body";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import { markNoteKey } from "./mark-geometry";
import MarkLayer from "./MarkLayer.svelte";
import MarkNote from "./MarkNote.svelte";
import MarkTools from "./MarkTools.svelte";
import { pinchZoom } from "./pinch-zoom";

let {
	url,
	filename,
	marks,
	onChange,
	onContinue,
	preview,
}: {
	url: string;
	filename: string;
	marks: ImageMark[];
	onChange: (marks: ImageMark[]) => void;
	onContinue?: (() => void) | undefined;
	preview: Snippet;
} = $props();

let marking = $state(false);
let refused = $state(false);
let size = $state.raw<{ width: number; height: number } | null>(null);
let isPhone = $state(isPhoneViewport());

$effect(() => watchPhoneViewport((phone) => (isPhone = phone)));
$effect(() => {
	if (!marking || marks.length < MAX_MARKS) refused = false;
});

// Marks the page let go (sent, or the chip's x) switch Mark off, as on an Image.
let hadMarks = false;
let letGoHere = false;
$effect(() => {
	const has = marks.length > 0;
	if (hadMarks && !has && !letGoHere) marking = false;
	if (has || hadMarks) letGoHere = false;
	hadMarks = has;
});

function change(next: ImageMark[]): void {
	letGoHere = next.length === 0;
	onChange(next);
}

let showStage = $derived(marking || marks.length > 0);
let noteKey = $derived(
	markNoteKey({ refused, marking, count: marks.length, isPhone }),
);
let note = $derived(
	noteKey
		? $t(noteKey, { letters: marks.map((mark) => mark.letter).join(", ") })
		: "",
);
</script>

<div class="upload-marks" data-testid="upload-picture-marks">
	{#if showStage}
		<div class="upload-marks-stage" use:pinchZoom={{ enabled: isPhone, resetKey: url, doubleTapReset: !marking }}>
			<div
				class="upload-marks-frame"
				data-pinch-target
				data-testid="image-body-frame"
				style:--ratio={size ? size.width / size.height : 1.5}
				style:--natural-width={size ? `${size.width}px` : '100cqw'}
			>
				<img
					src={url}
					alt={filename}
					draggable="false"
					onload={(event) => {
						const image = event.currentTarget as HTMLImageElement;
						size = { width: image.naturalWidth, height: image.naturalHeight };
					}}
				/>
				<div class="upload-marks-layer">
					<MarkLayer {marks} active={marking} onChange={change} onRefused={() => (refused = true)} />
				</div>
			</div>
			<MarkNote text={note} />
		</div>
	{:else}
		<div class="upload-marks-preview">{@render preview()}</div>
	{/if}
	<div class="upload-marks-foot">
		<MarkTools
			{marking}
			canContinue={isPhone && marks.length > 0}
			onToggle={() => (marking = !marking)}
			{onContinue}
		/>
	</div>
</div>

<style>
	.upload-marks {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.upload-marks-preview {
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.upload-marks-stage {
		position: relative;
		display: grid;
		place-items: center;
		flex: 1 1 auto;
		min-height: 0;
		margin: var(--space-md) var(--space-md) 0;
		overflow: hidden;
		container-type: size;
	}

	.upload-marks-frame {
		position: relative;
		width: min(100cqw, calc(100cqh * var(--ratio)), var(--natural-width));
		aspect-ratio: var(--ratio);
		border-radius: var(--radius-md);
		overflow: hidden;
		transform-origin: center;
		will-change: transform;
	}

	.upload-marks-frame img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: fill;
		user-select: none;
	}

	.upload-marks-layer {
		position: absolute;
		inset: 0;
	}

	.upload-marks-foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex: 0 0 auto;
		gap: var(--space-sm);
		padding: var(--space-md);
	}
</style>
