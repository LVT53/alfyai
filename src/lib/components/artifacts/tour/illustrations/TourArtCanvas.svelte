<script lang="ts">
/**
 * The Canvas tour's picture: a frame with a sticky note and a block in it, and
 * a hand-drawn stroke across the bottom of the board.
 *
 * AGENTS.md says every UI icon comes from Lucide, with named exceptions (the
 * brand mark, data-visualisation SVGs, and drawings with no Lucide
 * equivalent). This is an illustration, not an icon, and no Lucide glyph
 * depicts "a board with a note, a block and a stroke on it": the tour needs the
 * thing itself, not a symbol for it. It is token-coloured, decorative
 * (`aria-hidden`: the tour's own words already say what it is) and never a
 * control. A control's icon may not borrow this reasoning.
 */
let { class: className = undefined }: { class?: string | undefined } = $props();
</script>

<svg
	class={className}
	data-kind="canvas"
	viewBox="0 0 96 96"
	width="100%"
	height="100%"
	aria-hidden="true"
	focusable="false"
>
	<rect class="frame" x="9" y="11" width="78" height="74" rx="6" />
	<rect class="note" x="17" y="20" width="29" height="25" rx="3" />
	<rect class="note-line" x="22" y="26" width="19" height="3" rx="1.5" />
	<rect class="note-line" x="22" y="32" width="13" height="3" rx="1.5" />
	<rect class="block" x="53" y="22" width="26" height="22" rx="3" />
	<rect class="block-head" x="53" y="22" width="26" height="7" rx="3" />
	<rect class="block-line" x="58" y="34" width="16" height="3" rx="1.5" />
	<path class="join" d="M46 33 H53" />
	<path class="stroke" d="M17 68 C 26 56, 35 80, 47 66 S 66 58, 79 69" />
</svg>

<style>
	svg {
		display: block;
	}

	.frame {
		fill: none;
		stroke: color-mix(in srgb, var(--text-primary) 30%, transparent);
		stroke-width: 1;
		stroke-dasharray: 4 3;
	}

	.note {
		fill: var(--accent-tint);
		stroke: color-mix(in srgb, var(--accent) 45%, transparent);
		stroke-width: 1;
	}

	.note-line {
		fill: var(--accent);
		opacity: 0.6;
	}

	.block {
		fill: var(--surface-elevated);
		stroke: color-mix(in srgb, var(--text-primary) 22%, transparent);
		stroke-width: 1;
	}

	.block-head {
		fill: color-mix(in srgb, var(--text-primary) 12%, transparent);
	}

	.block-line {
		fill: var(--text-muted);
		opacity: 0.45;
	}

	.join {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.25;
		stroke-linecap: round;
		opacity: 0.7;
	}

	.stroke {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
