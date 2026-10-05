<script lang="ts">
/**
 * The shell the panel header's popovers share (Wave 2.5 polish G1-B): a
 * popover anchored under the header button that opened it on desktop, a
 * `DialogShell` bottom sheet on phones — the anchored-popover-desktop /
 * sheet-phone shape `VersionsSheet.svelte` and `DownloadSheet.svelte` each
 * carried a copy of (and `AppBody.svelte`'s regenerate popover a third).
 *
 * Desktop: `position: fixed`, portalled to `<body>`, placed by
 * `placePopover` — under the button, left edges aligned, kept inside the
 * panel the button lives in (never over the chat column beside it), flipped
 * above when it does not fit below, its content scrolling inside a capped
 * height. The trigger is found by test id, filtered to whichever copy is
 * rendered: `DocumentWorkspace.svelte` renders its header once per shell
 * (mobile and desktop), so both copies share the id and CSS alone decides
 * which is visible. It joins `DialogShell`'s dialog stack, so Escape closes
 * only the topmost layer and focus returns to the trigger; a press outside
 * closes it; it sets `aria-expanded` on the trigger while it is open.
 *
 * Phone: the same content inside `DialogShell` `phonePresentation="sheet"`.
 */
import { X } from "@lucide/svelte";
import { type Snippet, untrack } from "svelte";
import { scale } from "svelte/transition";
import DialogShell, {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { focusTrap } from "$lib/utils/focus-trap";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import { placePopover } from "./popover-placement";

let {
	title,
	anchorTestId,
	popoverTestId,
	closeLabel,
	width = 340,
	maxHeight = 480,
	boundarySelector = ".workspace-shell",
	initialFocus = undefined,
	onClose,
	children,
}: {
	/** The visible heading and the dialog's accessible name. */
	title: string;
	/** `data-testid` of the trigger button in the panel header. */
	anchorTestId: string;
	/** `data-testid` of the popover itself. */
	popoverTestId: string;
	closeLabel: string;
	/** Preferred width; it narrows to fit a smaller panel. */
	width?: number;
	/** The tallest the popover grows before its content scrolls. */
	maxHeight?: number;
	/** The panel the popover must stay inside, found from the trigger. */
	boundarySelector?: string;
	/** Where focus lands when the popover opens, when that is not its first control (a menu opens on its first item). Asked once the content is there; nothing, or null, leaves the first control. */
	initialFocus?: (() => HTMLElement | null | undefined) | undefined;
	onClose: () => void;
	children: Snippet;
} = $props();

let isPhone = $state(isPhoneViewport());
let placementStyle = $state<string | undefined>(undefined);
let headEl = $state<HTMLElement | undefined>(undefined);
let bodyEl = $state<HTMLElement | undefined>(undefined);
const popoverId = Symbol("anchored-popover");
const popoverScale = reducedMotionAware(scale);

// Shown until (and unless) the trigger can be measured: near the top right,
// never at the browser's default fixed position.
const FALLBACK_STYLE = "top: 4rem; right: 1rem;";

function findAnchorEl(): HTMLElement | null {
	const candidates = document.querySelectorAll<HTMLElement>(
		`[data-testid="${anchorTestId}"]`,
	);
	for (const el of candidates) {
		if (el.getClientRects().length > 0) return el;
	}
	return null;
}

function measure(): void {
	if (typeof window === "undefined") return;
	// Read untracked: this runs inside effects, which must not re-run (and
	// churn the dialog stack) just because a `bind:this` ref arrived.
	const head = untrack(() => headEl);
	const body = untrack(() => bodyEl);
	const anchor = findAnchorEl();
	if (!anchor || !head || !body) return;
	const viewport = { width: window.innerWidth, height: window.innerHeight };
	const boundaryRect = anchor
		.closest(boundarySelector)
		?.getBoundingClientRect();
	const placement = placePopover({
		anchor: anchor.getBoundingClientRect(),
		boundary: boundaryRect ?? {
			left: 0,
			top: 0,
			right: viewport.width,
			bottom: viewport.height,
		},
		viewport,
		contentHeight: head.offsetHeight + body.scrollHeight,
		preferredWidth: width,
		maxHeight,
	});
	const vertical =
		placement.top !== undefined
			? `top: ${placement.top}px;`
			: `bottom: ${placement.bottom}px;`;
	const origin = placement.side === "below" ? "top left" : "bottom left";
	placementStyle = `left: ${placement.left}px; width: ${placement.width}px; max-height: ${placement.maxHeight}px; ${vertical} transform-origin: ${origin};`;
}

$effect(() => {
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
	return stopWatchingViewport;
});

$effect(() => {
	if (isPhone) return;
	registerDialog(popoverId);
	const anchor = findAnchorEl();
	anchor?.setAttribute("aria-expanded", "true");
	measure();
	const handleReflow = () => measure();
	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		const target = event.target as Node;
		if (findAnchorEl()?.contains(target)) return;
		const popover = document.querySelector(`[data-testid="${popoverTestId}"]`);
		if (popover && !popover.contains(target)) onClose();
	};
	window.addEventListener("resize", handleReflow);
	window.addEventListener("scroll", handleReflow, true);
	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	return () => {
		deregisterDialog(popoverId);
		anchor?.removeAttribute("aria-expanded");
		window.removeEventListener("resize", handleReflow);
		window.removeEventListener("scroll", handleReflow, true);
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
	};
});

