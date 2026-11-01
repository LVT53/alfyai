<script lang="ts">
/**
 * Chat Scroller: how a person moves around a long conversation.
 *
 * Wide chat (`compact` false): a ruler of at most 13 ticks on the left edge,
 * with one orange mark that says where in the chat the reader is. Hovering it,
 * or pressing it (or Enter), opens a list of every turn; the current one is in
 * the middle and a press on any row jumps there.
 *
 * Narrow chat (`compact` true): nothing until the reader has left the bottom
 * (`showLatest`), then one capsule, "11 / 30" and a chevron. The number opens
 * the same list as a sheet, the chevron goes back to the latest message.
 *
 * It appears only once the conversation has enough turns (jump-rail.ts), and
 * adds one Tab stop to the page, however many turns there are. The rules live
 * in AGENTS.md ("Chat Scroller") and ADR-0043.
 */
import { ChevronDown } from "@lucide/svelte";
import { tick } from "svelte";
import { fade } from "svelte/transition";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { reducedMotionAware } from "$lib/utils/motion";
import { buildJumpRailTurns } from "./jump-rail";

let {
	messages,
	scrollToMessage,
	activeTurnId = null,
	compact = false,
	showLatest = false,
	onLatest = () => {},
}: {
	messages: ChatMessage[];
	scrollToMessage: (messageId: string) => void;
	/**
	 * The turn the reader is on. When null the last turn counts, which keeps a
	 * sensible mark before any scroll tracking has run.
	 */
	activeTurnId?: string | null;
	/** The chat is too narrow for the ruler: draw the capsule and a sheet. */
	compact?: boolean;
	/** The reader has left the bottom: the capsule is worth showing. */
	showLatest?: boolean;
	/** The capsule's chevron: go back to the latest message. */
	onLatest?: () => void;
} = $props();

/** The ruler never grows past this many ticks, however long the chat is. */
const MAX_TICKS = 13;
/** The pointer has to rest on the ruler this long before the list opens. */
const OPEN_DELAY_MS = 120;
/** ...and leave it this long before the list closes, so crossing it does nothing. */
const CLOSE_DELAY_MS = 180;

const fadeAware = reducedMotionAware(fade);

const turns = $derived(buildJumpRailTurns(messages));
const activeId = $derived(activeTurnId ?? turns.at(-1)?.id ?? null);
const activeIndex = $derived(
	Math.max(
		0,
		turns.findIndex((turn) => turn.id === activeId),
	),
);
const tickCount = $derived(Math.min(turns.length, MAX_TICKS));
/** Which tick the orange mark sits on: the reader's place, scaled to the ruler. */
const needle = $derived(
	turns.length <= 1
		? 0
		: Math.round((activeIndex / (turns.length - 1)) * (tickCount - 1)),
);

let open = $state(false);
/** Opened by a press or the keyboard, so it stays until closed; hover alone is not pinned. */
let pinned = $state(false);
let sheetOpen = $state(false);
let navRef = $state<HTMLElement | null>(null);
let triggerRef = $state<HTMLButtonElement | null>(null);
let listRef = $state<HTMLElement | null>(null);
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers() {
	if (openTimer) clearTimeout(openTimer);
	if (closeTimer) clearTimeout(closeTimer);
	openTimer = null;
	closeTimer = null;
}

$effect(() => clearTimers);

// The chat changed width under an open list: the other presentation starts closed.
$effect(() => {
	if (compact) {
		open = false;
		pinned = false;
	} else {
		sheetOpen = false;
	}
});

// A list opens with the current row in the middle of it.
$effect(() => {
	const list = listRef;
	if (!list) return;
	void tick().then(() => centreCurrentRow(list));
});

function centreCurrentRow(list: HTMLElement) {
	const row = list.querySelector<HTMLElement>("[data-current]");
	if (!row) return;
	const listBox = list.getBoundingClientRect();
	const rowBox = row.getBoundingClientRect();
	list.scrollTop +=
		rowBox.top - listBox.top - (list.clientHeight - rowBox.height) / 2;
}

function isHoverPointer(event: PointerEvent): boolean {
	// A finger or pen has no hover: its tap ends in a leave that would close the
	// list it just opened. Only a mouse (or an event that does not say) hovers.
	return event.pointerType !== "touch" && event.pointerType !== "pen";
}

