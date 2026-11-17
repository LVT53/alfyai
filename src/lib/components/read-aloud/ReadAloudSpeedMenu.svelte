<script lang="ts">
/**
 * The player's speed chip and its menu (spec §4.3): six speeds, applied at once
 * with the pitch kept. The chip writes the speed in the UI language ("1,25×").
 */
import { tick } from "svelte";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";

let { speed, onSelect }: { speed: number; onSelect: (v: number) => void } =
	$props();

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

let open = $state(false);
let wrapper = $state<HTMLDivElement | null>(null);
let chip = $state<HTMLButtonElement | null>(null);
let items = $state<HTMLButtonElement[]>([]);

const format = $derived(
	(value: number) => `${new Intl.NumberFormat($uiLanguage).format(value)}×`,
);

async function show() {
	open = true;
	await tick();
	const current = (SPEEDS as readonly number[]).indexOf(speed);
	items[current >= 0 ? current : 1]?.focus();
}

function close(refocus: boolean) {
	open = false;
	if (refocus) chip?.focus();
}

function pick(value: number) {
	onSelect(value);
	close(true);
}

function onItemKeydown(event: KeyboardEvent, index: number) {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		const step = event.key === "ArrowDown" ? 1 : -1;
		items[(index + step + SPEEDS.length) % SPEEDS.length]?.focus();
	} else if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		pick(SPEEDS[index] as number);
	} else if (event.key === "Escape") {
		event.preventDefault();
		close(true);
	} else if (event.key === "Tab") {
		close(false);
	}
}

$effect(() => {
	if (!open) return;
	const onPointerDown = (event: PointerEvent) => {
		if (
			wrapper &&
			event.target instanceof Node &&
			wrapper.contains(event.target)
		)
			return;
		close(false);
	};
	document.addEventListener("pointerdown", onPointerDown, true);
	return () => document.removeEventListener("pointerdown", onPointerDown, true);
});
</script>

<div class="read-aloud-speed" bind:this={wrapper}>
	<button
		bind:this={chip}
		type="button"
		class="read-aloud-speed-chip"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="{$t('readAloud.player.speed')}: {format(speed)}"
		onclick={() => (open ? close(false) : void show())}
	>
		{format(speed)}
	</button>
	{#if open}
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div
			class="read-aloud-speed-menu"
			role="menu"
			tabindex="-1"
			aria-label={$t("readAloud.player.speed")}
			onkeydown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					close(true);
				}
			}}
		>
			{#each SPEEDS as value, index (value)}
				<button
					bind:this={items[index]}
					type="button"
					role="menuitemradio"
					class="read-aloud-speed-item"
					aria-checked={value === speed ? "true" : "false"}
					onclick={() => pick(value)}
					onkeydown={(event) => onItemKeydown(event, index)}
				>
					{format(value)}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.read-aloud-speed {
		position: relative;
		display: inline-flex;
		flex: none;
	}

	.read-aloud-speed-chip {
		height: 34px;
		min-width: 54px;
		padding: 0 10px;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 12.5px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.read-aloud-speed-chip:hover {
		background: var(--surface-elevated);
	}

	.read-aloud-speed-chip:focus-visible,
	.read-aloud-speed-item:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	.read-aloud-speed-menu {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		z-index: 30;
		display: flex;
		flex-direction: column;
		min-width: 84px;
		padding: 4px;
		border: 1px solid var(--border-default);
		border-radius: 12px;
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
		transform: translateX(-50%);
	}

	.read-aloud-speed-item {
		padding: 7px 12px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		text-align: center;
		cursor: pointer;
	}

	.read-aloud-speed-item:hover {
		background: var(--surface-elevated);
	}

	.read-aloud-speed-item[aria-checked="true"] {
		color: var(--accent);
		font-weight: 600;
	}
</style>
