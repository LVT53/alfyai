<script lang="ts">
import DocumentPreviewToolbar from "../../DocumentPreviewToolbar.svelte";

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

$effect(() => {
	const nextObjectUrl = URL.createObjectURL(blob);
	objectUrl = nextObjectUrl;

	return () => {
		URL.revokeObjectURL(nextObjectUrl);
		if (objectUrl === nextObjectUrl) {
			objectUrl = null;
		}
	};
});

function clampImageZoom(nextZoom: number): number {
	return Math.min(4, Math.max(0.5, Number.parseFloat(nextZoom.toFixed(2))));
}

function setZoomLevel(nextZoom: number) {
	zoom = clampImageZoom(nextZoom);
	if (zoom <= 1) {
		panX = 0;
		panY = 0;
	}
}

function zoomIn() {
	setZoomLevel(zoom + 0.25);
}

function zoomOut() {
	setZoomLevel(zoom - 0.25);
}

function fitImage() {
	zoom = 1;
	panX = 0;
	panY = 0;
	dragging = false;
}

function handleWheel(event: WheelEvent) {
	if (zoom <= 1 && !event.ctrlKey && !event.metaKey) return;
	event.preventDefault();
	setZoomLevel(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
}

function handlePointerDown(event: PointerEvent) {
	if (zoom <= 1) return;
	event.preventDefault();
	dragging = true;
	dragStartX = event.clientX;
	dragStartY = event.clientY;
	dragOriginX = panX;
	dragOriginY = panY;
	(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event: PointerEvent) {
	if (!dragging) return;
	event.preventDefault();
	panX = dragOriginX + event.clientX - dragStartX;
	panY = dragOriginY + event.clientY - dragStartY;
}

function handlePointerUp(event: PointerEvent) {
	dragging = false;
	(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
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
	onwheel={handleWheel}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={handlePointerUp}
>
	{#if objectUrl}
		<img
			src={objectUrl}
			{alt}
			class="image-preview-img"
			style:transform={`translate(${panX}px, ${panY}px) scale(${zoom})`}
		/>
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
</style>
