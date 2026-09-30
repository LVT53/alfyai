<script lang="ts">
/**
 * The rows of the Insert menu: what a reader can put on the board, in two
 * groups (what they write, and blocks that carry content of their own), then
 * "From this chat" — the files, Apps, maps, charts, photos and web searches the
 * board's own chat made, and a new web search typed into the menu.
 * It is one menu with one tab stop and arrow keys between every row; the popover
 * or sheet around it, its Escape and its focus return belong to `AnchoredPopover`.
 *
 * "From this chat" is its own component, loaded when the menu opens and only where
 * there is a chat to read (`useChatContext().load`): a board that never inserts a
 * block from the chat never pays for it. The arrow keys read the rows from the DOM
 * when a key is pressed, so the rows that arrive after the chat has been read join
 * the same order without this menu knowing what they are.
 */
import { onMount } from "svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { useChatContext } from "./_lib/chat-context";
import type { BlockRegistryEntry } from "./_lib/block-registry";
import type ChatBlocksSection from "./chat-blocks/ChatBlocksSection.svelte";
import type { ChatBlockKind } from "./chat-blocks/chat-block-data";

let {
	rows,
	entryFor,
	onpick,
}: {
	/** The rows the menu offers, in the order they are listed. Handed in by the toolbar, which the editor already carries: this menu loads on demand and must not bring the registry (and the library it draws) into a chunk of its own. */
	rows: readonly BlockRegistryEntry[];
	/** A kind's registry row (its glyph, its schema). */
	entryFor: (kind: string) => BlockRegistryEntry | null | undefined;
	/** The row that was picked, and — for a block made from the chat — the data the chat made. */
	onpick: (row: BlockRegistryEntry, data?: CanvasBlockData) => void;
} = $props();

const chat = useChatContext();
const groups = $derived(
	[
		rows.filter((row) => row.section === "text"),
		rows.filter((row) => row.section === "blocks"),
	].filter((group) => group.length > 0),
);

let active = $state(0);
let menu = $state<HTMLElement | null>(null);
let Section = $state.raw<typeof ChatBlocksSection | null>(null);

// The section is fetched when the menu opens, not before: nothing about it is
// needed for a board's first paint.
onMount(() => {
	if (!chat.load) return;
	let current = true;
	void import("./chat-blocks/ChatBlocksSection.svelte").then((module) => {
		if (current) Section = module.default;
	});
	return () => {
		current = false;
	};
});

/** The glyph of a block kind, for the section (which is loaded on demand and so does not import the registry itself). */
function iconFor(kind: ChatBlockKind) {
	return entryFor(kind)?.icon;
}

function pickFromChat(kind: ChatBlockKind, data: CanvasBlockData): void {
	const row = entryFor(kind);
	// What lands on the board is what the board would keep: data its own schema
	// would refuse (a photo that is not the app's own thumbnail, a source that is
	// not a web address) is never put there, rather than put there and left out
	// by the next save.
	if (row?.schema.safeParse(data).success) onpick(row, data);
}

/** Every row there is right now, written ones first, in the order they are drawn. */
function allRows(): HTMLButtonElement[] {
	return menu
		? [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
		: [];
}

function move(to: number): void {
	const all = allRows();
	if (all.length === 0) return;
	all[(to + all.length) % all.length]?.focus();
}

function handleKeydown(event: KeyboardEvent): void {
	// A field inside the menu (the web search's query) keeps its own keys: the
	// arrows, Home and End move the cursor in what is being typed, not the focus.
	if (
		event.target instanceof HTMLInputElement ||
		event.target instanceof HTMLTextAreaElement
	) {
		return;
	}
	const all = allRows();
	const current = all.indexOf(document.activeElement as HTMLButtonElement);
	const from = current === -1 ? active : current;
	if (event.key === "ArrowDown" || event.key === "ArrowRight") {
		event.preventDefault();
		move(from + 1);
	} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
		event.preventDefault();
		move(from - 1);
	} else if (event.key === "Home") {
		event.preventDefault();
		move(0);
	} else if (event.key === "End") {
		event.preventDefault();
		move(all.length - 1);
	}
}
</script>

<!-- The keys are the menu's own: the rows are the buttons that take them. -->
<div
	class="insert-menu"
	role="menu"
	tabindex="-1"
	aria-label={$t("artifacts.canvas.insert.block")}
	data-testid="canvas-insert-menu-list"
	bind:this={menu}
	onkeydown={handleKeydown}
>
	{#each groups as group, groupIndex (groupIndex)}
		<div class="insert-menu__group" role="group">
			{#each group as row (row.kind)}
				{@const index = rows.indexOf(row)}
				{@const Icon = row.icon}
				<button
					type="button"
					role="menuitem"
					class="insert-menu__row"
					tabindex={index === active ? 0 : -1}
					data-testid="canvas-insert-{row.kind}"
					onfocus={() => (active = index)}
					onclick={() => onpick(row)}
				>
					<Icon size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>{$t(row.labelKey as I18nKey)}</span>
				</button>
			{/each}
		</div>
	{/each}
	{#if Section && chat.load}
		<Section load={chat.load} onpick={pickFromChat} iconFor={iconFor} search={chat.searchWeb} />
	{/if}
</div>

<style>
	.insert-menu {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 0 6px 6px;
	}

	.insert-menu__group {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
	}

	.insert-menu__group + .insert-menu__group {
		padding-top: 4px;
		border-top: 1px solid var(--border-subtle);
	}

	.insert-menu__row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 7px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-md);
		text-align: left;
		cursor: pointer;
	}

	.insert-menu__row:hover {
		background: var(--surface-elevated);
	}

	.insert-menu__row:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.insert-menu__row {
			min-height: 44px;
		}
	}
</style>
