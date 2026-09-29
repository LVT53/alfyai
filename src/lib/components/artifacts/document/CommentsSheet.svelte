<script lang="ts">
/**
 * Comments away from the inline column (Feature 2 · Artifacts, Wave 2.5 Step
 * 8, redesign.md §3.2/§3.3/§9.2/§9.3; reworked after the owner's walk-through
 * of the redesign): a phone bottom sheet from the header's Comments button or
 * a tapped highlight, and a drawer over the right edge of the text on a
 * panel too narrow to hold the column beside it.
 *
 * Wraps `MarginPanel.svelte` AS ITS CONTENT — this file owns presentation
 * only, never comment state (`DocumentBody.svelte` does) — in its `grouped`
 * layout: there is no text beside a sheet or a drawer to sit next to, so it
 * is a plain stack, the refusal note first, then every tab's threads under
 * that tab's name, then the removed-text group (§3.2 "Phone").
 *
 * The drawer lives INSIDE the panel it belongs to: it slides in from the
 * panel's own right edge, starts below the panel's header, tabs and toolbar
 * (so the header's Comments button — the toggle that closes it — is never
 * covered), and follows the panel wherever it is, docked or expanded. It
 * used to be fixed to the browser window's edge from the top down, which
 * covered the panel's own actions and missed the expanded presentation
 * altogether.
 */
import { fly } from "svelte/transition";
import type { ComponentProps } from "svelte";
import DialogShell, {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import { focusTrap } from "$lib/utils/focus-trap";
import { reducedMotionAware } from "$lib/utils/motion";
// MarginPanel is a genuine runtime import for the two <MarginPanel {...} />
// mounts in the template below, on top of typing MarginPanelProps via
// ComponentProps<typeof MarginPanel> — biome's import-usage check only sees
// this script block, not the template, so it reads as type-only.
// biome-ignore lint/style/useImportType: see above — import type would break both template mounts
import MarginPanel from "./MarginPanel.svelte";

type MarginPanelProps = Omit<
	ComponentProps<typeof MarginPanel>,
	"layout" | "onClose" | "revealRequest"
>;

let {
	presentation,
	onClose,
	...marginPanelProps
}: MarginPanelProps & {
	/** "sheet" on phones (a `DialogShell`), "drawer" on a narrow desktop panel (redesign §3.2) — the caller already knows which from its own viewport/container-width tracking, so this component only ever renders ONE shape at a time. */
	presentation: "sheet" | "drawer";
	onClose: () => void;
} = $props();

/** The quote button and a click on a card jump back into the main text — closing first so the reader can actually see the flash-scroll it triggers, on both the phone sheet (which otherwise fully covers the text) and the narrow drawer (which covers its own edge of it). */
function handleGotoAnchor(blockId: string, from: number, to: number): void {
	marginPanelProps.onGotoAnchor?.(blockId, from, to);
	onClose();
}

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
	<!-- `MarginPanel` already draws its own "Comments" `<h2>` (plus the count
	     and the "N resolved" toggle) as its header — `titleVisuallyHidden`
	     keeps `DialogShell`'s title as the sheet's ACCESSIBLE name without a
	     second, visually duplicate heading. -->
	<!-- zIndexClass: this sheet opens from a button INSIDE
	     `DocumentWorkspace.svelte`'s mobile shell, whose own
	     `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's
	     default `z-50` renders behind it (found by screenshot, not by any
	     role/text query: the sheet is still genuinely "visible" and
	     interactive to Testing Library/Playwright, just painted under the
	     backdrop). Same fix, same value, same reasoning as
	     `MobileToolbar.svelte`'s own "More" sheet. -->
	<DialogShell
		title={$t('artifacts.document.margin.title')}
		titleVisuallyHidden
		phonePresentation="sheet"
		zIndexClass="z-[150]"
		onClose={onClose}
	>
		<MarginPanel {...marginPanelProps} layout="grouped" onGotoAnchor={handleGotoAnchor} />
	</DialogShell>
{:else}
	<div
		class="comments-drawer"
		role="dialog"
		aria-modal="true"
		aria-label={$t('artifacts.document.margin.title')}
		data-testid="comments-drawer"
		{@attach drawerFocusTrap}
		transition:drawerFly={{ duration: 220, x: 280 }}
	>
		<!-- No second "Comments" heading and no separate header row: `MarginPanel`'s
		     own header carries the title, the count, the filter and — given
		     `onClose` — the close button, and `aria-label` above names the
		     dialog. -->
		<MarginPanel
			{...marginPanelProps}
			layout="grouped"
			onGotoAnchor={handleGotoAnchor}
			{onClose}
		/>
	</div>
{/if}

<style>
	/* Positioned against `.document-content` (the row holding the text and,
	   when there is room, the comment column): the drawer's top edge is the
	   text area's top edge — below the panel's header, tabs and toolbar — and
	   its right edge is the panel's, docked or expanded. Above the text
	   column's own sticky review bar (z-index 5); below the popovers that are
	   portaled to the page (Versions, Download: 130). */
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
