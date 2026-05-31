<script lang="ts" module>
let pdfWorkerUrlPromise: Promise<string> | null = null;

async function loadPdfWorkerUrl() {
	if (!pdfWorkerUrlPromise) {
		pdfWorkerUrlPromise = import(
			"pdfjs-dist/build/pdf.worker.min.mjs?url"
		).then((module) => module.default);
	}

	return pdfWorkerUrlPromise;
}
</script>

<script lang="ts">
import { browser } from "$app/environment";
import { t } from "$lib/i18n";
import { tick } from "svelte";
import DocumentPreviewToolbar from "../../DocumentPreviewToolbar.svelte";

type PdfRenderTask = {
	promise: Promise<void>;
	cancel: () => void;
};

type PdfPageViewport = {
	width: number;
	height: number;
};

type PdfPageProxy = {
	getViewport: (options: { scale: number }) => PdfPageViewport;
	render: (options: {
		canvasContext: CanvasRenderingContext2D;
		viewport: PdfPageViewport;
		transform?: [number, number, number, number, number, number];
	}) => PdfRenderTask;
};

type PdfDocumentProxy = {
	numPages: number;
	getPage: (pageNumber: number) => Promise<PdfPageProxy>;
};

let {
	blob,
	filename = "PDF document",
	ariaLabel = null,
	currentPage = $bindable(1),
	totalPages = $bindable(0),
	onError,
}: {
	blob: Blob;
	filename?: string;
	ariaLabel?: string | null;
	currentPage?: number;
	totalPages?: number;
	onError?: (message: string) => void;
} = $props();

let pdfjsLib: typeof import("pdfjs-dist") | null = null;
let pdfDoc = $state<PdfDocumentProxy | null>(null);
let scrollContainerRef = $state<HTMLDivElement | null>(null);
let canvasRefs = $state<(HTMLCanvasElement | null)[]>([]);
let isRendering = $state(false);
let lastObservedPage = $state(1);
let zoom = $state(1.0);
let baseScale = $state(1.0);
let pdfDragging = $state(false);
let pdfDragStartX = $state(0);
let pdfDragStartY = $state(0);
let pdfDragOriginLeft = $state(0);
let pdfDragOriginTop = $state(0);

let pdfRenderVersion = 0;
let activeRenderTasks = new Map<number, PdfRenderTask>();
let pageObserver: IntersectionObserver | null = null;
let isProgrammaticScroll = $state(false);
let programmaticScrollResetTimeout: ReturnType<typeof setTimeout> | null = null;
let pinchZoomFrame: number | null = null;
let pendingPinchZoom = 1;

$effect(() => {
	const activeBlob = blob;
	void renderPdf(activeBlob);

	return () => {
		cancelActivePdfRenderTasks();
		pdfRenderVersion += 1;
	};
});

$effect(() => {
	if (
		browser &&
		scrollContainerRef &&
		canvasRefs.length > 0 &&
		currentPage !== lastObservedPage
	) {
		const targetPage = Math.max(1, Math.min(currentPage, totalPages));
		const canvas = canvasRefs[targetPage - 1];
		if (canvas?.parentElement) {
			if (programmaticScrollResetTimeout) {
				clearTimeout(programmaticScrollResetTimeout);
				programmaticScrollResetTimeout = null;
			}
			isProgrammaticScroll = true;
			canvas.parentElement.scrollIntoView?.({
				behavior: "auto",
				block: "start",
			});
			lastObservedPage = targetPage;
			programmaticScrollResetTimeout = setTimeout(() => {
				isProgrammaticScroll = false;
				programmaticScrollResetTimeout = null;
			}, 120);
		}
	}
});

$effect(() => {
	if (browser && scrollContainerRef && canvasRefs.length > 0) {
		setupPageObserver();
	}

	return () => {
		if (pageObserver) {
			pageObserver.disconnect();
			pageObserver = null;
		}
		if (programmaticScrollResetTimeout) {
			clearTimeout(programmaticScrollResetTimeout);
			programmaticScrollResetTimeout = null;
		}
		isProgrammaticScroll = false;
	};
});

