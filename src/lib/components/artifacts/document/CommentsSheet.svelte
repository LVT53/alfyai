<script lang="ts">
/**
 * Comments away from the inline rail (Feature 2 · Artifacts, Wave 2.5 Step 8,
 * redesign.md §3.2/§3.3/§9.2/§9.3): a phone bottom sheet from the header's
 * Comments button or a tapped highlight, and a 280px drawer over the right
 * edge of the text on a narrow desktop panel ("Below a panel width of 820 px
 * the rail becomes a 280 px drawer over the right edge of the text, toggled
 * by the header's Comments button").
 *
 * Wraps `MarginPanel.svelte` AS ITS CONTENT, unchanged — rd3a's own hand-off:
 * "Agent 3b's phone sheet / narrow drawer should reuse this component AS ITS
 * CONTENT and change only the wrapping chrome... the state
 * (activeCommentId/focusCommentRequest/commentAnchors) and the editor-side
 * event delegation already live in DocumentBody.svelte and need no new
 * plumbing for a narrower viewport, only a different presentation." This file
 * owns presentation only, never comment state.
 *
 * Deliberately never forwards `contentEl`: `MarginPanel`'s own "beside the
 * block" placement measures the TEXT's scroll container, which is not where
 * this component renders (a floating sheet/drawer, not the shared scroll
 * container `.document-content` — redesign §3.2's "one scroll" applies only
 * to the ≥820px inline rail). Withholding `contentEl` puts `MarginPanel` into
 * its own already-built fallback — "the plain stacked list… the moment there
 * is no room to place things beside anything" (`MarginPanel.svelte`'s own doc
 * comment) — exactly the shape a disconnected overlay needs, so there is
 * nothing new to build here for that case.
 */
import { X } from "@lucide/svelte";
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
import { portalToBody } from "$lib/utils/portal";
import MarginPanel from "./MarginPanel.svelte";

type MarginPanelProps = Omit<ComponentProps<typeof MarginPanel>, "contentEl">;

let {
	presentation,
	onClose,
	...marginPanelProps
}: MarginPanelProps & {
	/** "sheet" on phones (a `DialogShell`), "drawer" on a narrow desktop panel (redesign §3.2) — the caller already knows which from its own viewport/container-width tracking, so this component only ever renders ONE shape at a time. */
	presentation: "sheet" | "drawer";
	onClose: () => void;
} = $props();

/** The quote button ("goes to the anchor") jumps back into the main text — closing first so the reader can actually see the flash-scroll it triggers, on both the phone sheet (which otherwise fully covers the text) and the narrow drawer (which covers its own edge of it). */
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
	<!-- `MarginPanel` already draws its own "Comments" `<h2>` (plus the "N
	     resolved" toggle) as its rail header — `titleVisuallyHidden` keeps
	     `DialogShell`'s title as the sheet's ACCESSIBLE name without a second,
	     visually duplicate heading. -->
	<DialogShell
		title={$t('artifacts.document.margin.title')}
		titleVisuallyHidden
		phonePresentation="sheet"
		onClose={onClose}
	>
		<MarginPanel {...marginPanelProps} onGotoAnchor={handleGotoAnchor} />
	</DialogShell>
{:else}
	<div
		class="comments-drawer"
		role="dialog"
		aria-modal="true"
		aria-label={$t('artifacts.document.margin.title')}
		data-testid="comments-drawer"
		use:portalToBody
		{@attach drawerFocusTrap}
		transition:drawerFly={{ duration: 220, x: 280 }}
	>
		<!-- Same reasoning as the sheet above: no second "Comments" heading
		     here — `MarginPanel`'s own header row is the first thing inside
		     `.comments-drawer-body`, and `aria-label` on this dialog already
		     carries the accessible name. -->
		<div class="comments-drawer-head">
			<button
				type="button"
				class="btn-icon-bare"
				onclick={onClose}
				aria-label={$t('common.close')}
			>
				<X size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
		<div class="comments-drawer-body">
			<MarginPanel {...marginPanelProps} onGotoAnchor={handleGotoAnchor} />
		</div>
	</div>
{/if}

<style>
	/* Fixed to the viewport's own right edge rather than measured against the
	   panel's rect: correct for the panel's default docked presentation
	   (flush against the viewport's right edge, and the only presentation
	   narrow enough to ever reach the 820px threshold at the widths this
	   feature ships screenshots for — see the brief). The panel's separate
	   "expanded" (centred, margins on both sides) presentation is not
	   width-matched against this drawer; a future pass can measure the
	   panel's own rect the way `VersionsSheet.svelte`/`DownloadSheet.svelte`
	   measure their trigger buttons, if that combination ever needs it. */
	.comments-drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 55;
		display: flex;
		flex-direction: column;
		width: 280px;
		max-width: 88vw;
		background: var(--surface-page);
		border-left: 1px solid var(--border-default);
		box-shadow: var(--shadow-lg);
	}

	.comments-drawer-head {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex: 0 0 auto;
		padding: 0.5rem 0.5rem 0 0;
	}

	.comments-drawer-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
</style>
