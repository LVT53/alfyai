<script lang="ts">
import CodeBlock from "./CodeBlock.svelte";
import {
	collectSourceReferenceCandidates,
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

type MarkdownBlock =
	| { type: "html"; html: string; isNew?: boolean }
	| {
			type: "code";
			code: string;
			language?: string;
			html: string;
			isNew?: boolean;
	  };
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
let sourceTooltipElement = $state<HTMLDivElement | null>(null);
let sourceTooltip = $state<SourceLinkTooltip | null>(null);
let prevWordCount = 0;
let prevLastBlockEl: HTMLElement | null = null;
let renderVersion = 0;
let resizeObserver: ResizeObserver | null = null;
let resizeFrame = 0;
let sourceTooltipFrame = 0;
let postRenderVersion = 0;
let activeSourceLink: HTMLAnchorElement | null = null;
const SOURCE_TOOLTIP_MARGIN = 12;
const SOURCE_TOOLTIP_OFFSET = 6;

// Throttle rendering during streaming so each visual update is large
// enough that new blocks are perceivable with the fade-in animation.
let pendingContent: string | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
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
	if (throttleTimer !== null) return;
	throttleTimer = setTimeout(() => {
		throttleTimer = null;
		const latest = pendingContent;
		pendingContent = null;
		if (latest === null) return;
		void renderContent(latest, darkMode, streaming, compactLinks);
	}, STREAM_THROTTLE_MS);
}