$effect(() => {
	if (!(browser && scrollContainerRef)) {
		if (pinchZoomFrame !== null) {
			cancelAnimationFrame(pinchZoomFrame);
			pinchZoomFrame = null;
		}
		return;
	}

	const node = scrollContainerRef;
	let pinchActive = false;
	let pinchStartDistance = 0;
	let pinchStartZoom = zoom;

	const flushPendingPinchZoom = () => {
		pinchZoomFrame = null;
		setZoomLevel(pendingPinchZoom);
	};

	const stopPinch = () => {
		pinchActive = false;
		pinchStartDistance = 0;
		pinchStartZoom = zoom;
	};

	const handleTouchStart = (event: TouchEvent) => {
		if (event.touches.length !== 2) return;
		pinchActive = true;
		pinchStartDistance = getTouchDistance(event.touches);
		pinchStartZoom = zoom;
		if (pinchZoomFrame !== null) {
			cancelAnimationFrame(pinchZoomFrame);
			pinchZoomFrame = null;
		}
	};

	const handleTouchMove = (event: TouchEvent) => {
		if (!pinchActive || event.touches.length !== 2 || pinchStartDistance <= 0) {
			return;
		}

		event.preventDefault();
		pendingPinchZoom =
			pinchStartZoom * (getTouchDistance(event.touches) / pinchStartDistance);

		if (pinchZoomFrame === null) {
			pinchZoomFrame = requestAnimationFrame(flushPendingPinchZoom);
		}
	};

	const handleTouchEnd = (event: TouchEvent) => {
		if (event.touches.length < 2) {
			stopPinch();
		}
	};

	node.addEventListener("touchstart", handleTouchStart, { passive: true });
	node.addEventListener("touchmove", handleTouchMove, { passive: false });
	node.addEventListener("touchend", handleTouchEnd);
	node.addEventListener("touchcancel", handleTouchEnd);

	return () => {
		node.removeEventListener("touchstart", handleTouchStart);
		node.removeEventListener("touchmove", handleTouchMove);
		node.removeEventListener("touchend", handleTouchEnd);
		node.removeEventListener("touchcancel", handleTouchEnd);
		stopPinch();
		if (pinchZoomFrame !== null) {
			cancelAnimationFrame(pinchZoomFrame);
			pinchZoomFrame = null;
		}
	};
});

async function loadPdfjs() {
	if (!pdfjsLib) {
		pdfjsLib = await import("pdfjs-dist");
		pdfjsLib.GlobalWorkerOptions.workerSrc = await loadPdfWorkerUrl();
		pdfjsLib.setVerbosityLevel?.(pdfjsLib.VerbosityLevel.ERRORS);
	}

	return pdfjsLib;
}

async function renderPdf(nextBlob: Blob) {
	if (!browser) return;

	cancelActivePdfRenderTasks();
	pdfRenderVersion += 1;
	const currentVersion = pdfRenderVersion;

	pdfDoc = null;
	canvasRefs = [];
	currentPage = 1;
	totalPages = 0;
	lastObservedPage = 1;
	zoom = 1.0;
	baseScale = 1.0;
	pdfDragging = false;
	isRendering = true;

	try {
		const pdfjs = await loadPdfjs();
		if (pdfRenderVersion !== currentVersion) return;

		const arrayBuffer = await nextBlob.arrayBuffer();
		const verbosity = pdfjs.VerbosityLevel?.ERRORS;
		pdfDoc = await pdfjs.getDocument({
			data: arrayBuffer,
			...(verbosity !== undefined ? { verbosity } : {}),
		}).promise;
		totalPages = pdfDoc.numPages;
		canvasRefs = new Array(totalPages).fill(null);
		currentPage = 1;
		lastObservedPage = 1;

		if (pdfRenderVersion !== currentVersion) return;

		await tick();
		await new Promise((resolve) => requestAnimationFrame(resolve));
		if (pdfRenderVersion !== currentVersion) return;

		if (scrollContainerRef && totalPages > 0) {
			const page = await pdfDoc.getPage(1);
			const unscaledViewport = page.getViewport({ scale: 1.0 });
			const containerWidth = scrollContainerRef.clientWidth - 48;
			baseScale =
				containerWidth > 0 && unscaledViewport.width > 0
					? containerWidth / unscaledViewport.width
					: 1.0;
		}

		const firstCanvas = canvasRefs[0];
		if (firstCanvas) {
			await renderPage(1, zoom, firstCanvas, currentVersion);
		}
		if (pdfRenderVersion !== currentVersion) return;
		isRendering = false;
		void renderRemainingPages(2, zoom, currentVersion);
	} catch (err) {
		const message = "Failed to render PDF file";
		onError?.(message);
		console.error("PDF render error:", err);
	} finally {
		if (pdfRenderVersion === currentVersion) {
			isRendering = false;
		}
	}
}

