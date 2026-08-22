<script lang="ts">
import { blockRenderer, type DisplayBlock } from "./block-render-registry";
import ImageLightbox from "./ImageLightbox.svelte";
import {
	collectSourceReferenceCandidates,
	parseMarkdownBlocks,
	prepareCodeHighlighting,
	renderCodeBlock,
	renderMarkdown,
} from "$lib/utils/markdown-loader";
import {
	deriveBalancedColumnWidths,
	getTableColumnCount,
	hasExtremeUnbreakableContent,
	resolveTableOverflowMode,
} from "$lib/services/table-layout";
import type { SourceReferenceCandidate } from "$lib/services/markdown";
import {
	SOURCE_TOOLTIP_MARGIN,
	SOURCE_TOOLTIP_OFFSET,
	clamp,
	computeTooltipBoundary,
	computeTooltipPlacement,
	resolveTooltipMaxWidth,
} from "$lib/utils/tooltip-placement";
import { shouldAnimateWords, wrapNewWords } from "./stream-word-wrap";
import { onMount, tick } from "svelte";

let {
	content = "",
	isDark = false,
	isStreaming = false,
	compactExternalLinks = false,
}: {
	content?: string;
	isDark?: boolean;
	isStreaming?: boolean;
	compactExternalLinks?: boolean;
} = $props();

// Display blocks are the render-ready output of the A3 block model: the typed
// blocks from parseMarkdownBlocks, each dispatched through the render registry
// (block-render-registry.ts) — component lanes (code, checklist, chart, csv,
// mermaid) instantiate their component; the prose lane renders sanitized {@html}.
type MarkdownBlock = DisplayBlock;
type SourceLinkTooltip = {
	sourceName: string;
	url: string;
	left: number;
	top: number;
	maxWidth: number;
	placement: "top" | "bottom";
	ready: boolean;
};

let blocks = $state<MarkdownBlock[]>([]);
let prevBlockCount = 0;
let container = $state<HTMLDivElement | null>(null);
// Lightbox state: the navigable set of embedded content images in this
// message, and which one (if any) is open. See openImageLightbox.
let lightboxImages = $state<{ src: string; alt: string }[]>([]);
let lightboxIndex = $state<number | null>(null);
let sourceTooltipElement = $state<HTMLDivElement | null>(null);
let sourceTooltip = $state<SourceLinkTooltip | null>(null);
let prevWordCount = 0;
let prevLastBlockEl: HTMLElement | null = null;
let wasStreaming = false;
let renderVersion = 0;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let sourceTooltipFrame = 0;
let postRenderVersion = 0;
let activeSourceLink: HTMLAnchorElement | null = null;

// Throttle rendering during streaming so each visual update is large
// enough that new blocks are perceivable with the fade-in animation.
// The Token Display Buffer in the runtime already aligns store updates
// to animation frames; this throttle controls render frequency to avoid
// excessive markdown re-parses.
let pendingContent: string | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
const STREAM_THROTTLE_MS = 40;

async function collectFullMessageSourceReferences(
	source: string,
	compactLinks: boolean,
): Promise<SourceReferenceCandidate[]> {
	if (!compactLinks) return [];

	try {
		return collectSourceReferenceCandidates(source);
	} catch {
		return [];
	}
}

function scheduleRender(
	src: string,
	darkMode: boolean,
	streaming: boolean,
	compactLinks: boolean,
) {
	pendingContent = src;
	if (renderTimer !== null) return;
	renderTimer = setTimeout(() => {
		renderTimer = null;
		const latest = pendingContent;
		pendingContent = null;
		if (latest === null) return;
		void renderContent(latest, darkMode, streaming, compactLinks);
	}, STREAM_THROTTLE_MS);
}