function handlePointerEnter(event: PointerEvent) {
	if (!isHoverPointer(event)) return;
	clearTimers();
	if (open) return;
	openTimer = setTimeout(() => {
		open = true;
	}, OPEN_DELAY_MS);
}

function handlePointerLeave(event: PointerEvent) {
	if (!isHoverPointer(event)) return;
	clearTimers();
	if (!open || pinned) return;
	closeTimer = setTimeout(() => {
		open = false;
	}, CLOSE_DELAY_MS);
}

function closeList(returnFocus: boolean) {
	clearTimers();
	open = false;
	pinned = false;
	if (returnFocus) triggerRef?.focus();
}

async function handleTriggerClick(event: MouseEvent) {
	clearTimers();
	// A click that came from Enter or Space has no pointer position.
	const fromKeyboard = event.detail === 0;
	if (open && pinned) {
		closeList(fromKeyboard);
		return;
	}
	open = true;
	pinned = true;
	if (fromKeyboard) {
		await tick();
		listRef
			?.querySelector<HTMLElement>("[data-current]")
			?.focus({ preventScroll: true });
	}
}

function handleWindowPointerDown(event: PointerEvent) {
	if (!open) return;
	if (navRef && event.target instanceof Node && navRef.contains(event.target)) {
		return;
	}
	closeList(false);
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (!open) return;
	if (event.key === "Escape") {
		event.preventDefault();
		closeList(!!navRef?.contains(document.activeElement));
		return;
	}
	if (event.target instanceof Node && listRef?.contains(event.target)) {
		moveRowFocus(event);
	}
}

function handleFocusOut(event: FocusEvent) {
	// Tab out of the list: it should not stay open behind the next control.
	if (!open) return;
	if (
		event.relatedTarget instanceof Node &&
		navRef &&
		!navRef.contains(event.relatedTarget)
	) {
		closeList(false);
	}
}

function moveRowFocus(event: KeyboardEvent) {
	const rows = Array.from(
		listRef?.querySelectorAll<HTMLElement>("[data-jump-row]") ?? [],
	);
	if (rows.length === 0) return;
	const at = rows.indexOf(document.activeElement as HTMLElement);
	let next = -1;
	if (event.key === "ArrowDown") next = Math.min(rows.length - 1, at + 1);
	else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = rows.length - 1;
	if (next < 0) return;
	event.preventDefault();
	rows[next].focus();
}

function jump(id: string) {
	scrollToMessage(id);
	closeList(true);
	sheetOpen = false;
}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

