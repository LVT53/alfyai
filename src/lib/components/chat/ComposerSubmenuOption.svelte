<script lang="ts">
// One option of a picker the composer's "+" menu opens — a model, a style, an
// Atlas profile. The three pickers used to draw their options three ways (a
// row with a check, a bare line of text, a bordered card with a radio dot);
// this is the one row they share, drawn to the menu's own row metrics so a
// submenu reads as part of the menu it hangs off:
//
//   [optional leading mark] · label · muted meta              · check
//                             optional description, one muted line down
//
// The chosen option is marked by the check alone. A fill is what the pointer
// and the keyboard paint (the menu rows' accent wash), so "where I am" and
// "what is chosen" never look alike.
import { Check } from "@lucide/svelte";
import type { Snippet } from "svelte";

let {
	label,
	meta = null,
	description = null,
	selected = false,
	onSelect,
	leading = undefined,
	testId = undefined,
	optionId = undefined,
}: {
	label: string;
	/** A short muted clause on the label's line ("~2-5 min"). */
	meta?: string | null;
	/** What the option does, on a second muted line. */
	description?: string | null;
	selected?: boolean;
	onSelect: () => void;
	/** A mark before the label: the model's icon. */
	leading?: Snippet | undefined;
	testId?: string | undefined;
	optionId?: string | undefined;
} = $props();

const id = $props.id();
let describedBy = $derived(
	[meta ? `${id}-meta` : null, description ? `${id}-desc` : null]
		.filter(Boolean)
		.join(" ") || undefined,
);
</script>

<button
	type="button"
	role="option"
	class="submenu-option"
	class:submenu-option--selected={selected}
	class:submenu-option--described={Boolean(description)}
	aria-selected={selected}
	aria-labelledby={`${id}-label`}
	aria-describedby={describedBy}
	data-testid={testId}
	data-option-id={optionId}
	onclick={onSelect}
>
	{#if leading}
		<span class="submenu-option__lead" aria-hidden="true">{@render leading()}</span>
	{/if}
	<span class="submenu-option__body">
		<span class="submenu-option__line">
			<span class="submenu-option__label" id={`${id}-label`}>{label}</span>
			{#if meta}
				<span class="submenu-option__meta" id={`${id}-meta`}>{meta}</span>
			{/if}
		</span>
		{#if description}
			<span class="submenu-option__desc" id={`${id}-desc`}>{description}</span>
		{/if}
	</span>
	<span class="submenu-option__check" aria-hidden="true">
		{#if selected}
			<Check size={15} strokeWidth={2.2} />
		{/if}
	</span>
</button>

<style>
	/* The menu row's metrics (ComposerToolsMenu's `.menu-row`): 2.2rem tall,
	   0.34rem / 0.5rem padding, a 0.5rem radius, and the accent wash on
	   hover and keyboard focus. */
	.submenu-option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2.2rem;
		margin: 0;
		padding: 0.34rem 0.5rem;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		text-align: left;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.submenu-option--described {
		align-items: flex-start;
		padding-block: 0.45rem;
	}

	.submenu-option:hover,
	.submenu-option:focus-visible {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		border-radius: 0.5rem;
		outline: none;
	}

	.submenu-option:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.submenu-option__lead {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
	}

	.submenu-option__body {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 0.16rem;
		min-width: 0;
	}

	.submenu-option__line {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.submenu-option__label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-xs);
		line-height: 1.2;
	}

	.submenu-option--selected .submenu-option__label {
		font-weight: 600;
	}

	.submenu-option__meta {
		flex: 0 0 auto;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		line-height: 1.2;
	}

	.submenu-option__desc {
		color: var(--text-secondary);
		font-size: var(--text-2xs);
		line-height: 1.35;
	}

	/* A fixed slot, so a label does not move when its option is chosen. */
	.submenu-option__check {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 15px;
		min-height: 15px;
		color: var(--accent);
	}

	.submenu-option--described .submenu-option__check {
		margin-top: 0.06rem;
	}

	/* "Nothing you tap here is smaller than 44px" — the sheet's rows are the
	   menu sheet's rows. */
	:global(.composer-submenu--sheet) .submenu-option {
		min-height: 44px;
	}
</style>
