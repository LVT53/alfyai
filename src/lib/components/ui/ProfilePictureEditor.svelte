<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { fade, scale } from "svelte/transition";
import { uploadAvatar } from "$lib/client/api/settings";
import {
	Upload,
	Loader,
	RotateCcw,
	RotateCw,
	ZoomOut,
	ZoomIn,
} from "@lucide/svelte";

let {
	onClose = undefined,
	onUploaded = undefined,
}: {
	onClose?: (() => void) | undefined;
	onUploaded?: (() => void) | undefined;
} = $props();

// ── State ──────────────────────────────────────────────────────────────────
type Step = "drop" | "edit" | "uploading";
let step = $state<Step>("drop");

let fileInput = $state<HTMLInputElement | null>(null);
let canvasEl = $state<HTMLCanvasElement | null>(null);
let dialogRef = $state<HTMLDivElement | null>(null);
let previousFocus: HTMLElement | null = null;

let isDraggingOver = $state(false);
let uploadError = $state("");

// Image source
let img = $state<HTMLImageElement | null>(null);

// Editor state
let rotation = $state(0); // 0–360 degrees, arbitrary precision
let zoom = $state(1.0);
let panX = $state(0);
let panY = $state(0);

// Canvas dimensions (square crop area)
const CANVAS_SIZE = 320;
const PREVIEW_SIZE = 64;

// Drag tracking
let isDragging = $state(false);
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;

// Preview canvas
let previewCanvas = $state<HTMLCanvasElement | null>(null);

// ── Helpers ────────────────────────────────────────────────────────────────
function loadFile(file: File) {
	if (!file.type.startsWith("image/")) {
		uploadError = "Please select an image file.";
		return;
	}
	if (file.size > 20 * 1024 * 1024) {
		uploadError = "File is too large. Maximum size is 20MB.";
		return;
	}
	uploadError = "";

	const reader = new FileReader();
	reader.onload = (e) => {
		const src = e.target?.result as string;
		const image = new Image();
		image.onload = () => {
			img = image;
			// Reset editor state for new image
			rotation = 0;
			zoom = 1.0;
			panX = 0;
			panY = 0;
			step = "edit";
			setTimeout(drawCanvas, 0);
		};
		image.src = src;
	};
	reader.readAsDataURL(file);
}

// Compute the base scale so the image (at the given rotation) covers the W×H canvas.
function computeBaseScale(
	iw: number,
	ih: number,
	angleRad: number,
	W: number,
	H: number,
) {
	const cos = Math.abs(Math.cos(angleRad));
	const sin = Math.abs(Math.sin(angleRad));
	const bboxW = iw * cos + ih * sin || 1;
	const bboxH = iw * sin + ih * cos || 1;
	return Math.max(W / bboxW, H / bboxH);
}

function drawCanvas() {
	if (!canvasEl || !img) return;
	const ctx = canvasEl.getContext("2d");
	if (!ctx) return;

	const W = CANVAS_SIZE;
	const H = CANVAS_SIZE;
	ctx.clearRect(0, 0, W, H);

	const angleRad = (rotation * Math.PI) / 180;

	ctx.save();
	ctx.translate(W / 2 + panX, H / 2 + panY);
	ctx.rotate(angleRad);
	ctx.scale(zoom, zoom);

	const baseScale = computeBaseScale(
		img.naturalWidth,
		img.naturalHeight,
		angleRad,
		W,
		H,
	);
	const dw = img.naturalWidth * baseScale;
	const dh = img.naturalHeight * baseScale;
	ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
	ctx.restore();

	// Dimming mask outside crop circle (evenodd punches the circle out of the rect)
	ctx.save();
	ctx.fillStyle = "rgba(0,0,0,0.45)";
	ctx.beginPath();
	ctx.rect(0, 0, W, H);
	ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
	ctx.fill("evenodd");
	ctx.restore();

	// Crop circle border
	ctx.save();
	ctx.strokeStyle = "rgba(255,255,255,0.8)";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
	ctx.stroke();
	ctx.restore();

	drawPreview();
}

function drawPreview() {
	if (!previewCanvas || !img) return;
	const pctx = previewCanvas.getContext("2d");
	if (!pctx) return;

	const P = PREVIEW_SIZE;
	pctx.clearRect(0, 0, P, P);

	pctx.save();
	pctx.beginPath();
	pctx.arc(P / 2, P / 2, P / 2, 0, Math.PI * 2);
	pctx.clip();

	const ratio = P / CANVAS_SIZE;
	pctx.scale(ratio, ratio);
	pctx.drawImage(canvasEl, 0, 0);
	pctx.restore();
}