// The single parse/split step (A3): parseMarkdownBlocks owns fence + block
// detection, then each typed block is rendered through the registry. This
// replaces the old line-scanning fence splitter (folds B3 — one fence grammar).
async function buildDisplayBlocks(
	source: string,
	darkMode: boolean,
	compactLinks: boolean,
): Promise<MarkdownBlock[]> {
	const normalizedSource = source.startsWith("[Translation unavailable]")
		? source.substring("[Translation unavailable]".length).trimStart()
		: source;
	const sourceReferences = await collectFullMessageSourceReferences(
		normalizedSource,
		compactLinks,
	);
	const typedBlocks = await parseMarkdownBlocks(normalizedSource);
	const nextBlocks: MarkdownBlock[] = [];

	for (const block of typedBlocks) {
		if (block.kind === "code") {
			nextBlocks.push({
				kind: "code",
				code: block.code,
				language: block.language,
				html: await renderCodeBlock(block.code, block.language, darkMode),
			});
			continue;
		}

		// Diagram lanes (chart / csv / mermaid): pass the raw fence body straight
		// to their component — no markdown render, no {@html}. The classifier only
		// promotes a CLOSED diagram fence to these kinds, so `code` is always a
		// complete source (never mid-stream partial).
		if (
			block.kind === "chart" ||
			block.kind === "csv" ||
			block.kind === "mermaid"
		) {
			nextBlocks.push({ kind: block.kind, code: block.code });
			continue;
		}

		if (block.kind === "checklist") {
			// Item bodies are BLOCK-LEVEL markdown (a checklist item can hold a
			// nested sub-list, a fenced code block, multiple paragraphs, a
			// blockquote). Render each through the FULL block renderer — same
			// options as the surrounding prose — so links become source-link chips,
			// bare source markers are stripped, and block content is not flattened.
			const items = await Promise.all(
				block.items.map(async (item) => ({
					checked: item.checked,
					task: item.task,
					html: await renderMarkdown(item.text, darkMode, {
						compactExternalLinks: compactLinks,
						sourceReferences,
					}),
				})),
			);
			nextBlocks.push({ kind: "checklist", items });
			continue;
		}

		// table | callout | accordion | html — the prose {@html} registry lane.
		const html = await renderMarkdown(block.raw, darkMode, {
			compactExternalLinks: compactLinks,
			sourceReferences,
		});
		if (html.trim()) {
			nextBlocks.push({ kind: block.kind, html });
		}
	}

	return nextBlocks;
}

function sameDisplayBlock(a: MarkdownBlock, b: MarkdownBlock): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "checklist" && b.kind === "checklist") {
		if (a.items.length !== b.items.length) return false;
		return a.items.every(
			(item, i) =>
				item.checked === b.items[i].checked &&
				item.task === b.items[i].task &&
				item.html === b.items[i].html,
		);
	}
	// Diagram lanes carry raw `code`, not pre-rendered `html`: compare the source
	// so an unchanged diagram is not needlessly re-instantiated during streaming.
	if ("code" in a && "code" in b && !("html" in a)) {
		return a.code === b.code;
	}
	return "html" in a && "html" in b && a.html === b.html;
}

async function renderContent(
	src: string,
	darkMode: boolean,
	streaming: boolean,
	compactLinks: boolean,
) {
	const currentRender = ++renderVersion;
	if (src.includes("```")) {
		await prepareCodeHighlighting(src);
	}
	const newBlocks = await buildDisplayBlocks(src, darkMode, compactLinks);
	if (currentRender !== renderVersion) return;

	if (streaming && blocks.length > 0 && newBlocks.length === blocks.length) {
		// Same block count during streaming: update the last block in place to
		// avoid tearing down and recreating the entire {#each} list, which
		// causes screen flicker (and would reset a Checklist's local tick state).
		const lastIdx = newBlocks.length - 1;
		const updated = newBlocks[lastIdx];
		const oldLast = blocks[lastIdx];
		if (sameDisplayBlock(updated, oldLast)) {
			// Content unchanged — skip entirely
			return;
		}
		blocks = blocks.map((b, i) =>
			i === lastIdx ? { ...updated, isNew: b.isNew } : b,
		);
		return;
	}

	const oldCount = prevBlockCount;
	blocks = newBlocks.map((b, i) => ({
		...b,
		isNew: streaming && i >= oldCount,
	}));

	prevBlockCount = newBlocks.length;

	const hasNewBlocks = blocks.some((b) => b.isNew);
	if (streaming && hasNewBlocks) {
		setTimeout(() => {
			blocks = blocks.map((b) => ({ ...b, isNew: false }));
		}, 500);
	}
}

