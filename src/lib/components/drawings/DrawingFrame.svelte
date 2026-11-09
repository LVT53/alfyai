<script lang="ts">
/**
 * The box every drawing is drawn in.
 *
 * A drawing is designed at 330 by 222 design pixels and shown at whatever
 * width its container gives it, with the proportions it was designed in. The
 * frame is a container (`container-type: inline-size`) whose height comes from
 * `aspect-ratio`, and it hands its parts one design pixel, `--u`: a part sizes
 * itself as `calc(var(--u) * 12)` and never in `px`, `rem` or `%` of the
 * frame. The container's own width is known at the first paint, so nothing is
 * measured and nothing jumps after hydration; where the frame's inside is 330
 * px wide, `--u` is 1px.
 *
 * It is decorative (`aria-hidden`): everything a drawing shows is also said in
 * the words around it, and nothing inside it may take focus.
 */
import type { Snippet } from "svelte";

let { children = undefined }: { children?: Snippet | undefined } = $props();
</script>

<div class="drawing-frame" data-testid="drawing-frame" aria-hidden="true">
	<div class="drawing-stage">
		{@render children?.()}
	</div>
</div>

<style>
	.drawing-frame {
		container-type: inline-size;
		position: relative;
		box-sizing: border-box;
		width: 100%;
		aspect-ratio: 330 / 222;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-elevated);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-weight: 400;
		letter-spacing: normal;
		text-align: left;
		text-transform: none;
		user-select: none;
	}

	/* The frame cannot size itself in its own container's units, so the parts
	   live in a stage inside it. `cqw` is read where `--u` is used: by a part
	   in the stage, whose container is the frame. */
	.drawing-stage {
		--u: calc(100cqw / 330);
		position: absolute;
		inset: 0;
		font-size: calc(var(--u) * 9);
		line-height: 1.2;
	}

	/* A spot is a box the ring can surround, and the lit one paints above its
	   neighbours. Every spot is positioned by this rule, so a part sets no
	   `position` on one. */
	.drawing-stage :global([data-drawing-spot]) {
		position: relative;
	}

	.drawing-stage :global(.drawing-spot-lit) {
		z-index: 1;
	}

	/* A Lucide icon fills the box its part gives it: 11 design pixels, or what
	   `--ic` says (a number of them). */
	.drawing-stage :global(.drawn-ic) {
		display: inline-flex;
		flex: none;
		width: calc(var(--u) * var(--ic, 11));
		height: calc(var(--u) * var(--ic, 11));
	}
</style>