function rotateLeft() {
	rotation = (rotation - 90 + 360) % 360;
	drawCanvas();
}

function rotateRight() {
	rotation = (rotation + 90) % 360;
	drawCanvas();
}

function zoomOut() {
	zoom = Math.max(0.5, parseFloat((zoom - 0.1).toFixed(2)));
	drawCanvas();
}

function zoomIn() {
	zoom = Math.min(3, parseFloat((zoom + 0.1).toFixed(2)));
	drawCanvas();
}

$effect(() => {
	if (step !== "edit" || !canvasEl || !img) return;

	rotation;
	zoom;
	panX;
	panY;
	previewCanvas;

	drawCanvas();
});

// ── Canvas drag (pan) ──────────────────────────────────────────────────────
function onMouseDown(e: MouseEvent) {
	isDragging = true;
	dragStartX = e.clientX;
	dragStartY = e.clientY;
	dragStartPanX = panX;
	dragStartPanY = panY;
}

function onMouseMove(e: MouseEvent) {
	if (!isDragging) return;
	panX = dragStartPanX + (e.clientX - dragStartX);
	panY = dragStartPanY + (e.clientY - dragStartY);
	drawCanvas();
}

function onMouseUp() {
	isDragging = false;
}

function onTouchStart(e: TouchEvent) {
	const t = e.touches[0];
	isDragging = true;
	dragStartX = t.clientX;
	dragStartY = t.clientY;
	dragStartPanX = panX;
	dragStartPanY = panY;
}

function onTouchMove(e: TouchEvent) {
	if (!isDragging) return;
	e.preventDefault();
	const t = e.touches[0];
	panX = dragStartPanX + (t.clientX - dragStartX);
	panY = dragStartPanY + (t.clientY - dragStartY);
	drawCanvas();
}

function onTouchEnd() {
	isDragging = false;
}

function nonPassiveTouchMove(node: HTMLCanvasElement) {
	const handleTouchMove = (event: Event) => {
		onTouchMove(event as TouchEvent);
	};

	node.addEventListener("touchmove", handleTouchMove, { passive: false });

	return {
		destroy() {
			node.removeEventListener("touchmove", handleTouchMove);
		},
	};
}

// ── Upload (with compression pipeline) ─────────────────────────────────────
async function handleUpload() {
	if (!canvasEl || !img) return;
	step = "uploading";
	uploadError = "";

	// Draw final output to an offscreen 512×512 canvas (circle-cropped)
	const offscreen = document.createElement("canvas");
	offscreen.width = 512;
	offscreen.height = 512;
	const ctx = offscreen.getContext("2d");
	if (!ctx) {
		uploadError = "Failed to process image.";
		step = "edit";
		return;
	}

	const angleRad = (rotation * Math.PI) / 180;
	const ratio = 512 / CANVAS_SIZE;

	ctx.save();
	ctx.beginPath();
	ctx.arc(256, 256, 256, 0, Math.PI * 2);
	ctx.clip();

	ctx.translate(256 + panX * ratio, 256 + panY * ratio);
	ctx.rotate(angleRad);
	ctx.scale(zoom, zoom);

	const baseScale = computeBaseScale(
		img.naturalWidth,
		img.naturalHeight,
		angleRad,
		512,
		512,
	);
	const dw = img.naturalWidth * baseScale;
	const dh = img.naturalHeight * baseScale;
	ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
	ctx.restore();

	// Compress: export as WebP at quality 0.88 — regardless of input size,
	// the output is a 512×512 WebP which is typically 50–200 KB.
	offscreen.toBlob(
		async (blob) => {
			if (!blob) {
				uploadError = "Failed to process image.";
				step = "edit";
				return;
			}
			try {
				await uploadAvatar(blob);
				onUploaded?.();
				onClose?.();
			} catch (e: unknown) {
				uploadError =
					e instanceof Error ? e.message : "Failed to upload image.";
				step = "edit";
			}
		},
		"image/webp",
		0.88,
	);
}

// ── Drag-and-drop ──────────────────────────────────────────────────────────
function onDragOver(e: DragEvent) {
	e.preventDefault();
	isDraggingOver = true;
}

function onDragLeave() {
	isDraggingOver = false;
}

function onDrop(e: DragEvent) {
	e.preventDefault();
	isDraggingOver = false;
	const file = e.dataTransfer?.files[0];
	if (file) loadFile(file);
}

function onFileInput(e: Event) {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (file) loadFile(file);
}

function handleBackdropClick() {
	if (step !== "uploading") {
		onClose?.();
	}
}

function openSelectedFile() {
	fileInput?.click();
}

function handleDropZoneKeydown(event: KeyboardEvent) {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		openSelectedFile();
	}
}

