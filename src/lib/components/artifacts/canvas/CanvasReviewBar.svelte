<script lang="ts">
/**
 * The bar below a board Alfy changed (Feature 2 · Artifacts, Slice 3, ruling 63):
 * the shared `ReviewBar`, docked flush to the bottom of the board, driven by the
 * review controller. Prev and next centre the camera on each touched block,
 * "Keep all" keeps the change and "Undo all" takes the whole of it back — there
 * is no per-block Undo in v1. It is the Document's bar and the Document's words
 * for the buttons; only the sentence differs (a board changes blocks).
 *
 * The bar is there while a change waits and leaves the moment it is decided
 * (Keep, Undo): what is left to show after that is the pill's "Kept" or
 * "Undone · Redo", on the board.
 */
import { cubicIn, cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import { t } from "$lib/i18n";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import ReviewBar from "../ReviewBar.svelte";
import type { CanvasReviewController } from "./_lib/review-controller.svelte";

let { controller }: { controller: CanvasReviewController } = $props();

// Redesign §7.2 #12: rises from below and fades in; sinks and fades out. Under
// reduced motion both are instant.
const barFly = reducedMotionAware(fly);

let slot = $state<HTMLDivElement | undefined>();
let shown = $derived(
	controller.change !== null &&
		controller.status === "pending" &&
		controller.count > 0,
);

/** "Left 1 alone." goes to the notice that says what: its first control takes the focus. */
function seeRefused(): void {
	slot
		?.closest(".canvas-editor")
		?.querySelector<HTMLElement>('[data-testid="refusal-notice"] button')
		?.focus();
}
</script>

{#if shown}
	<div
		class="review-bar-slot"
		data-testid="canvas-review-bar"
		bind:this={slot}
		in:barFly={{ y: 16, duration: MOTION_DURATION.emphasis, easing: cubicOut }}
		out:barFly={{ y: 16, duration: MOTION_DURATION.standard, easing: cubicIn }}
	>
		<ReviewBar
			docked
			pendingCount={controller.count}
			refusedCount={controller.refusal?.items.length ?? 0}
			currentIndex={controller.index}
			summary={controller.summaryText}
			regionLabel={$t('artifacts.canvas.review.regionLabel')}
			onPrev={() => controller.step(-1)}
			onNext={() => controller.step(1)}
			onKeepAll={() => void controller.keep()}
			onUndoAll={() => void controller.undo()}
			onSeeRefused={controller.refusal ? seeRefused : undefined}
		/>
	</div>
{/if}

<style>
	/* Below the board, in the editor's column: the board and its toolbar are above it,
	   so it covers nothing (`docked`: flat, full width, a rule on top). */
	.review-bar-slot {
		flex: none;
		position: relative;
		z-index: 5;
	}
</style>
