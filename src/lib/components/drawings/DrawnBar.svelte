<script lang="ts">
/**
 * A grey line standing for text. Content in a drawing (a message, a title, a
 * name) is never words: words would need their own translation and would date.
 */
let {
	width = "100%",
	tone = "strong",
	thick = false,
}: {
	/** A CSS width, usually a share of the line the bar sits in. */
	width?: string;
	/** `strong` is a title or a name, `soft` running text, `change` text Alfy
	 *  changed, `accent` a figure the screen sets in the accent (Your Activity's total). */
	tone?: "strong" | "soft" | "change" | "accent";
	/** A title's line is a little taller than the text's. */
	thick?: boolean;
} = $props();
</script>

<span
	class="drawn-bar"
	class:soft={tone === 'soft'}
	class:change={tone === 'change'}
	class:accent={tone === 'accent'}
	class:thick
	style:width
></span>

<style>
	.drawn-bar {
		display: block;
		flex: none;
		max-width: 100%;
		height: calc(var(--u) * 5);
		border-radius: calc(var(--u) * 3);
		background: color-mix(in srgb, var(--text-primary) 15%, transparent);
	}

	.drawn-bar.soft {
		background: color-mix(in srgb, var(--text-primary) 8%, transparent);
	}

	/* Text Alfy changed, as the Document marks it. */
	.drawn-bar.change {
		background: var(--alfy-mark);
		box-shadow: inset 0 calc(var(--u) * -1) 0 var(--accent);
	}

	/* A figure in the accent, as the activity total is set. */
	.drawn-bar.accent {
		background: var(--accent);
	}

	.drawn-bar.thick {
		height: calc(var(--u) * 7);
	}
</style>
