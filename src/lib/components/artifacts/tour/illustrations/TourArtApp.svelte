<script lang="ts">
/**
 * The App tour's picture: a small panel with two controls, a slider and a
 * button, and the number they make.
 *
 * AGENTS.md says every UI icon comes from Lucide, with named exceptions (the
 * brand mark, data-visualisation SVGs, and drawings with no Lucide
 * equivalent). This is an illustration, not an icon, and no Lucide glyph
 * depicts "a little tool with a slider and a button": the tour needs the
 * thing itself, not a symbol for it. It is token-coloured, decorative
 * (`aria-hidden`: the tour's own words already say what it is) and never a
 * control. A control's icon may not borrow this reasoning.
 */
let { class: className = undefined }: { class?: string | undefined } = $props();
</script>

<svg
	class={className}
	data-kind="app"
	viewBox="0 0 96 96"
	width="100%"
	height="100%"
	aria-hidden="true"
	focusable="false"
>
	<rect class="panel" x="11" y="13" width="74" height="70" rx="6" />
	<path class="rule" d="M11.5 29.5 H84.5" />
	<circle class="dot" cx="20" cy="21.5" r="2" />
	<circle class="dot" cx="27" cy="21.5" r="2" />
	<circle class="dot" cx="34" cy="21.5" r="2" />
	<rect class="line" x="20" y="37" width="22" height="3" rx="1.5" />
	<rect class="track" x="20" y="46" width="56" height="4" rx="2" />
	<rect class="fill" x="20" y="46" width="32" height="4" rx="2" />
	<circle class="knob" cx="52" cy="48" r="5" />
	<rect class="button" x="20" y="60" width="34" height="14" rx="7" />
	<rect class="label" x="28" y="65" width="18" height="4" rx="2" />
	<rect class="readout" x="60" y="62" width="16" height="10" rx="3" />
</svg>

<style>
	svg {
		display: block;
	}

	.panel {
		fill: var(--surface-elevated);
		stroke: color-mix(in srgb, var(--text-primary) 22%, transparent);
		stroke-width: 1;
	}

	.rule {
		fill: none;
		stroke: var(--border-default);
		stroke-width: 1;
	}

	.dot {
		fill: var(--text-muted);
		opacity: 0.4;
	}

	.line {
		fill: var(--text-muted);
		opacity: 0.45;
	}

	.track {
		fill: color-mix(in srgb, var(--text-primary) 14%, transparent);
	}

	.fill {
		fill: var(--accent);
	}

	.knob {
		fill: var(--surface-page);
		stroke: var(--accent);
		stroke-width: 1.75;
	}

	.button {
		fill: var(--accent-tint);
		stroke: color-mix(in srgb, var(--accent) 45%, transparent);
		stroke-width: 1;
	}

	.label {
		fill: var(--accent);
	}

	.readout {
		fill: var(--surface-page);
		stroke: color-mix(in srgb, var(--text-primary) 22%, transparent);
		stroke-width: 1;
	}
</style>