$effect(() => {
	const nextContent = content;
	const darkMode = isDark;
	const streaming = isStreaming;
	const compactLinks = compactExternalLinks;

	if (streaming) {
		scheduleRender(nextContent, darkMode, streaming, compactLinks);
		return;
	}

	// Flush any pending throttled render immediately when streaming stops.
	if (renderTimer !== null) {
		clearTimeout(renderTimer);
		renderTimer = null;
		pendingContent = null;
	}

	void renderContent(nextContent, darkMode, streaming, compactLinks);
});

// The newly-streamed-word wrapping lives in ./stream-word-wrap (C3): a pure DOM
// walk plus the length threshold + per-tick cap that keep it bounded on long,
// fast answers. See runPostRenderEffects for how they are applied.

function applyBalancedTableLayout(table: HTMLTableElement) {
	const columnCount = getTableColumnCount(table);
	table.dataset.columnCount = String(columnCount);

	const wrapper = table.closest(".markdown-table-wrap");
	if (!(wrapper instanceof HTMLElement)) {
		return;
	}

	const forceScroll = columnCount > 4 || hasExtremeUnbreakableContent(table);
	wrapper.dataset.overflow = forceScroll ? "scroll" : "fit";

	const existingColgroup = table.querySelector(
		"colgroup[data-balanced-columns]",
	);
	existingColgroup?.remove();

	const widths = forceScroll
		? null
		: deriveBalancedColumnWidths(table, columnCount);
	if (!widths) {
		return;
	}

	const colgroup = document.createElement("colgroup");
	colgroup.dataset.balancedColumns = "true";
	for (const width of widths) {
		const col = document.createElement("col");
		col.style.width = width;
		colgroup.appendChild(col);
	}
	table.insertBefore(colgroup, table.firstChild);

	requestAnimationFrame(() => {
		if (!table.isConnected) return;
		const currentWrapper = table.closest(".markdown-table-wrap");
		if (!(currentWrapper instanceof HTMLElement)) return;

		const overflowMode = resolveTableOverflowMode({
			columnCount,
			forceScroll,
			wrapperWidth: currentWrapper.clientWidth,
			tableWidth: table.scrollWidth,
		});

		currentWrapper.dataset.overflow = overflowMode;

		if (overflowMode === "scroll") {
			table.querySelector("colgroup[data-balanced-columns]")?.remove();
		}
	});
}

function enhanceRenderedTables() {
	if (!container) return;
	container
		.querySelectorAll<HTMLTableElement>(".markdown-table-wrap table")
		.forEach((table) => {
			applyBalancedTableLayout(table);
		});
}

function handleMarkdownClick(event: MouseEvent) {
	const target = event.target;
	if (!(target instanceof Element)) return;

	// A link wins over an image click (covers [![alt](img)](href)): follow it.
	const link = target.closest("a[href]");
	if (link instanceof HTMLAnchorElement && link.href) {
		event.preventDefault();
		event.stopPropagation();
		window.open(link.href, "_blank", "noopener,noreferrer");
		return;
	}

	// A bare embedded image opens the lightbox.
	if (target instanceof HTMLImageElement && isMarkdownContentImage(target)) {
		event.preventDefault();
		openImageLightbox(target);
	}
}

// A content image is a model-embedded picture inside the rendered markdown —
// i.e. any <img> under .markdown-html that is NOT a source-link favicon.
function isMarkdownContentImage(image: HTMLImageElement): boolean {
	return (
		!image.classList.contains("source-link-chip__favicon") &&
		image.closest(".markdown-html") !== null
	);
}

