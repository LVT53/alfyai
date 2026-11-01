<script lang="ts">
/**
 * The Image tour's picture (plan 2b T16): a picture with a sun and two hills, one
 * Mark box drawn on it (its letter tab is a plain tab: the drawing has no words),
 * and the strip of earlier pictures under it, the current one ringed.
 *
 * AGENTS.md says every UI icon comes from Lucide, with named exceptions (the
 * brand mark, data-visualisation SVGs, and drawings with no Lucide
 * equivalent). This is an illustration, not an icon, and no Lucide glyph
 * depicts "a picture with a mark on it and its versions under it": the tour
 * needs the thing itself, not a symbol for it. It is token-coloured, decorative
 * (`aria-hidden`: the tour's own words already say what it is) and never a
 * control. A control's icon may not borrow this reasoning.
 */
let { class: className = undefined }: { class?: string | undefined } = $props();
</script>

<svg
	class={className}
	data-kind="image"
	viewBox="0 0 96 96"
	width="100%"
	height="100%"
	aria-hidden="true"
	focusable="false"
>
	<rect class="picture" x="12" y="10" width="72" height="54" rx="4" />
	<circle class="sun" cx="66" cy="24" r="6" />
	<path class="hill far" d="M12 56 L34 34 L52 52 L60 45 L84 60 V60 Q84 64 80 64 H16 Q12 64 12 60 Z" />
	<path class="hill near" d="M12 60 Q30 46 48 56 T84 58 V60 Q84 64 80 64 H16 Q12 64 12 60 Z" />
	<!-- One Mark box, drawn the way the panel draws it: an outline with its tab. -->
	<rect class="mark" x="22" y="20" width="22" height="18" rx="2" />
	<rect class="mark-tab" x="22" y="16" width="7" height="5" rx="1.5" />
	<!-- The strip of earlier pictures; the last is the one shown. -->
	<rect class="thumb" x="22" y="72" width="14" height="14" rx="2.5" />
	<rect class="thumb" x="41" y="72" width="14" height="14" rx="2.5" />
	<rect class="thumb current" x="60" y="72" width="14" height="14" rx="2.5" />
</svg>

<style>
	svg {
		display: block;
	}

	.picture {
		fill: var(--surface-elevated);
		stroke: color-mix(in srgb, var(--text-primary) 22%, transparent);
		stroke-width: 1;
	}

	.sun {
		fill: var(--accent);
		opacity: 0.55;
	}

	.hill.far {
		fill: var(--text-muted);
		opacity: 0.3;
	}

	.hill.near {
		fill: var(--text-muted);
		opacity: 0.5;
	}

	.mark {
		fill: color-mix(in srgb, var(--accent) 10%, transparent);
		stroke: var(--accent);
		stroke-width: 1.4;
	}

	.mark-tab {
		fill: var(--accent);
	}

	.thumb {
		fill: color-mix(in srgb, var(--text-muted) 22%, transparent);
		stroke: color-mix(in srgb, var(--text-primary) 18%, transparent);
		stroke-width: 1;
	}

	.thumb.current {
		fill: var(--accent-tint);
		stroke: var(--accent);
		stroke-width: 1.4;
	}
</style>
