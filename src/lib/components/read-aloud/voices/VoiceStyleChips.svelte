<script lang="ts">
/** The seven styles (spec §4.6) as chips; the one the knobs match is pressed. */
import { t } from "$lib/i18n";
import {
	type Knobs,
	matchingStyle,
	STYLES,
	type StyleKey,
} from "$lib/shared/read-aloud/voice-knobs";

let {
	knobs,
	onPick,
}: {
	knobs: Knobs;
	onPick: (style: StyleKey) => void;
} = $props();

const matched = $derived(matchingStyle(knobs));
</script>

<div class="voice-styles" role="group" aria-label={$t("readAloud.editor.style")}>
	{#each STYLES as style (style.key)}
		<button
			type="button"
			class="voice-style"
			aria-pressed={matched === style.key}
			onclick={() => onPick(style.key)}
		>
			{$t(`readAloud.style.${style.key}`)}
		</button>
	{/each}
</div>

<style>
	.voice-styles {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.voice-style {
		min-height: 32px;
		padding: 6px 12px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 12.5px;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.voice-style:hover {
		border-color: color-mix(in srgb, var(--text-primary) 30%, var(--border-default));
	}

	.voice-style[aria-pressed="true"] {
		border-color: var(--text-primary);
		background: var(--text-primary);
		color: var(--surface-page);
	}

	.voice-style:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	@media (max-width: 639px) {
		.voice-style {
			min-height: 36px;
		}
	}
</style>