// The navigable set for the lightbox: every content image in this message
// that has not failed to load (broken ones are hidden — see below).
function collectContentImages(): HTMLImageElement[] {
	if (!container) return [];
	return Array.from(
		container.querySelectorAll<HTMLImageElement>(".markdown-html img"),
	).filter(
		(image) =>
			isMarkdownContentImage(image) &&
			!image.classList.contains("markdown-image--broken"),
	);
}

function openImageLightbox(clicked: HTMLImageElement) {
	const images = collectContentImages();
	const index = images.indexOf(clicked);
	if (index === -1) return;
	lightboxImages = images.map((image) => ({
		src: image.currentSrc || image.src,
		alt: image.alt,
	}));
	lightboxIndex = index;
}

// Graceful degradation: when an embedded image fails to load (e.g. a
// hotlink-protected search result that 403s cross-origin) hide it rather than
// leaving the browser's broken-image placeholder in the middle of the prose.
// Runs in the capture phase because "error" events do not bubble.
function handleContentImageError(event: Event) {
	const image = event.target;
	if (!(image instanceof HTMLImageElement)) return;
	if (image.classList.contains("source-link-chip__favicon")) return;
	if (!image.closest(".markdown-html")) return;
	image.classList.add("markdown-image--broken");
	// Collapse the C4 skeleton frame so a broken image leaves no dangling
	// shimmer placeholder behind the (now hidden) broken img.
	const frame = image.closest(".markdown-image-frame");
	if (frame instanceof HTMLElement) {
		frame.classList.remove("markdown-image-frame--loading");
		frame.classList.add("markdown-image-frame--broken");
	}
}

// Reveal a slow content image once it loads (C4): swap the skeleton frame out of
// its loading state so the shimmer stops and the reserved neutral box releases.
// Capture phase because "load" does not bubble.
function handleContentImageLoad(event: Event) {
	const image = event.target;
	if (!(image instanceof HTMLImageElement)) return;
	if (!image.classList.contains("markdown-image")) return;
	const frame = image.closest(".markdown-image-frame");
	if (frame instanceof HTMLElement) {
		frame.classList.remove("markdown-image-frame--loading");
		frame.classList.add("markdown-image-frame--loaded");
	}
}

function getSourceLink(target: EventTarget | null): HTMLAnchorElement | null {
	if (!(target instanceof Element)) return null;

	const link = target.closest("a.source-link-chip");
	return link instanceof HTMLAnchorElement ? link : null;
}

function getViewportBounds() {
	const viewport = window.visualViewport;
	return {
		left: viewport?.offsetLeft ?? 0,
		top: viewport?.offsetTop ?? 0,
		width: viewport?.width ?? window.innerWidth,
		height: viewport?.height ?? window.innerHeight,
	};
}

// Thin DOM shell: measure the live viewport + chat-column rects and hand them
// to the pure `computeTooltipBoundary`. All boundary math lives in the module.
function getTooltipBoundary() {
	const chatBoundsElement = container?.closest(
		'.chat-main, [data-testid="assistant-message"]',
	);
	const chatRect =
		chatBoundsElement instanceof HTMLElement
			? chatBoundsElement.getBoundingClientRect()
			: null;
	return computeTooltipBoundary(
		getViewportBounds(),
		chatRect,
		SOURCE_TOOLTIP_MARGIN,
	);
}

function getTooltipCoordinateOffset() {
	const offsetParent = sourceTooltipElement?.offsetParent;
	if (offsetParent instanceof HTMLElement) {
		const rect = offsetParent.getBoundingClientRect();
		return { left: rect.left, top: rect.top };
	}

	return { left: 0, top: 0 };
}