{#if turns.length > 0}
	{#if !compact}
		<nav
			class="jr"
			data-testid="conversation-jump-rail"
			aria-label={$t("chat.jumpRailA11yLabel")}
			bind:this={navRef}
			onpointerenter={handlePointerEnter}
			onpointerleave={handlePointerLeave}
			onfocusout={handleFocusOut}
		>
			<button
				type="button"
				class="jr-trigger"
				data-testid="jump-rail-trigger"
				bind:this={triggerRef}
				aria-expanded={open}
				aria-label={$t("chat.jumpRailMobileOpen")}
				onclick={handleTriggerClick}
			>
				<span class="jr-ruler" style="--needle: {needle};">
					{#each { length: tickCount } as _, i (i)}
						<span class="jr-tick" data-testid="jump-rail-tick"></span>
					{/each}
					<span class="jr-needle" data-testid="jump-rail-needle"></span>
				</span>
			</button>

			{#if open}
				<div class="jr-card" data-testid="jump-rail-list" bind:this={listRef}>
					{@render rows(false)}
				</div>
			{/if}
		</nav>
	{:else if showLatest}
		<div
			class="jr-capsule"
			data-testid="jump-rail-capsule"
			transition:fadeAware={{ duration: 150 }}
		>
			<button
				type="button"
				class="jr-capsule__where"
				data-testid="jump-rail-capsule-where"
				aria-label={$t("chat.jumpRailMobileOpen")}
				aria-haspopup="dialog"
				aria-expanded={sheetOpen}
				onclick={() => (sheetOpen = true)}
			>
				<span class="jr-capsule__now">{activeIndex + 1}</span>
				<span class="jr-capsule__of">/ {turns.length}</span>
			</button>
			<button
				type="button"
				class="jr-capsule__latest"
				data-testid="jump-rail-capsule-latest"
				aria-label={$t("chat.jumpToLatest")}
				onclick={onLatest}
			>
				<ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
	{/if}

	{#if compact && sheetOpen}
		<DialogShell
			title={$t("chat.jumpRailMobileTitle")}
			onClose={() => (sheetOpen = false)}
			phonePresentation="sheet"
		>
			<div class="jr-sheet-list" data-testid="jump-rail-sheet" bind:this={listRef}>
				{@render rows(true)}
			</div>
		</DialogShell>
	{/if}
{/if}

{#snippet rows(inSheet: boolean)}
	{#each turns as turn, i (turn.id)}
		<button
			type="button"
			class="jr-row"
			data-testid="jump-rail-row"
			data-jump-row=""
			data-current={turn.id === activeId ? "" : undefined}
			aria-current={turn.id === activeId ? "true" : undefined}
			tabindex={inSheet ? undefined : -1}
			onclick={() => jump(turn.id)}
		>
			{turn.label || i + 1}
		</button>
	{/each}
{/snippet}

<style>
	/* The whole height above the composer, so the ruler and its list sit in the
	   middle of what can actually be seen and the list never slides under the
	   composer. Only the trigger and the list take the pointer. */
	.jr {
		position: absolute;
		left: var(--space-sm);
		top: 0;
		bottom: var(--composer-layer-height, 0px);
		z-index: 5;
		display: flex;
		align-items: center;
		pointer-events: none;
	}

	.jr-trigger {
		display: block;
		padding: var(--space-sm);
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		cursor: pointer;
		pointer-events: auto;
	}

	.jr-trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* The same size at every length; only the orange mark moves. */
	.jr-ruler {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 18px;
	}

	.jr-tick {
		display: block;
		width: 11px;
		height: 1.5px;
		border-radius: 1px;
		background: color-mix(in srgb, var(--text-primary) 20%, transparent);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.jr:hover .jr-tick {
		background: color-mix(in srgb, var(--text-primary) 34%, transparent);
	}

	/* One step is a tick (1.5px) plus its gap (6px). */
	.jr-needle {
		position: absolute;
		left: 0;
		top: 0;
		width: 18px;
		height: 2.5px;
		border-radius: 1.25px;
		background: var(--accent);
		transform: translateY(calc(var(--needle) * 7.5px - 0.5px));
		transition: transform var(--duration-emphasis) var(--ease-out);
	}

	.jr-card {
		position: absolute;
		left: calc(100% + 4px);
		top: 50%;
		transform: translateY(-50%);
		width: 300px;
		max-height: min(420px, calc(100% - var(--space-md)));
		overflow: hidden auto;
		padding: 5px;
		pointer-events: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-page);
		box-shadow: var(--shadow-lg);
		overscroll-behavior: contain;
		animation: jr-card-in var(--duration-micro) var(--ease-out);
	}

	@keyframes jr-card-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* A row reads as a ToolActivityRow: one quiet line that fills on hover. */
	.jr-row {
		display: block;
		width: 100%;
		min-height: 30px;
		padding: 5px 9px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		line-height: 20px;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.jr-row:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.jr-row:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.jr-row[aria-current="true"],
	.jr-row[aria-current="true"]:hover {
		color: var(--accent-text);
		font-weight: 700;
	}

	/* Narrow chat: one capsule, only once the reader has left the bottom. */
	.jr-capsule {
		position: absolute;
		right: var(--space-md);
		bottom: max(8rem, calc(var(--composer-layer-height, 0px) + var(--space-sm)));
		z-index: 6;
		display: inline-flex;
		align-items: stretch;
		height: 40px;
		border: 1px solid var(--border-default);
		border-radius: 999px;
		background: var(--surface-elevated);
		box-shadow: var(--shadow-md);
		overflow: hidden;
	}

	.jr-capsule button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.jr-capsule button:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.jr-capsule__where {
		gap: 3px;
		min-width: 44px;
		padding: 0 6px 0 14px;
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		letter-spacing: 0;
	}

	.jr-capsule__now {
		font-weight: 700;
		color: var(--text-primary);
	}

	.jr-capsule__of {
		color: var(--text-muted);
	}

	.jr-capsule__latest {
		width: 44px;
		color: var(--text-secondary);
	}

	.jr-sheet-list {
		max-height: 60dvh;
		overflow-y: auto;
		margin: 0 calc(var(--space-sm) * -1);
		padding-bottom: var(--space-sm);
		overscroll-behavior: contain;
	}

	.jr-sheet-list .jr-row {
		min-height: 44px;
		padding: 12px var(--space-sm);
		font-size: var(--text-base);
		line-height: 20px;
	}
</style>
