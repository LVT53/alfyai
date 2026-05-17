<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import type { CampaignAssetCropGeometry, CampaignAssetVariant } from '$lib/client/api/campaign-assets';
	import { t } from '$lib/i18n';

	type SavePayload = {
		file: File;
		width: number;
		height: number;
		crop: CampaignAssetCropGeometry;
	};

	let {
		imageSrc,
		ratio,
		variant = 'desktop',
		title = undefined,
		outputWidth,
		outputHeight,
		onSave,
		onCancel,
	}: {
		imageSrc: string;
		ratio: number;
		variant?: CampaignAssetVariant;
		title?: string;
		outputWidth?: number;
		outputHeight?: number;
		onSave?: (payload: SavePayload) => void | Promise<void>;
		onCancel?: () => void;
	} = $props();

	const FRAME_LONG_EDGE = 520;
	const MIN_ZOOM = 1;
	const MAX_ZOOM = 3;

	let dialogRef = $state<HTMLDivElement | null>(null);
	let imageEl = $state<HTMLImageElement | null>(null);
	let previewCanvas = $state<HTMLCanvasElement | null>(null);
	let previousFocus: HTMLElement | null = null;

	let naturalWidth = $state(0);
	let naturalHeight = $state(0);
	let imageReady = $state(false);
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isDragging = $state(false);
	let isSaving = $state(false);
	let errorMessage = $state('');

	let dragStartX = 0;
	let dragStartY = 0;
	let dragStartPanX = 0;
	let dragStartPanY = 0;

	let frameWidth = $derived(ratio >= 1 ? FRAME_LONG_EDGE : Math.round(FRAME_LONG_EDGE * ratio));
	let frameHeight = $derived(ratio >= 1 ? Math.round(FRAME_LONG_EDGE / ratio) : FRAME_LONG_EDGE);
	let dialogTitle = $derived(title ?? $t('campaignCrop.title'));
	let cropMetadata = $derived(
		variant === 'desktop' ? $t('campaignCrop.desktopMetadata') : $t('campaignCrop.mobileMetadata'),
	);
	let defaultOutputWidth = $derived(variant === 'mobile' ? 1080 : 1600);
	let finalOutputWidth = $derived(outputWidth ?? defaultOutputWidth);
	let finalOutputHeight = $derived(outputHeight ?? Math.round(finalOutputWidth / ratio));
	let baseScale = $derived(
		naturalWidth > 0 && naturalHeight > 0
			? Math.max(frameWidth / naturalWidth, frameHeight / naturalHeight)
			: 1,
	);
	let displayWidth = $derived(naturalWidth * baseScale * zoom);
	let displayHeight = $derived(naturalHeight * baseScale * zoom);

	function resetCrop() {
		zoom = 1;
		panX = 0;
		panY = 0;
		errorMessage = '';
		drawPreview();
	}

	function handleImageLoad(event: Event) {
		const image = event.currentTarget as HTMLImageElement;
		naturalWidth = image.naturalWidth;
		naturalHeight = image.naturalHeight;
		imageReady = naturalWidth > 0 && naturalHeight > 0;
		resetCrop();
	}

	function clampCrop(value: number, min: number, max: number) {
		return Math.min(Math.max(value, min), max);
	}

	function currentCrop(): CampaignAssetCropGeometry {
		const scale = baseScale * zoom || 1;
		const left = frameWidth / 2 + panX - displayWidth / 2;
		const top = frameHeight / 2 + panY - displayHeight / 2;
		const x = clampCrop((0 - left) / scale, 0, naturalWidth);
		const y = clampCrop((0 - top) / scale, 0, naturalHeight);
		const width = clampCrop(frameWidth / scale, 0, naturalWidth - x);
		const height = clampCrop(frameHeight / scale, 0, naturalHeight - y);

		return {
			x,
			y,
			width,
			height,
			zoom,
		};
	}

	function drawPreview() {
		if (!previewCanvas || !imageEl || !imageReady) return;
		const ctx = previewCanvas.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, finalOutputWidth, finalOutputHeight);
		ctx.drawImage(imageEl, currentCrop().x, currentCrop().y, currentCrop().width, currentCrop().height, 0, 0, finalOutputWidth, finalOutputHeight);
	}

	$effect(() => {
		zoom;
		panX;
		panY;
		imageReady;
		drawPreview();
	});

	function handlePointerDown(event: PointerEvent) {
		if (!imageReady || isSaving) return;
		isDragging = true;
		dragStartX = event.clientX;
		dragStartY = event.clientY;
		dragStartPanX = panX;
		dragStartPanY = panY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!isDragging || isSaving) return;
		panX = dragStartPanX + event.clientX - dragStartX;
		panY = dragStartPanY + event.clientY - dragStartY;
	}

	function handlePointerUp(event: PointerEvent) {
		isDragging = false;
		(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
	}

	function handleZoomInput(event: Event) {
		zoom = Number((event.currentTarget as HTMLInputElement).value);
	}

	async function saveCrop() {
		if (!imageEl || !imageReady || isSaving) return;
		isSaving = true;
		errorMessage = '';

		const canvas = document.createElement('canvas');
		canvas.width = finalOutputWidth;
		canvas.height = finalOutputHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			errorMessage = $t('campaignCrop.prepareError');
			isSaving = false;
			return;
		}

		const crop = currentCrop();
		ctx.drawImage(imageEl, crop.x, crop.y, crop.width, crop.height, 0, 0, finalOutputWidth, finalOutputHeight);

		canvas.toBlob(
			async (blob) => {
				if (!blob) {
					errorMessage = $t('campaignCrop.prepareError');
					isSaving = false;
					return;
				}

				try {
					await onSave?.({
						file: new File([blob], `${variant}-campaign-crop.webp`, { type: 'image/webp' }),
						width: finalOutputWidth,
						height: finalOutputHeight,
						crop,
					});
					isSaving = false;
				} catch (error) {
					errorMessage = error instanceof Error ? error.message : $t('campaignCrop.saveError');
					isSaving = false;
				}
			},
			'image/webp',
			0.9,
		);
	}

	function handleBackdropClick() {
		if (!isSaving) onCancel?.();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !isSaving) {
			event.preventDefault();
			onCancel?.();
			return;
		}
		if (event.key !== 'Tab') return;

		const focusable = dialogRef?.querySelectorAll<HTMLElement>(
			'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
		if (!focusable || focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			last.focus();
			event.preventDefault();
		} else if (!event.shiftKey && document.activeElement === last) {
			first.focus();
			event.preventDefault();
		}
	}

	onMount(() => {
		previousFocus = document.activeElement as HTMLElement;
		setTimeout(() => dialogRef?.focus({ preventScroll: true }), 0);
	});

	onDestroy(() => {
		previousFocus?.focus({ preventScroll: true });
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex h-[100dvh] items-start justify-center overflow-y-auto overscroll-contain p-sm sm:items-center sm:p-md" transition:fade={{ duration: 120 }}>
	<button
		type="button"
		class="absolute inset-0 cursor-pointer bg-surface-page opacity-80 backdrop-blur-sm"
		aria-label={$t('campaignCrop.backdropClose')}
		onclick={handleBackdropClick}
	></button>

	<div
		bind:this={dialogRef}
		role="dialog"
		aria-modal="true"
		aria-labelledby="campaign-crop-title"
		tabindex="-1"
		class="relative my-sm flex max-h-[calc(100dvh-1rem)] w-full max-w-[920px] flex-col gap-md overflow-y-auto rounded-lg border border-border bg-surface-page p-md shadow-lg outline-none sm:my-md sm:max-h-[calc(100dvh-2rem)]"
		transition:scale={{ duration: 120, start: 0.96 }}
	>
		<div class="flex items-start justify-between gap-md">
			<div>
				<h2 id="campaign-crop-title" class="text-lg font-semibold text-text-primary">{dialogTitle}</h2>
				<p class="mt-1 text-xs text-text-muted">{cropMetadata}</p>
			</div>
			<button
				type="button"
				class="btn-icon-bare cursor-pointer"
				aria-label={$t('common.close')}
				title={$t('common.close')}
				disabled={isSaving}
				onclick={() => onCancel?.()}
			>
				×
			</button>
		</div>

		<div class="grid min-h-0 gap-md md:grid-cols-[minmax(0,1fr)_152px]">
			<div class="min-w-0">
				<div
					class="crop-frame relative mx-auto overflow-hidden rounded-md border border-border bg-surface-overlay"
					style={`width: min(100%, ${frameWidth}px); aspect-ratio: ${ratio}; --crop-ratio: ${ratio}; --crop-frame-width: ${frameWidth}px; --crop-frame-height: ${frameHeight}px; cursor: ${isDragging ? 'grabbing' : 'grab'};`}
					onpointerdown={handlePointerDown}
					onpointermove={handlePointerMove}
					onpointerup={handlePointerUp}
					onpointercancel={handlePointerUp}
					role="application"
					aria-label={$t('campaignCrop.cropAreaLabel')}
				>
					<img
						bind:this={imageEl}
						src={imageSrc}
						alt=""
						crossorigin="anonymous"
						draggable="false"
						class="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
						style={`width: ${displayWidth}px; height: ${displayHeight}px; transform: translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px));`}
						onload={handleImageLoad}
					/>
					<div class="pointer-events-none absolute inset-0 border border-white/70"></div>
					<div class="pointer-events-none absolute inset-0 crop-grid"></div>
				</div>
			</div>

			<div class="flex flex-col gap-sm">
				<div class="rounded-md border border-border bg-surface-overlay p-sm">
					<canvas
						bind:this={previewCanvas}
						width={finalOutputWidth}
						height={finalOutputHeight}
						class="block w-full rounded border border-border bg-surface-page"
						aria-label={$t('campaignCrop.previewLabel')}
					></canvas>
				</div>
				<div class="text-xs text-text-muted">
					{finalOutputWidth} × {finalOutputHeight}
				</div>
			</div>
		</div>

		<div class="flex flex-col gap-xs">
			<div class="flex items-center justify-between gap-md">
				<label for="campaign-crop-zoom" class="text-sm font-medium text-text-primary">{$t('campaignCrop.zoom')}</label>
				<span class="w-12 text-right text-xs tabular-nums text-text-muted">{Math.round(zoom * 100)}%</span>
			</div>
			<input
				id="campaign-crop-zoom"
				type="range"
				min={MIN_ZOOM}
				max={MAX_ZOOM}
				step="0.01"
				value={zoom}
				disabled={!imageReady || isSaving}
				class="crop-slider"
				aria-label={$t('campaignCrop.zoom')}
				oninput={handleZoomInput}
			/>
		</div>

		{#if errorMessage}
			<p class="text-sm text-danger" role="alert">{errorMessage}</p>
		{/if}

		<div class="-mx-md -mb-md flex flex-wrap justify-between gap-sm border-t border-border bg-surface-page/95 px-md py-md backdrop-blur">
			<button type="button" class="btn-secondary cursor-pointer" disabled={!imageReady || isSaving} onclick={resetCrop}>
				{$t('campaignCrop.reset')}
			</button>
			<div class="flex gap-sm">
				<button type="button" class="btn-secondary cursor-pointer" disabled={isSaving} onclick={() => onCancel?.()}>
					{$t('common.cancel')}
				</button>
				<button type="button" class="btn-primary cursor-pointer" disabled={!imageReady || isSaving} onclick={saveCrop}>
					{isSaving ? $t('common.saving') : $t('campaignCrop.save')}
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.crop-frame:focus-visible,
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.crop-grid {
		background-image:
			linear-gradient(to right, rgba(255, 255, 255, 0.42) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(255, 255, 255, 0.42) 1px, transparent 1px);
		background-size: 33.333% 33.333%;
	}

	@media (max-width: 640px) {
		.crop-frame {
			max-height: min(58dvh, var(--crop-frame-height));
			width: min(100%, var(--crop-frame-width), calc(min(58dvh, var(--crop-frame-height)) * var(--crop-ratio))) !important;
		}
	}

	.crop-slider {
		-webkit-appearance: none;
		appearance: none;
		height: 5px;
		border-radius: 3px;
		background: rgba(128, 128, 128, 0.28);
		cursor: pointer;
	}

	.crop-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 16px;
		height: 16px;
		border-radius: 999px;
		background: var(--accent);
		cursor: pointer;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
	}

	.crop-slider::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border: none;
		border-radius: 999px;
		background: var(--accent);
		cursor: pointer;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
	}

	.crop-slider:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}
</style>