function updateSourceLinkTooltipPosition() {
	if (
		!activeSourceLink ||
		!sourceTooltip ||
		!sourceTooltipElement ||
		!activeSourceLink.isConnected
	) {
		sourceTooltip = null;
		activeSourceLink = null;
		return;
	}

	// Measure the live rects; the pure module resolves the geometry.
	const resolved = computeTooltipPlacement({
		linkRect: activeSourceLink.getBoundingClientRect(),
		tooltipRect: sourceTooltipElement.getBoundingClientRect(),
		boundary: getTooltipBoundary(),
		coordinateOffset: getTooltipCoordinateOffset(),
		offset: SOURCE_TOOLTIP_OFFSET,
	});

	sourceTooltip = {
		...sourceTooltip,
		left: resolved.left,
		top: resolved.top,
		maxWidth: resolved.maxWidth,
		placement: resolved.placement,
		ready: true,
	};
}

function scheduleSourceTooltipPosition() {
	if (!sourceTooltip) return;
	if (sourceTooltipFrame) {
		cancelAnimationFrame(sourceTooltipFrame);
	}
	sourceTooltipFrame = requestAnimationFrame(() => {
		sourceTooltipFrame = 0;
		updateSourceLinkTooltipPosition();
	});
}

async function showSourceLinkTooltip(link: HTMLAnchorElement) {
	const label = link
		.querySelector(".source-link-chip__label")
		?.textContent?.trim();
	const sourceName = label || link.hostname || link.href;
	const linkRect = link.getBoundingClientRect();
	const boundary = getTooltipBoundary();
	const maxWidth = resolveTooltipMaxWidth(boundary);
	activeSourceLink = link;
	sourceTooltip = {
		sourceName,
		url: link.href,
		left: clamp(linkRect.left, boundary.left, boundary.right - maxWidth),
		top: linkRect.bottom + SOURCE_TOOLTIP_OFFSET,
		maxWidth,
		placement: "bottom",
		ready: false,
	};

	await tick();
	if (activeSourceLink === link) {
		updateSourceLinkTooltipPosition();
	}
}

function hideSourceLinkTooltip(link?: HTMLAnchorElement | null) {
	if (link && activeSourceLink !== link) return;
	activeSourceLink = null;
	sourceTooltip = null;
}

function handleSourceLinkPointerOver(event: PointerEvent) {
	const link = getSourceLink(event.target);
	if (!link) return;
	if (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))
		return;
	void showSourceLinkTooltip(link);
}

function handleSourceLinkPointerOut(event: PointerEvent) {
	const link = getSourceLink(event.target);
	if (!link) return;
	if (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))
		return;
	hideSourceLinkTooltip(link);
}

function handleSourceLinkFocusIn(event: FocusEvent) {
	const link = getSourceLink(event.target);
	if (!link) return;
	void showSourceLinkTooltip(link);
}

function handleSourceLinkFocusOut(event: FocusEvent) {
	const link = getSourceLink(event.target);
	if (!link) return;
	if (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))
		return;
	hideSourceLinkTooltip(link);
}

function handleSourceLinkKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		hideSourceLinkTooltip();
	}
}

function handleSourceFaviconError(event: Event) {
	const image = event.target;
	if (
		!(image instanceof HTMLImageElement) ||
		!image.classList.contains("source-link-chip__favicon")
	) {
		return;
	}

	image.hidden = true;
	const fallback = image.nextElementSibling;
	if (
		fallback instanceof HTMLElement &&
		fallback.classList.contains("source-link-chip__favicon-fallback")
	) {
		fallback.hidden = false;
	}
}

function scheduleTableEnhancement() {
	if (resizeFrame) {
		cancelAnimationFrame(resizeFrame);
	}
	resizeFrame = requestAnimationFrame(() => {
		resizeFrame = 0;
		enhanceRenderedTables();
	});
}