function cancelActivePdfRenderTasks() {
	for (const task of activeRenderTasks.values()) {
		try {
			task.cancel();
		} catch {
			// Render tasks may already be settled by the time cleanup runs.
		}
	}
	activeRenderTasks.clear();
}

async function renderAllPages(zoomLevel = zoom) {
	if (!pdfDoc) return;

	cancelActivePdfRenderTasks();
	pdfRenderVersion += 1;
	const currentVersion = pdfRenderVersion;

	try {
		isRendering = true;
		for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
			if (pdfRenderVersion !== currentVersion) return;
			const canvas = canvasRefs[pageNumber - 1];
			if (canvas) {
				await renderPage(pageNumber, zoomLevel, canvas, currentVersion);
			}
		}
	} catch (err) {
		console.error("PDF pages render error:", err);
	} finally {
		if (pdfRenderVersion === currentVersion) {
			isRendering = false;
		}
	}
}

async function renderRemainingPages(
	startPage: number,
	zoomLevel: number,
	version: number,
) {
	if (!pdfDoc) return;

	for (let pageNumber = startPage; pageNumber <= totalPages; pageNumber += 1) {
		if (pdfRenderVersion !== version) return;
		const canvas = canvasRefs[pageNumber - 1];
		if (canvas) {
			await renderPage(pageNumber, zoomLevel, canvas, version);
		}
	}
}

async function renderPage(
	pageNumber: number,
	zoomLevel: number,
	canvas: HTMLCanvasElement,
	version: number,
) {
	if (!pdfDoc || pdfRenderVersion !== version) return;

	let renderTask: PdfRenderTask | null = null;

	try {
		const page = await pdfDoc.getPage(pageNumber);
		if (pdfRenderVersion !== version) return;

		const viewport = page.getViewport({ scale: baseScale * zoomLevel });
		const context = canvas.getContext("2d");
		if (!context) return;

		const outputScale = window.devicePixelRatio || 1;
		canvas.width = Math.floor(viewport.width * outputScale);
		canvas.height = Math.floor(viewport.height * outputScale);
		canvas.style.width = `${Math.floor(viewport.width)}px`;
		canvas.style.height = `${Math.floor(viewport.height)}px`;

		renderTask = page.render({
			canvasContext: context,
			viewport,
			transform:
				outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
		});
		activeRenderTasks.set(pageNumber, renderTask);

		await renderTask.promise;
	} catch (err) {
		if (
			err instanceof Error &&
			(err.name === "RenderingCancelledException" ||
				err.message.includes("cancelled"))
		) {
			return;
		}
		console.error("PDF page render error:", err);
	} finally {
		if (renderTask) {
			activeRenderTasks.delete(pageNumber);
		}
	}
}

function clampZoomLevel(nextZoom: number): number {
	return Math.min(3.0, Math.max(0.5, Number.parseFloat(nextZoom.toFixed(2))));
}

function setZoomLevel(nextZoom: number) {
	const clampedZoom = clampZoomLevel(nextZoom);
	if (Math.abs(clampedZoom - zoom) < 0.01) return;
	zoom = clampedZoom;
	void renderAllPages(clampedZoom);
}

