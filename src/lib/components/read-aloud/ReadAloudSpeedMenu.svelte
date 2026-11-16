<script lang="ts">
/**
 * The speed chip of read aloud's player and its menu (spec §4.3): six speeds,
 * changed at once without making the audio again (the player's `playbackRate`
 * keeps the pitch). The chip shows the speed in the UI language ("1,25×" in
 * Hungarian). The menu opens above it; ↑ and ↓ move between the speeds, Enter
 * picks one, and Esc or a click outside closes it and gives the focus back to
 * the chip.
 */
import { Check } from "@lucide/svelte";
import { tick } from "svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import { intlLocale } from "$lib/utils/locale";

let {
	speed,
	onSelect,
}: {
	speed: number;
	onSelect: (value: number) => void;
} = $props();

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

let open = $state(false);
let root = $state<HTMLElement | null>(null);
let chip = $state<HTMLButtonElement | null>(null);
let items = $state<Array<HTMLButtonElement | null>>([]);

/** "1,25×": the number in the UI language, then ×. */
function format(value: number): string {
	return `${new Intl.NumberFormat(intlLocale($uiLanguage), {
		maximumFractionDigits: 2,
	}).format(value)}×`;
}

async function openMenu(): Promise<void> {
	open = true;
	await tick();
	const checked = (SPEEDS as readonly number[]).indexOf(speed);
	items[checked >= 0 ? checked : 1]?.focus();
}

function close(giveFocusBack: boolean): void {
	if (!open) return;
	open = false;
	if (giveFocusBack) chip?.focus();
}

function toggle(): void {
	if (open) close(false);
	else void openMenu();
}

function pick(value: number): void {
	onSelect(value);
	close(true);
}

function move(to: number): void {
	const length = SPEEDS.length;
	items[((to % length) + length) % length]?.focus();
}

function onItemKeydown(
	event: KeyboardEvent,
	index: number,
	value: number,
): void {
	switch (event.key) {
		case "ArrowDown":
			event.preventDefault();
			move(index + 1);
			break;
		case "ArrowUp":
			event.preventDefault();
			move(index - 1);
			break;
		case "Home":
			event.preventDefault();
			move(0);
			break;
		case "End":
			event.preventDefault();
			move(SPEEDS.length - 1);
			break;
		case "Enter":
		case " ":
			// A button would click on its own; the menu is gone by then.
			event.preventDefault();
			pick(value);
			break;
		case "Escape":
			event.preventDefault();
			close(true);
			break;
		case "Tab":
			close(false);
			break;
	}
}

function onWindowClick(event: MouseEvent): void {
	if (open && root && !root.contains(event.target as Node)) close(false);
}

function onWindowKeydown(event: KeyboardEvent): void {
	// Esc with the focus on the chip, or anywhere else outside the items.
	if (open && event.key === "Escape") {
		event.preventDefault();
		close(true);
	}
}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div bind:this={root} class="speed">
	<button
		bind:this={chip}
		type="button"
		class="chip"
		data-testid="read-aloud-speed"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="{$t('readAloud.player.speed')}: {format(speed)}"
		onclick={toggle}
	>
		{format(speed)}
	</button>
	{#if open}
		<div
			class="menu"
			role="menu"
			aria-label={$t("readAloud.player.speed")}
			data-testid="read-aloud-speed-menu"
		>
			{#each SPEEDS as value, index (value)}
				<button
					bind:this={items[index]}
					type="button"
					class="item"
					role="menuitemradio"
					aria-checked={value === speed}
					tabindex={value === speed ? 0 : -1}
					onclick={() => pick(value)}
					onkeydown={(event) => onItemKeydown(event, index, value)}
				>
					<span class="mark" aria-hidden="true">
						{#if value === speed}<Check size={14} strokeWidth={2.2} />{/if}
					</span>
					{format(value)}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.speed {
		position: relative;
		flex: none;
	}

	.chip {
		min-width: 44px;
		height: 32px;
		padding: 0 10px;
		border: 0;
		border-radius: 16px;
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
		transition: background-color var(--duration-micro) var(--ease-out);
	}

	.chip:hover,
	.chip[aria-expanded='true'] {
		background: color-mix(in srgb, var(--text-primary) 7%, transparent);
	}

	.chip:focus-visible,
	.item:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.menu {
		position: absolute;
		right: 0;
		bottom: calc(100% + 8px);
		z-index: 30;
		display: flex;
		flex-direction: column;
		min-width: 104px;
		padding: 4px;
		border: 1px solid var(--border-subtle);
		border-radius: 12px;
		background: var(--surface-elevated);
		box-shadow: var(--shadow-md);
	}

	.item {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 0 12px 0 8px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
		text-align: left;
		cursor: pointer;
	}

	.item:hover {
		background: color-mix(in srgb, var(--text-primary) 7%, transparent);
	}

	.item[aria-checked='true'] {
		color: var(--accent);
	}

	.mark {
		display: inline-flex;
		width: 14px;
		height: 14px;
	}

	@media (max-width: 767px) {
		.chip {
			height: 44px;
		}

		.item {
			min-height: 44px;
		}
	}
</style>
