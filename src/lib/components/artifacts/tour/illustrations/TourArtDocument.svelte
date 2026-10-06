<script lang="ts">
/**
 * The Document tour's picture: a page with a title, three text lines and a
 * checklist row, one line marked the way Alfy's changes are.
 *
 * AGENTS.md says every UI icon comes from Lucide, with named exceptions (the
 * brand mark, data-visualisation SVGs, and drawings with no Lucide
 * equivalent). This is an illustration, not an icon, and no Lucide glyph
 * depicts "a page with a checklist on it": the tour needs the
 * thing itself, not a symbol for it. It is token-coloured, decorative
 * (`aria-hidden`: the tour's own words already say what it is) and never a
 * control. A control's icon may not borrow this reasoning.
 */
let { class: className = undefined }: { class?: string | undefined } = $props();
</script>

<svg
	class={className}
	data-kind="document"
	viewBox="0 0 96 96"
	width="100%"
	height="100%"
	aria-hidden="true"
	focusable="false"
>
	<rect class="page" x="18" y="9" width="60" height="78" rx="4" />
	<rect class="title" x="26" y="18" width="34" height="5" rx="2.5" />
	<rect class="line" x="26" y="30" width="44" height="3" rx="1.5" />
	<!-- The line Alfy changed: the same quiet bar the editor draws beside it. -->
	<rect class="mark" x="22" y="36" width="2" height="9" rx="1" />
	<rect class="line" x="26" y="37" width="40" height="3" rx="1.5" />
	<rect class="line" x="26" y="43" width="30" height="3" rx="1.5" />
	<rect class="box on" x="26" y="55" width="9" height="9" rx="2.5" />
	<path class="tick" d="M28.4 59.6 L30.4 61.6 L33.2 57.8" />
	<rect class="line" x="39" y="57.5" width="28" height="4" rx="2" />
	<rect class="box" x="26" y="69" width="9" height="9" rx="2.5" />
	<rect class="line" x="39" y="71.5" width="22" height="4" rx="2" />
</svg>

<style>
	svg {
		display: block;
	}

	.page {
		fill: var(--surface-elevated);
		stroke: color-mix(in srgb, var(--text-primary) 22%, transparent);
		stroke-width: 1;
	}

	.title {
		fill: var(--text-primary);
		opacity: 0.78;
	}

	.line {
		fill: var(--text-muted);
		opacity: 0.45;
	}

	.mark {
		fill: var(--accent);
	}

	.box {
		fill: transparent;
		stroke: var(--text-muted);
		stroke-width: 1.25;
		opacity: 0.8;
	}

	.box.on {
		fill: var(--accent-tint);
		stroke: var(--accent);
		opacity: 1;
	}

	.tick {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
