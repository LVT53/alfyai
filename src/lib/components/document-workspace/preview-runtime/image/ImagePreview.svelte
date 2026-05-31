<script lang="ts">
import { untrack } from "svelte";
import { t } from "$lib/i18n";
import DocumentPreviewToolbar from "../../DocumentPreviewToolbar.svelte";

const MIN_IMAGE_ZOOM = 0.5;
const MAX_IMAGE_ZOOM = 3;

let {
	blob,
	filename,
	alt = filename,
}: {
	blob: Blob;
	filename: string;
	alt?: string;
} = $props();

let objectUrl = $state<string | null>(null);
let zoom = $state(1);
let panX = $state(0);
let panY = $state(0);
let dragStartX = $state(0);
let dragStartY = $state(0);
let dragOriginX = $state(0);
let dragOriginY = $state(0);
let dragging = $state(false);
let stageElement = $state<HTMLElement | null>(null);
let imageElement = $state<HTMLImageElement | null>(null);
let activePointerId = $state<number | null>(null);
let imageLoadFailed = $state(false);

$effect(() => {
	const nextObjectUrl = URL.createObjectURL(blob);
	objectUrl = nextObjectUrl;
	imageLoadFailed = false;
	untrack(fitImage);

	return () => {
		releaseActivePointerCapture();
		URL.revokeObjectURL(nextObjectUrl);
		if (objectUrl === nextObjectUrl) {
			objectUrl = null;
		}
	};
});

function clampImageZoom(nextZoom: number): number {
	return Math.min(
		MAX_IMAGE_ZOOM,
		Math.max(MIN_IMAGE_ZOOM, Number.parseFloat(nextZoom.toFixed(2))),
	);
}

function setZoomLevel(nextZoom: number) {
	zoom = clampImageZoom(nextZoom);
	if (zoom <= 1) {
		panX = 0;
		panY = 0;
		releaseActivePointerCapture();
	} else {
		applyPan(panX, panY);
	}
}

function zoomIn() {
	setZoomLevel(zoom + 0.25);
}

function zoomOut() {
	setZoomLevel(zoom - 0.25);
}

function fitImage() {
	releaseActivePointerCapture();
	zoom = 1;
	panX = 0;
	panY = 0;
	dragging = false;
}

function releaseActivePointerCapture(
	target: EventTarget | null = stageElement,
) {
	if (activePointerId === null) return;
	const element = target instanceof HTMLElement ? target : stageElement;
	try {
		element?.releasePointerCapture?.(activePointerId);
	} catch {
		// Pointer capture can already be gone after browser-driven cancellation.
	}
	activePointerId = null;
	dragging = false;
}

function getPanBounds(nextZoom = zoom): { x: number; y: number } | null {
	if (!stageElement || !imageElement) return null;
	const stageRect = stageElement.getBoundingClientRect();
	const imageWidth = imageElement.clientWidth || imageElement.naturalWidth;
	const imageHeight = imageElement.clientHeight || imageElement.naturalHeight;
	if (
		stageRect.width <= 0 ||
		stageRect.height <= 0 ||
		imageWidth <= 0 ||
		imageHeight <= 0
	) {
		return null;
	}

	return {
		x: Math.max(0, (imageWidth * nextZoom - stageRect.width) / 2),
		y: Math.max(0, (imageHeight * nextZoom - stageRect.height) / 2),
	};
}

function clampPanValue(value: number, bound: number): number {
	return Math.min(bound, Math.max(-bound, value));
}

function applyPan(nextPanX: number, nextPanY: number) {
	const bounds = getPanBounds();
	if (!bounds) {
		panX = 0;
		panY = 0;
		return;
	}
	panX = clampPanValue(nextPanX, bounds.x);
	panY = clampPanValue(nextPanY, bounds.y);
}

function handleWheel(event: WheelEvent) {
	if (zoom <= 1 && !event.ctrlKey && !event.metaKey) return;
	event.preventDefault();
	setZoomLevel(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
}

function handlePointerDown(event: PointerEvent) {
	if (zoom <= 1) return;
	event.preventDefault();
	releaseActivePointerCapture();
	dragging = true;
	dragStartX = event.clientX;
	dragStartY = event.clientY;
	dragOriginX = panX;
	dragOriginY = panY;
	activePointerId = event.pointerId;
	(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event: PointerEvent) {
	if (!dragging || activePointerId !== event.pointerId) return;
	event.preventDefault();
	applyPan(
		dragOriginX + event.clientX - dragStartX,
		dragOriginY + event.clientY - dragStartY,
	);
}

function handlePointerUp(event: PointerEvent) {
	if (activePointerId !== event.pointerId) return;
	releaseActivePointerCapture(event.currentTarget);
}

function handleImageError() {
	releaseActivePointerCapture();
	imageLoadFailed = true;
}
</script>

<DocumentPreviewToolbar
	{zoom}
	onZoomIn={zoomIn}
	onZoomOut={zoomOut}
	onResetZoom={fitImage}
	onFit={fitImage}
/>
<div
	class="image-preview-stage"
	class:image-preview-stage-pannable={zoom > 1}
	class:image-preview-stage-panning={dragging}
	data-testid="image-preview-stage"
	role="region"
	aria-label={`${filename} image preview`}
	bind:this={stageElement}
	onwheel={handleWheel}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerUp}
>
	{#if objectUrl && !imageLoadFailed}
		<img
			src={objectUrl}
			{alt}
			bind:this={imageElement}
			class="image-preview-img"
			style:transform={`translate(${panX}px, ${panY}px) scale(${zoom})`}
			onerror={handleImageError}
		/>
	{:else if imageLoadFailed}
		<div class="image-preview-error" role="alert">
			{$t('documentWorkspace.previewLoadFailed')}
		</div>
	{/if}
</div>

<style>
	.image-preview-stage {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 52vh;
		overflow: hidden;
		padding: 1rem;
		background: var(--surface-page);
		cursor: default;
		touch-action: pan-y;
	}

	.image-preview-stage-pannable {
		cursor: grab;
		touch-action: none;
	}

	.image-preview-stage-panning {
		cursor: grabbing;
		user-select: none;
	}

	.image-preview-img {
		display: block;
		max-width: 100%;
		max-height: 72vh;
		object-fit: contain;
		border-radius: 0.5rem;
		box-shadow: var(--shadow-md);
		transform-origin: center center;
		transition: transform var(--duration-fast) ease;
	}

	.image-preview-error {
		max-width: 32rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--surface-elevated);
		color: var(--text-secondary);
		font-size: 0.9rem;
		text-align: center;
	}
</style>