function zoomIn() {
	setZoomLevel(zoom + 0.25);
}

function zoomOut() {
	setZoomLevel(zoom - 0.25);
}

function resetZoom() {
	setZoomLevel(1.0);
}

function getTouchDistance(touches: TouchList): number {
	if (touches.length < 2) return 0;
	const deltaX = touches[0].clientX - touches[1].clientX;
	const deltaY = touches[0].clientY - touches[1].clientY;
	return Math.hypot(deltaX, deltaY);
}

function clampPdfScrollTop(nextScrollTop: number): number {
	if (!scrollContainerRef) return nextScrollTop;
	const maxScrollTop = Math.max(
		0,
		scrollContainerRef.scrollHeight - scrollContainerRef.clientHeight,
	);
	return Math.min(maxScrollTop, Math.max(0, nextScrollTop));
}

function clampPdfScrollLeft(nextScrollLeft: number): number {
	if (!scrollContainerRef) return nextScrollLeft;
	const maxScrollLeft = Math.max(
		0,
		scrollContainerRef.scrollWidth - scrollContainerRef.clientWidth,
	);
	return Math.min(maxScrollLeft, Math.max(0, nextScrollLeft));
}

function scrollPdfBy(deltaX: number, deltaY: number) {
	if (!scrollContainerRef || (deltaX === 0 && deltaY === 0)) return;
	scrollContainerRef.scrollLeft = clampPdfScrollLeft(
		scrollContainerRef.scrollLeft + deltaX,
	);
	scrollContainerRef.scrollTop = clampPdfScrollTop(
		scrollContainerRef.scrollTop + deltaY,
	);
}

function handlePdfWheel(event: WheelEvent) {
	if (!scrollContainerRef) return;
	if (event.ctrlKey || event.metaKey) {
		event.preventDefault();
		setZoomLevel(zoom + (event.deltaY < 0 ? 0.12 : -0.12));
	}
}

function handlePdfScrollKeydown(event: KeyboardEvent) {
	if (!scrollContainerRef) return;
	const pageStep = Math.max(120, scrollContainerRef.clientHeight * 0.86);
	const keyDeltas: Record<string, number> = {
		ArrowDown: 48,
		ArrowUp: -48,
		PageDown: pageStep,
		PageUp: -pageStep,
	};

	if (event.key === "Home") {
		event.preventDefault();
		scrollContainerRef.scrollTop = 0;
		return;
	}
	if (event.key === "End") {
		event.preventDefault();
		scrollContainerRef.scrollTop = clampPdfScrollTop(Number.POSITIVE_INFINITY);
		return;
	}

	const delta = keyDeltas[event.key];
	if (delta === undefined) return;
	event.preventDefault();
	scrollPdfBy(0, delta);
}

