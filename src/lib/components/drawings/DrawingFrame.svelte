<script lang="ts">
/**
 * The box every drawing is drawn in.
 *
 * A drawing is designed at 330 by 222 design pixels and shown at whatever
 * width its container gives it, with the proportions it was designed in. The
 * frame is a container (`container-type: inline-size`) whose height comes from
 * `aspect-ratio`, and it hands its parts one design pixel, `--u`: a part sizes
 * itself as `calc(var(--u) * 12)`, never in `rem` and in `px` only for a 1px
 * border; a column may be a `%` of the frame (a drawing's two panes are). The
 * container's own width is known at the first paint, so nothing is measured and
 * nothing jumps after hydration; where the frame's inside is 330 px wide, `--u`
 * is 1px.
 *
 * A campaign picture is drawn the same way at the size of its crop: 352 by 220
 * for the desktop's 16:10, 198 by 352 for the phone's 9:16. It is `bare`, with
 * no border and no rounded corners, because the campaign window frames it.
 *
 * It is decorative (`aria-hidden`): everything a drawing shows is also said in
 * the words around it, and nothing inside it may take focus.
 */
import type { Snippet } from "svelte";

let {
	children = undefined,
	width = 330,
	height = 222,
	bare = false,
}: {
	children?: Snippet | undefined;
	/** The drawing's size in design pixels. */
	width?: number;
	height?: number;
	/** No border and no rounded corners: the picture's own frame draws them. */
	bare?: boolean;
} = $props();
</script>

<div
	class="drawing-frame"
	class:bare
	data-testid="drawing-frame"
	aria-hidden="true"
	style:--design-width={width}
	style:--design-height={height}
>
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
		aspect-ratio: var(--design-width) / var(--design-height);
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

	.drawing-frame.bare {
		border: 0;
		border-radius: 0;
	}

	/* The frame cannot size itself in its own container's units, so the parts
	   live in a stage inside it. `cqw` is read where `--u` is used: by a part
	   in the stage, whose container is the frame. */
	.drawing-stage {
		--u: calc(100cqw / var(--design-width));
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
