<script lang="ts">
/**
 * Where comments live when they are not the inline column (Feature 2 ·
 * Artifacts, Wave 2.5 Step 8, redesign.md §3.2/§3.3/§9.2/§9.3): a phone bottom
 * sheet from the header's Comments button or a tapped highlight, and a drawer
 * over the right edge of the body on a panel too narrow to hold the column
 * beside it. Presentation only, for every kind that has comments: what is
 * inside (the Document's `MarginPanel`, the Canvas's list) is the caller's, and
 * so is every piece of comment state.
 *
 * The drawer lives INSIDE the panel it belongs to: it slides in from the
 * panel's own right edge, starts below the panel's header, tabs and toolbar (so
 * the header's Comments button — the toggle that closes it — is never covered),
 * and follows the panel wherever it is, docked or expanded. It used to be fixed
 * to the browser window's edge from the top down, which covered the panel's own
 * actions and missed the expanded presentation altogether.
 */
import type { Snippet } from "svelte";
import { fly } from "svelte/transition";
import DialogShell, {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { focusTrap } from "$lib/utils/focus-trap";
import { reducedMotionAware } from "$lib/utils/motion";

let {
	presentation,
	title,
	onClose,
	bottomInset = 0,
	children,
}: {
	/** "sheet" on phones (a `DialogShell`), "drawer" on a narrow desktop panel (redesign §3.2) — the caller already knows which from its own viewport/container-width tracking, so this component only ever renders ONE shape at a time. */
	presentation: "sheet" | "drawer";
	/** The surface's accessible name: the sheet's dialog title (visually hidden — the list draws its own heading) and the drawer's `aria-label`. */
	title: string;
	onClose: () => void;
	/** The drawer stops this many pixels above the panel's bottom edge, so something pinned there — the review bar, whose Keep all / Undo all are the very thing someone reading comments about a change wants next — is never covered by it. The sheet has its own scrim and ignores it. */
	bottomInset?: number;
	/** The list, told which shape it is in: the drawer's own header carries the close button, the sheet's dialog does. */
	children: Snippet<[{ presentation: "sheet" | "drawer" }]>;
} = $props();

const drawerId = Symbol("comments-drawer");
const drawerFly = reducedMotionAware(fly);

$effect(() => {
	if (presentation !== "drawer") return;
	registerDialog(drawerId);
	return () => deregisterDialog(drawerId);
});

const drawerFocusTrap = focusTrap({
	isTopmost: () => isTopmostDialog(drawerId),
	onEscape: (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		onClose();
	},
	focus: { defer: true },
	restoreFocusOnCleanup: true,
});
</script>

{#if presentation === 'sheet'}
	<!-- The list already draws its own "Comments" `<h2>` (plus the count and the
	     "N resolved" toggle) as its header — `titleVisuallyHidden` keeps
	     `DialogShell`'s title as the sheet's ACCESSIBLE name without a second,
	     visually duplicate heading. -->
	<!-- zIndexClass: this sheet opens from a button INSIDE
	     `DocumentWorkspace.svelte`'s mobile shell, whose own
	     `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's
	     default `z-50` renders behind it (found by screenshot, not by any
	     role/text query: the sheet is still genuinely "visible" and
	     interactive to Testing Library/Playwright, just painted under the
	     backdrop). Same fix, same value, same reasoning as
	     `MobileToolbar.svelte`'s own "More" sheet. -->
	<DialogShell
		{title}
		titleVisuallyHidden
		phonePresentation="sheet"
		zIndexClass="z-[150]"
		{onClose}
	>
		{@render children({ presentation: 'sheet' })}
	</DialogShell>
{:else}
	<div
		class="comments-drawer"
		role="dialog"
		aria-modal="true"
		aria-label={title}
		data-testid="comments-drawer"
		style:bottom={bottomInset > 0 ? `${bottomInset}px` : undefined}
		{@attach drawerFocusTrap}
		transition:drawerFly={{ duration: 220, x: 280 }}
	>
		<!-- No second heading and no separate header row: the list's own header
		     carries the title, the count, the filter and — given `onClose` — the
		     close button, and `aria-label` above names the dialog. -->
		{@render children({ presentation: 'drawer' })}
	</div>
{/if}

<style>
	/* Positioned against the body's own row (the text or the board and, when
	   there is room, the comment column): the drawer's top edge is the body's top
	   edge — below the panel's header, tabs and toolbar — and its right edge is
	   the panel's, docked or expanded. Above the text column's own sticky review
	   bar (z-index 5); below the popovers that are portaled to the page
	   (Versions, Download: 130). */
	.comments-drawer {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		width: min(280px, 88%);
		background: var(--surface-page);
		border-left: 1px solid var(--border-default);
		box-shadow: var(--shadow-lg);
	}
</style>