function handlePdfPointerDown(event: PointerEvent) {
	if (!scrollContainerRef || zoom <= 1) return;
	event.preventDefault();
	pdfDragging = true;
	pdfDragStartX = event.clientX;
	pdfDragStartY = event.clientY;
	pdfDragOriginLeft = scrollContainerRef.scrollLeft;
	pdfDragOriginTop = scrollContainerRef.scrollTop;
	(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function handlePdfPointerMove(event: PointerEvent) {
	if (!scrollContainerRef || !pdfDragging) return;
	event.preventDefault();
	scrollContainerRef.scrollLeft = clampPdfScrollLeft(
		pdfDragOriginLeft + pdfDragStartX - event.clientX,
	);
	scrollContainerRef.scrollTop = clampPdfScrollTop(
		pdfDragOriginTop + pdfDragStartY - event.clientY,
	);
}

function handlePdfPointerUp(event: PointerEvent) {
	pdfDragging = false;
	(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
}

function setupPageObserver() {
	if (!scrollContainerRef || !browser) return;

	if (pageObserver) {
		pageObserver.disconnect();
	}

	pageObserver = new IntersectionObserver(
		(entries) => {
			if (isProgrammaticScroll) return;

			let mostVisiblePage = 1;
			let maxVisibility = 0;

			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const pageNumber = Number.parseInt(
					(entry.target as HTMLElement).dataset.pageNum ?? "1",
					10,
				);
				if (entry.intersectionRatio > maxVisibility) {
					maxVisibility = entry.intersectionRatio;
					mostVisiblePage = pageNumber;
				}
			}

			if (maxVisibility > 0 && currentPage !== mostVisiblePage) {
				lastObservedPage = mostVisiblePage;
				currentPage = mostVisiblePage;
			}
		},
		{
			root: scrollContainerRef,
			threshold: [0, 0.25, 0.5, 0.75, 1.0],
		},
	);

	canvasRefs.forEach((canvas, index) => {
		const container = canvas?.parentElement;
		if (!container) return;
		container.dataset.pageNum = String(index + 1);
		pageObserver?.observe(container);
	});
}
</script>

<div class="pdf-viewer" data-testid="pdf-preview" aria-label={filename}>
	{#if totalPages > 0}
		<DocumentPreviewToolbar
			pageKind="page"
			bind:currentPage
			{totalPages}
			{zoom}
			onZoomIn={zoomIn}
			onZoomOut={zoomOut}
			onResetZoom={resetZoom}
		/>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
	<div
		class="pdf-canvas-container"
		class:pdf-canvas-container-pannable={zoom > 1}
		class:pdf-canvas-container-panning={pdfDragging}
		bind:this={scrollContainerRef}
		role="region"
		tabindex="0"
		aria-label={ariaLabel ?? $t("filePreview.pdfPagesRegion")}
		data-testid="pdf-scroll-region"
		onwheel={handlePdfWheel}
		onkeydown={handlePdfScrollKeydown}
		onpointerdown={handlePdfPointerDown}
		onpointermove={handlePdfPointerMove}
		onpointerup={handlePdfPointerUp}
		onpointercancel={handlePdfPointerUp}
	>
		{#if isRendering}
			<div class="pdf-rendering-overlay">
				<div class="spinner-sm"></div>
			</div>
		{/if}
		<div class="pdf-pages-scroll">
			{#if pdfDoc && totalPages > 0}
				{#each Array(totalPages) as _, i}
					<div class="pdf-page-wrapper">
						<canvas
							bind:this={canvasRefs[i]}
							class="pdf-canvas"
							data-page={i + 1}
						></canvas>
					</div>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.pdf-viewer {
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		flex-direction: column;
		background: var(--surface-page);
	}

	.pdf-canvas-container {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		width: 100%;
		flex-direction: column;
		align-items: stretch;
		overflow: auto;
		padding: 1rem;
		overscroll-behavior: auto;
		-webkit-overflow-scrolling: touch;
		touch-action: pan-y;
	}

	.pdf-canvas-container:focus {
		outline: none;
	}

	.pdf-canvas-container:focus-visible {
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--focus-ring) 74%, transparent 26%);
	}

	.pdf-canvas-container-pannable {
		cursor: grab;
		touch-action: none;
	}

	.pdf-canvas-container-panning {
		cursor: grabbing;
		user-select: none;
	}

	.pdf-pages-scroll {
		display: flex;
		width: 100%;
		flex-direction: column;
		align-items: center;
		gap: 1.5rem;
	}

	.pdf-page-wrapper {
		display: flex;
		width: fit-content;
		min-width: 100%;
		justify-content: center;
		scroll-margin-top: var(--preview-toolbar-jump-offset);
	}

	.pdf-canvas {
		display: block;
		width: auto;
		height: auto;
		max-width: none;
		background: white;
		box-shadow: 0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -1px rgb(0 0 0 / 6%);
	}

	.pdf-rendering-overlay {
		position: absolute;
		z-index: 10;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(255 255 255 / 80%);
	}

	.spinner-sm {
		width: 24px;
		height: 24px;
		border: 2px solid color-mix(in srgb, var(--border-default) 50%, transparent);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