// The content can change height under an open popover (a list arriving, an
// inline confirm opening): place it again. Also places it once its own
// elements exist — the effect above runs before `bind:this` has bound them.
$effect(() => {
	const body = bodyEl;
	if (isPhone || !body) return;
	measure();
	if (typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver(() => measure());
	observer.observe(body);
	return () => observer.disconnect();
});

const popoverFocusTrap = focusTrap({
	isTopmost: () => isTopmostDialog(popoverId),
	onEscape: (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		onClose();
	},
	focus: { defer: true, target: () => initialFocus?.() },
	restoreFocusOnCleanup: true,
});
</script>

{#if isPhone}
	<!-- zIndexClass: opened from a button inside the mobile shell, whose own
	     `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's
	     default `z-50` would paint behind it. Same fix, same value, as
	     `MobileToolbar.svelte`'s own "More" sheet / `CommentsSheet.svelte`. -->
	<DialogShell
		{title}
		phonePresentation="sheet"
		zIndexClass="z-[150]"
		{onClose}
	>
		{@render children()}
	</DialogShell>
{:else}
	<div
		class="anchored-popover"
		style={placementStyle ?? FALLBACK_STYLE}
		role="dialog"
		aria-modal="true"
		aria-label={title}
		data-testid={popoverTestId}
		use:portalToBody
		{@attach popoverFocusTrap}
		transition:popoverScale={{ duration: MOTION_DURATION.standard, start: 0.98 }}
	>
		<div class="anchored-popover-head" bind:this={headEl}>
			<h2>{title}</h2>
			<button
				type="button"
				class="btn-icon-bare"
				onclick={onClose}
				aria-label={closeLabel}
			>
				<X size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
		<div class="anchored-popover-body" bind:this={bodyEl}>
			{@render children()}
		</div>
	</div>
{/if}

<style>
	.anchored-popover {
		position: fixed;
		/* 60 rendered UNDER the expanded panel shell
		   (`DocumentWorkspace.svelte`'s `.workspace-shell-expanded`,
		   z-index 115); 130 clears it, matching `ConfirmDialog.svelte`'s own
		   default `zIndexClass="z-[130]"` for "must be above other floating
		   chrome" (rd/review-2-5.md:168-175). */
		z-index: 130;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border-radius: var(--radius-lg, 12px);
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		box-shadow: var(--shadow-lg);
	}

	.anchored-popover-head {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.625rem 0.5rem 0.875rem;
	}

	.anchored-popover-head h2 {
		flex: 1;
		margin: 0;
		font-size: 0.84rem;
		font-weight: 700;
		color: var(--text-primary);
		overflow-wrap: break-word;
	}

	/* The content scrolls, the heading does not. */
	.anchored-popover-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
</style>