onMount(() => {
	const handleViewportChange = () => {
		scheduleTableEnhancement();
		scheduleSourceTooltipPosition();
	};
	const clickContainer = container;
	clickContainer?.addEventListener("click", handleMarkdownClick);
	clickContainer?.addEventListener("pointerover", handleSourceLinkPointerOver);
	clickContainer?.addEventListener("pointerout", handleSourceLinkPointerOut);
	clickContainer?.addEventListener("focusin", handleSourceLinkFocusIn);
	clickContainer?.addEventListener("focusout", handleSourceLinkFocusOut);
	clickContainer?.addEventListener("keydown", handleSourceLinkKeydown);
	clickContainer?.addEventListener("error", handleSourceFaviconError, true);
	clickContainer?.addEventListener("error", handleContentImageError, true);
	clickContainer?.addEventListener("load", handleContentImageLoad, true);

	if (typeof ResizeObserver !== "undefined") {
		resizeObserver = new ResizeObserver(() => {
			scheduleTableEnhancement();
		});
		if (container) {
			resizeObserver.observe(container);
		}
	}

	window.addEventListener("resize", handleViewportChange);
	window.addEventListener("orientationchange", handleViewportChange);
	window.addEventListener("scroll", handleViewportChange, true);
	window.visualViewport?.addEventListener("resize", handleViewportChange);
	window.visualViewport?.addEventListener("scroll", handleViewportChange);
	document.fonts?.ready
		.then(() => scheduleTableEnhancement())
		.catch(() => undefined);

	return () => {
		resizeObserver?.disconnect();
		resizeObserver = null;
		if (renderTimer !== null) {
			clearTimeout(renderTimer);
			renderTimer = null;
		}
		if (resizeFrame) {
			cancelAnimationFrame(resizeFrame);
			resizeFrame = 0;
		}
		if (sourceTooltipFrame) {
			cancelAnimationFrame(sourceTooltipFrame);
			sourceTooltipFrame = 0;
		}
		activeSourceLink = null;
		sourceTooltip = null;
		window.removeEventListener("resize", handleViewportChange);
		window.removeEventListener("orientationchange", handleViewportChange);
		window.removeEventListener("scroll", handleViewportChange, true);
		window.visualViewport?.removeEventListener("resize", handleViewportChange);
		window.visualViewport?.removeEventListener("scroll", handleViewportChange);
		clickContainer?.removeEventListener("click", handleMarkdownClick);
		clickContainer?.removeEventListener(
			"pointerover",
			handleSourceLinkPointerOver,
		);
		clickContainer?.removeEventListener(
			"pointerout",
			handleSourceLinkPointerOut,
		);
		clickContainer?.removeEventListener("focusin", handleSourceLinkFocusIn);
		clickContainer?.removeEventListener("focusout", handleSourceLinkFocusOut);
		clickContainer?.removeEventListener("keydown", handleSourceLinkKeydown);
		clickContainer?.removeEventListener(
			"error",
			handleSourceFaviconError,
			true,
		);
		clickContainer?.removeEventListener("error", handleContentImageError, true);
		clickContainer?.removeEventListener("load", handleContentImageLoad, true);
	};
});

async function runPostRenderEffects(version: number) {
	await tick();
	if (version !== postRenderVersion || !container) return;

	resizeObserver?.disconnect();
	resizeObserver?.observe(container);
	scheduleTableEnhancement();
	scheduleSourceTooltipPosition();

	const animateWords = isStreaming || wasStreaming;
	wasStreaming = isStreaming;
	if (!animateWords) return;

	const blockEls = container.querySelectorAll<HTMLElement>(
		":scope > .markdown-html",
	);
	if (!blockEls.length) return;
	const lastBlockEl = blockEls[blockEls.length - 1];

	if (lastBlockEl !== prevLastBlockEl) {
		prevWordCount = 0;
		prevLastBlockEl = lastBlockEl;
	}

	// C3: on a very long answer, skip per-word wrapping entirely and let the
	// whole-block fade-in carry the reveal — the wrapping (bounded per tick by
	// the cap inside wrapNewWords) is preserved for normal-length answers.
	if (shouldAnimateWords(content.length)) {
		prevWordCount = wrapNewWords(lastBlockEl, prevWordCount);
	}

	// Reset word tracking after the final batch when streaming has ended
	if (!isStreaming) {
		prevWordCount = 0;
		prevLastBlockEl = null;
		prevBlockCount = 0;
	}
}