function chooseDifferentImage() {
	step = "drop";
	img = null;
	if (fileInput) {
		fileInput.value = "";
	}
}

// ── Keyboard & focus ───────────────────────────────────────────────────────
function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		if (step !== "uploading") onClose?.();
	} else if (e.key === "Tab") {
		const focusable = dialogRef?.querySelectorAll<HTMLElement>(
			'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
		if (!focusable || focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey) {
			if (document.activeElement === first) {
				last.focus();
				e.preventDefault();
			}
		} else {
			if (document.activeElement === last) {
				first.focus();
				e.preventDefault();
			}
		}
	}
}

onMount(() => {
	previousFocus = document.activeElement as HTMLElement;
	document.body.style.overflow = "hidden";
});

onDestroy(() => {
	if (previousFocus) previousFocus.focus();
	document.body.style.overflow = "";
});
</script>

<svelte:window onkeydown={handleKeydown} onmouseup={onMouseUp} />

<div
	class="fixed inset-0 z-50 flex items-center justify-center p-md"
	transition:fade={{ duration: 150 }}
>
	<!-- Backdrop -->
	<button
		type="button"
		class="absolute inset-0 bg-surface-page opacity-80 backdrop-blur-sm"
		aria-label="Close profile photo editor"
		onclick={handleBackdropClick}
	></button>

	<!-- Modal -->
	<div
		bind:this={dialogRef}
		role="dialog"
		aria-modal="true"
		aria-labelledby="pic-editor-title"
		tabindex="-1"
		class="relative w-full max-w-[520px] rounded-lg border border-border bg-surface-page p-lg shadow-lg"
		transition:scale={{ duration: 150, start: 0.95 }}
	>
		<h2 id="pic-editor-title" class="mb-md text-xl font-semibold text-text-primary">
			Upload Profile Photo
		</h2>

		<!-- ── Step: Drop zone ───────────────────────────────────────────── -->
		{#if step === 'drop'}
			<div
				class="drop-zone flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed border-border p-10 text-center transition-colors duration-150"
				class:drop-zone-active={isDraggingOver}
				ondragover={onDragOver}
				ondragleave={onDragLeave}
				ondrop={onDrop}
				onclick={openSelectedFile}
				role="button"
				tabindex="0"
				onkeydown={handleDropZoneKeydown}
				aria-label="Upload photo drop zone"
			>
			<Upload class="text-icon-muted" size={40} strokeWidth={1.5} aria-hidden="true" />
				<p class="text-sm text-text-primary font-medium">Drop an image here, or click to select</p>
				<p class="text-xs text-text-muted">JPEG, PNG, WebP, GIF, HEIC, AVIF, BMP, TIFF · max 20 MB</p>
			</div>

			<input
				bind:this={fileInput}
				type="file"
				accept="image/*,.heic,.heif,.avif,.tiff,.tif,.bmp"
				class="sr-only"
				onchange={onFileInput}
			/>

			{#if uploadError}
				<p class="mt-sm text-sm text-danger" role="alert">{uploadError}</p>
			{/if}
		{/if}

		<!-- ── Step: Edit / Uploading ─────────────────────────────────────── -->
		{#if step === 'edit' || step === 'uploading'}
			<div class="flex flex-col items-center gap-md">
				<!-- Canvas editor -->
				<div class="relative" style="width: {CANVAS_SIZE}px; height: {CANVAS_SIZE}px;">
					<canvas
						bind:this={canvasEl}
						width={CANVAS_SIZE}
						height={CANVAS_SIZE}
						class="rounded-md"
						style="cursor: {isDragging ? 'grabbing' : 'grab'};"
						onmousedown={onMouseDown}
						onmousemove={onMouseMove}
						ontouchstart={onTouchStart}
						ontouchend={onTouchEnd}
						use:nonPassiveTouchMove
					></canvas>

					{#if step === 'uploading'}
						<div
							class="absolute inset-0 flex items-center justify-center rounded-md bg-surface-page/60 backdrop-blur-sm"
						>
						<Loader class="animate-spin text-accent" size={32} strokeWidth={2} aria-hidden="true" />
						</div>
					{/if}
				</div>

				<!-- ── Controls ──────────────────────────────────────────────── -->
				<div class="flex w-full flex-col gap-sm" style="max-width: {CANVAS_SIZE}px;">

					<!-- Rotation row -->
					<div class="flex items-center gap-xs">
						<!-- Rotate CCW 90° -->
						<button
							type="button"
							class="btn-icon-bare flex-shrink-0"
							onclick={rotateLeft}
							disabled={step === 'uploading'}
							title="Rotate left 90°"
							aria-label="Rotate left 90°"
						>
						<RotateCcw size={15} strokeWidth={2} aria-hidden="true" />
						</button>

						<!-- Precise rotation slider -->
						<input
							type="range"
							min="0"
							max="360"
							step="0.5"
							bind:value={rotation}
							oninput={drawCanvas}
							disabled={step === 'uploading'}
							class="rotation-slider flex-1"
							aria-label="Rotation"
						/>

						<!-- Rotate CW 90° -->
						<button
							type="button"
							class="btn-icon-bare flex-shrink-0"
							onclick={rotateRight}
							disabled={step === 'uploading'}
							title="Rotate right 90°"
							aria-label="Rotate right 90°"
						>
						<RotateCw size={15} strokeWidth={2} aria-hidden="true" />
						</button>

						<!-- Degree readout -->
						<span class="degree-readout w-14 flex-shrink-0 text-right text-xs text-text-muted tabular-nums">
							{rotation.toFixed(1)}°
						</span>
					</div>

					<!-- Zoom row -->
					<div class="flex items-center gap-xs">
						<!-- Zoom out -->
						<button
							type="button"
							class="btn-icon-bare flex-shrink-0"
							onclick={zoomOut}
							disabled={step === 'uploading' || zoom <= 0.5}
							title="Zoom out"
							aria-label="Zoom out"
						>
						<ZoomOut size={15} strokeWidth={2} aria-hidden="true" />
						</button>

						<!-- Zoom slider -->
						<input
							type="range"
							min="0.5"
							max="3"
							step="0.05"
							bind:value={zoom}
							oninput={drawCanvas}
							disabled={step === 'uploading'}
							class="zoom-slider flex-1"
							aria-label="Zoom"
						/>

						<!-- Zoom in -->
						<button
							type="button"
							class="btn-icon-bare flex-shrink-0"
							onclick={zoomIn}
							disabled={step === 'uploading' || zoom >= 3}
							title="Zoom in"
							aria-label="Zoom in"
						>
						<ZoomIn size={15} strokeWidth={2} aria-hidden="true" />
						</button>

						<!-- Zoom % readout -->
						<span class="degree-readout w-11 flex-shrink-0 text-right text-xs text-text-muted tabular-nums">
							{Math.round(zoom * 100)}%
						</span>

						<!-- Preview -->
						<div class="ml-1 flex flex-shrink-0 flex-col items-center gap-1">
							<canvas
								bind:this={previewCanvas}
								width={PREVIEW_SIZE}
								height={PREVIEW_SIZE}
								class="rounded-full border border-border"
								aria-label="Preview"
							></canvas>
							<span class="text-[10px] text-text-muted">Preview</span>
						</div>
					</div>
				</div>

				<!-- Choose different image — proper secondary button -->
				{#if step === 'edit'}
					<button
						type="button"
						class="btn-secondary text-xs"
						onclick={chooseDifferentImage}
					>
						Choose a different image
					</button>
				{/if}

				{#if uploadError}
					<p class="text-sm text-danger" role="alert">{uploadError}</p>
				{/if}
			</div>
		{/if}

		<!-- Footer -->
		<div class="mt-lg flex justify-end gap-md">
			<button
				type="button"
				class="btn-secondary"
				onclick={() => onClose?.()}
				disabled={step === 'uploading'}
			>
				Cancel
			</button>
			{#if step === 'edit'}
				<button type="button" class="btn-primary" onclick={handleUpload}>
					Upload
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.drop-zone {
		background: var(--surface-overlay);
	}
	.drop-zone-active {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-overlay));
	}

	/* Shared slider base styles */
	.rotation-slider,
	.zoom-slider {
		-webkit-appearance: none;
		appearance: none;
		height: 5px;
		border-radius: 3px;
		background: rgba(128, 128, 128, 0.28);
		outline: none;
		cursor: pointer;
	}
	.rotation-slider::-webkit-slider-runnable-track,
	.zoom-slider::-webkit-slider-runnable-track {
		height: 5px;
		border-radius: 3px;
		background: rgba(128, 128, 128, 0.28);
	}
	.rotation-slider::-webkit-slider-thumb,
	.zoom-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		margin-top: -5.5px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
	}
	.rotation-slider::-moz-range-track,
	.zoom-slider::-moz-range-track {
		height: 5px;
		border-radius: 3px;
		background: rgba(128, 128, 128, 0.28);
	}
	.rotation-slider::-moz-range-thumb,
	.zoom-slider::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		border: none;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
	}
	.rotation-slider:disabled,
	.zoom-slider:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.degree-readout {
		font-variant-numeric: tabular-nums;
	}
</style>