async function splitMarkdownBlocks(
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
	const lines = normalizedSource.split("\n");
	const nextBlocks: MarkdownBlock[] = [];
	const textLines: string[] = [];
	const codeLines: string[] = [];
	let language: string | undefined;
	let inCodeBlock = false;

	const flushText = async () => {
		if (!textLines.length) return;

		const html = await renderMarkdown(textLines.join("\n"), darkMode, {
			compactExternalLinks: compactLinks,
			sourceReferences,
		});
		if (html.trim()) {
			nextBlocks.push({ type: "html", html });
		}
		textLines.length = 0;
	};

	const flushCode = async () => {
		nextBlocks.push({
			type: "code",
			code: codeLines.join("\n"),
			language,
			html: await renderCodeBlock(codeLines.join("\n"), language, darkMode),
		});
		codeLines.length = 0;
		language = undefined;
	};

	for (const line of lines) {
		const openingFenceMatch = line.match(/^\s*```\s*([^\s`]*)\s*$/);
		const closingFenceMatch = line.match(/^\s*```\s*$/);

		if (!inCodeBlock && openingFenceMatch) {
			await flushText();
			inCodeBlock = true;
			language = openingFenceMatch[1] || undefined;
			continue;
		}

		if (inCodeBlock && closingFenceMatch) {
			await flushCode();
			inCodeBlock = false;
			continue;
		}

		if (inCodeBlock) {
			codeLines.push(line);
		} else {
			textLines.push(line);
		}
	}

	await flushText();

	if (inCodeBlock) {
		await flushCode();
	}

	return nextBlocks;
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
	const newBlocks = await splitMarkdownBlocks(src, darkMode, compactLinks);
	if (currentRender !== renderVersion) return;
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
	if (throttleTimer !== null) {
		clearTimeout(throttleTimer);
		throttleTimer = null;
		pendingContent = null;
	}

	void renderContent(nextContent, darkMode, streaming, compactLinks);
});

$effect(() => {
	if (!isStreaming) {
		prevWordCount = 0;
		prevLastBlockEl = null;
		prevBlockCount = 0;
	}
});

// Walk the last html block's DOM and wrap newly arrived words in animated spans.
// Words at index < startIndex are already rendered; only wrap words >= startIndex.
// Returns the total word count after processing.
function wrapNewWords(element: HTMLElement, startIndex: number): number {
	let wordIndex = 0;

	function processNode(node: Node): void {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? "";
			const parts = text.split(/(\s+)/);

			// Fast path: check if any word in this text node is new
			let tempCount = wordIndex;
			let nodeHasNew = false;
			for (const part of parts) {
				if (part.trim()) {
					if (tempCount >= startIndex) {
						nodeHasNew = true;
						break;
					}
					tempCount++;
				}
			}

			if (!nodeHasNew) {
				for (const part of parts) {
					if (part.trim()) wordIndex++;
				}
				return;
			}

			const fragment = document.createDocumentFragment();
			for (const part of parts) {
				if (!part.trim()) {
					fragment.appendChild(document.createTextNode(part));
				} else {
					if (wordIndex >= startIndex) {
						const span = document.createElement("span");
						span.className = "word-new";
						span.textContent = part;
						fragment.appendChild(span);
					} else {
						fragment.appendChild(document.createTextNode(part));
					}
					wordIndex++;
				}
			}
			node.parentNode?.replaceChild(fragment, node);
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node as Element;
			const tagName = element.tagName;
			if (tagName === "SCRIPT" || tagName === "STYLE") return;
			if (element.matches(".source-link-chip")) return;
			Array.from(node.childNodes).forEach(processNode);
		}
	}

	Array.from(element.childNodes).forEach(processNode);
	return wordIndex;
}

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

	const link = target.closest("a[href]");
	if (!(link instanceof HTMLAnchorElement)) return;
	if (!link.href) return;

	event.preventDefault();
	event.stopPropagation();
	window.open(link.href, "_blank", "noopener,noreferrer");
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

function getTooltipBoundary() {
	const viewport = getViewportBounds();
	const viewportBounds = {
		left: viewport.left + SOURCE_TOOLTIP_MARGIN,
		right: viewport.left + viewport.width - SOURCE_TOOLTIP_MARGIN,
		top: viewport.top + SOURCE_TOOLTIP_MARGIN,
		bottom: viewport.top + viewport.height - SOURCE_TOOLTIP_MARGIN,
	};
	const chatBoundsElement = container?.closest(
		'.chat-main, [data-testid="assistant-message"]',
	);
	if (!(chatBoundsElement instanceof HTMLElement)) {
		return viewportBounds;
	}

	const chatRect = chatBoundsElement.getBoundingClientRect();
	const bounds = {
		left: Math.max(viewportBounds.left, chatRect.left + SOURCE_TOOLTIP_MARGIN),
		right: Math.min(
			viewportBounds.right,
			chatRect.right - SOURCE_TOOLTIP_MARGIN,
		),
		top: viewportBounds.top,
		bottom: viewportBounds.bottom,
	};

	return bounds.right - bounds.left >= 180 ? bounds : viewportBounds;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
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

	const linkRect = activeSourceLink.getBoundingClientRect();
	const tooltipRect = sourceTooltipElement.getBoundingClientRect();
	const boundary = getTooltipBoundary();
	const coordinateOffset = getTooltipCoordinateOffset();
	const maxWidth = Math.min(352, Math.max(180, boundary.right - boundary.left));
	const tooltipWidth = Math.min(tooltipRect.width || maxWidth, maxWidth);
	const tooltipHeight = tooltipRect.height || 48;
	const left =
		clamp(linkRect.left, boundary.left, boundary.right - tooltipWidth) -
		coordinateOffset.left;
	const spaceBelow = boundary.bottom - linkRect.bottom;
	const spaceAbove = linkRect.top - boundary.top;
	const placement =
		spaceBelow < tooltipHeight + SOURCE_TOOLTIP_OFFSET &&
		spaceAbove > spaceBelow
			? "top"
			: "bottom";
	const idealTop =
		placement === "top"
			? linkRect.top - tooltipHeight - SOURCE_TOOLTIP_OFFSET
			: linkRect.bottom + SOURCE_TOOLTIP_OFFSET;
	const top =
		clamp(idealTop, boundary.top, boundary.bottom - tooltipHeight) -
		coordinateOffset.top;

	sourceTooltip = {
		...sourceTooltip,
		left,
		top,
		maxWidth,
		placement,
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
	const maxWidth = Math.min(352, Math.max(180, boundary.right - boundary.left));
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
		if (throttleTimer !== null) {
			clearTimeout(throttleTimer);
			throttleTimer = null;
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
	};
});

async function runPostRenderEffects(version: number) {
	await tick();
	if (version !== postRenderVersion || !container) return;

	resizeObserver?.disconnect();
	resizeObserver?.observe(container);
	scheduleTableEnhancement();
	scheduleSourceTooltipPosition();

	if (!isStreaming) return;

	const blockEls = container.querySelectorAll<HTMLElement>(
		":scope > .markdown-html",
	);
	if (!blockEls.length) return;
	const lastBlockEl = blockEls[blockEls.length - 1];

	if (lastBlockEl !== prevLastBlockEl) {
		prevWordCount = 0;
		prevLastBlockEl = lastBlockEl;
	}

	prevWordCount = wrapNewWords(lastBlockEl, prevWordCount);
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
    {#if block.type === 'html'}
      <div class="prose max-w-none dark:prose-invert markdown-html">
        {@html block.html}
      </div>
    {:else}
      <div class:block-fade-in={block.isNew}>
        <CodeBlock code={block.code} language={block.language} contentHtml={block.html} />
      </div>
    {/if}
  {/each}
</div>
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
    animation: wordFadeIn 200ms ease-out forwards;
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

  :global(.source-link-chip__favicon) {
    display: block;
    width: 1em;
    min-width: 1.3em;
    height: 1em;
    margin: 0;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent);
    border-radius: 999px;
    background: var(--surface-page);
    object-fit: cover;
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
    from { opacity: 0.3; }
    to   { opacity: 1; }
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