$effect(() => {
	blocks;
	isStreaming;

	if (!container) {
		return;
	}

	const version = ++postRenderVersion;
	void runPostRenderEffects(version);
});
</script>

<div class="markdown-container" bind:this={container} aria-hidden="false">
  {#each blocks as block}
    {@const entry = blockRenderer(block.kind)}
    {#if entry}
      {@const Renderer = entry.component}
      <div class={entry.wrapperClass ?? ''} class:block-fade-in={block.isNew}>
        <Renderer {...entry.props(block)} />
      </div>
    {:else if 'html' in block}
      <div class="prose max-w-none dark:prose-invert markdown-html">
        {@html block.html}
      </div>
    {/if}
  {/each}
</div>
{#if lightboxIndex !== null}
  <ImageLightbox
    images={lightboxImages}
    index={lightboxIndex}
    onClose={() => (lightboxIndex = null)}
    onNavigate={(next) => (lightboxIndex = next)}
  />
{/if}
{#if sourceTooltip}
  <div
    bind:this={sourceTooltipElement}
    class={[
      'source-link-tooltip-floating',
      sourceTooltip.placement === 'top' ? 'source-link-tooltip-floating--top' : '',
      sourceTooltip.ready ? 'source-link-tooltip-floating--visible' : ''
    ].filter(Boolean).join(' ')}
    role="tooltip"
    style={`left: ${sourceTooltip.left}px; top: ${sourceTooltip.top}px; max-width: ${sourceTooltip.maxWidth}px;`}
  >
    <span class="source-link-tooltip-floating__name">{sourceTooltip.sourceName}</span>
    <span class="source-link-tooltip-floating__url">{sourceTooltip.url}</span>
  </div>
{/if}

<style>
  .markdown-container {
    position: relative;
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .markdown-html :global(*:last-child) {
    margin-bottom: 0;
  }

  /* Embedded content images are clickable to open the lightbox. Favicons in
     source-link chips are excluded. */
  .markdown-html :global(img:not(.source-link-chip__favicon)) {
    cursor: zoom-in;
  }

  /* An image that failed to load is removed from the flow (graceful
     degradation) instead of showing the browser's broken-image placeholder. */
  .markdown-html :global(img.markdown-image--broken) {
    display: none;
  }

  /* Image loading skeleton (C4). The frame reserves a neutral box and shows a
     shimmer while the image is loading, so a slow (not broken) image no longer
     flashes layout-shift when it finally paints. Once loaded (JS toggles
     --loaded) or broken (--broken) the reserved box + shimmer collapse. The img
     is a child painted on top, so a loaded image naturally covers the shimmer
     even before the class flips — the JS reveal just releases the reserved
     space and stops the animation. */
  .markdown-html :global(.markdown-image-frame) {
    position: relative;
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    border-radius: var(--radius-sm, 0.375rem);
    line-height: 0;
    vertical-align: bottom;
  }

  .markdown-html :global(.markdown-image-frame--loading) {
    min-width: 12rem;
    min-height: 8rem;
    background-color: color-mix(in srgb, var(--text-muted) 12%, transparent);
    background-image: linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in srgb, var(--text-muted) 14%, transparent) 40%,
      color-mix(in srgb, var(--text-muted) 14%, transparent) 60%,
      transparent 80%
    );
    background-size: 200% 100%;
    animation: markdownImageShimmer 1.4s ease-in-out infinite;
  }

  .markdown-html :global(.markdown-image-frame--loaded),
  .markdown-html :global(.markdown-image-frame--broken) {
    min-width: 0;
    min-height: 0;
    background: none;
    animation: none;
  }

  .markdown-html :global(.markdown-image) {
    display: block;
    max-width: 100%;
    height: auto;
  }

  @keyframes markdownImageShimmer {
    from {
      background-position: 150% 0;
    }
    to {
      background-position: -50% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .markdown-html :global(.markdown-image-frame--loading) {
      animation: none;
    }
  }

  /* Code blocks fade in as a unit when they first appear.
     During streaming, keep it subtle to avoid layout flicker. */
  .block-fade-in {
    animation: blockFadeIn 300ms ease-out forwards;
  }

  @keyframes blockFadeIn {
    from { opacity: 0.4; }
    to   { opacity: 1; }
  }

  :global(.word-new) {
    animation: wordFadeIn 300ms ease-out forwards;
  }

  :global(.source-link-chip) {
    position: relative;
    display: inline-flex;
    max-width: min(18ch, 100%);
    align-items: center;
    gap: 0.22em;
    justify-content: center;
    margin: 0 0.06em;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-elevated) 94%, var(--text-muted) 6%);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 560;
    line-height: 1.25;
    padding: 0.02em 0.3em 0.02em 0.34em;
    text-decoration: none !important;
    vertical-align: middle;
    transition:
      border-color var(--duration-micro) var(--ease-out),
      background var(--duration-micro) var(--ease-out),
      color var(--duration-micro) var(--ease-out);
  }

  :global(.source-link-chip:hover),
  :global(.source-link-chip:focus-visible) {
    border-color: color-mix(in srgb, var(--text-muted) 42%, var(--border-subtle));
    background: var(--surface-elevated);
    outline: none;
  }

  :global(.source-link-chip:focus-visible) {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 42%, transparent);
  }

  :global(.source-link-chip__label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.source-link-chip__favicon-wrap) {
    position: relative;
    display: inline-grid;
    width: 1.3em;
    min-width: 1.3em;
    height: 1.3em;
    place-items: center;
  }

  :global(.source-link-chip__favicon) {
    display: block;
    width: 1em;
    min-width: 1em;
    height: 1em;
    margin: 0;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent);
    border-radius: 999px;
    background: var(--surface-page);
    object-fit: cover;
  }

  :global(.source-link-chip__favicon-fallback) {
    display: block;
    width: 1em;
    min-width: 1em;
    height: 1em;
    color: var(--text-muted);
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'/%3E%3Cpath d='M2 12h20'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20'/%3E%3Cpath d='M2 12h20'/%3E%3C/svg%3E") center / contain no-repeat;
  }

  :global(.source-link-chip__favicon[hidden]),
  :global(.source-link-chip__favicon-fallback[hidden]) {
    display: none;
  }

  :global(.source-link-chip__icon) {
    position: relative;
    display: block;
    width: 0.86em;
    min-width: 0.86em;
    height: 0.86em;
    color: var(--accent);
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 3h6v6'/%3E%3Cpath d='M10 14 21 3'/%3E%3Cpath d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 3h6v6'/%3E%3Cpath d='M10 14 21 3'/%3E%3Cpath d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'/%3E%3C/svg%3E") center / contain no-repeat;
  }

  .source-link-tooltip-floating {
    position: fixed;
    z-index: 90;
    display: flex;
    width: max-content;
    flex-direction: column;
    gap: 0.18rem;
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    background: var(--surface-elevated);
    box-shadow: var(--shadow-lg);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    line-height: 1.35;
    padding: 0.45rem 0.55rem;
    pointer-events: none;
    text-align: left;
    opacity: 0;
    transform: translateY(-0.18rem);
    transition:
      opacity 120ms var(--ease-out),
      transform 120ms var(--ease-out);
    visibility: hidden;
    white-space: normal;
  }

  .source-link-tooltip-floating__name {
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .source-link-tooltip-floating__url {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    overflow-wrap: anywhere;
  }

  .source-link-tooltip-floating--top {
    transform: translateY(0.18rem);
  }

  .source-link-tooltip-floating--visible {
    opacity: 1;
    transform: translateY(0);
    visibility: visible;
  }

  @keyframes wordFadeIn {
    from { opacity: 0; transform: translateY(2px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .block-fade-in {
      animation: none;
      opacity: 1;
    }
    :global(.word-new) {
      animation: none;
      opacity: 1;
    }
  }
</style>
