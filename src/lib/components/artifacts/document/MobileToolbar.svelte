<script lang="ts">
/**
 * The phone toolbar (Feature 2 · Artifacts, Slice 1, T11; redesign
 * §5.2/§9.2, Wave 2.5 Step 5): one row of 6 primary actions plus a `More`
 * trigger, instead of the desktop's full row. The prototype's single
 * toolbar was 226 px of an 844 px phone viewport (27 %) before its own fix,
 * and even the fixed prototype's row still measured 137 px (Review Focus 7)
 * — this row carries only format actions and stays within a 48 px budget
 * (`tests/e2e/artifact-document.spec.ts` asserts the real number in a real
 * browser; jsdom has no layout engine, so that assertion cannot live here).
 *
 * Built from the SAME `DOCUMENT_TOOLBAR_ACTIONS` list `DocumentToolbar.svelte`
 * uses — never a second, possibly-drifted set of ids (T11.2) — so "every
 * action in the desktop toolbar is reachable on mobile" is true by
 * construction: every id not on the primary row is in the sheet, and the
 * two lists partition `DOCUMENT_TOOLBAR_ACTIONS` exactly.
 *
 * The `More` sheet is `DialogShell` with `phonePresentation="sheet"`
 * (redesign §9.3's "reuse `DialogShell.svelte`… for every phone sheet"):
 * this drops a hand-rolled focus trap/backdrop/Escape handler in favour of
 * the shared one, and gains a title ("More formatting") and a real close
 * affordance (the grabber, `aria-label="Close"`) — redesign §5.2's "the More
 * sheet gets a title… and a close button", which the old bare
 * `aria-label`-only dialog never had.
 *
 * `zIndexClass="z-[150]"`: this toolbar (and the sheet it opens) is nested
 * INSIDE `DocumentWorkspace.svelte`'s mobile shell, whose own
 * `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's default
 * `z-50` would render the sheet BEHIND that blurred backdrop (invisible,
 * confirmed by screenshot: the sheet existed with correct geometry and
 * opacity, just painted under the backdrop). The old hand-rolled sheet used
 * `z-index: 140` for the same reason; 150 keeps the same margin above every
 * z-index in that file (highest today: 115, `.workspace-shell-expanded`).
 *
 * No `@tiptap/*` import — stays outside the lazy editor boundary (T7.8).
 */
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import { Ellipsis } from "@lucide/svelte";
import {
	DOCUMENT_TOOLBAR_ACTIONS,
	type DocumentToolbarActionId,
} from "./toolbar-actions";

/**
 * Six primary actions: the two most-reached-for marks (bold, italic), the
 * two structures a plan/checklist actually uses on a phone (a bulleted list,
 * and the task list §2.3 builds checklists from), a link (referencing is
 * common even in a short note) and undo (mistakes from touch typing are more
 * likely than on a keyboard, so recovery earns a direct slot). Everything
 * else — the second heading level, ordered lists, quote, table, redo — lives
 * in the `More` sheet.
 */
const PRIMARY_MOBILE_ACTION_IDS: readonly DocumentToolbarActionId[] = [
	"bold",
	"italic",
	"bulletList",
	"taskList",
	"link",
	"undo",
];

let {
	activeActionIds = new Set<DocumentToolbarActionId>(),
	disabled = false,
	onAction,
}: {
	activeActionIds?: ReadonlySet<DocumentToolbarActionId>;
	disabled?: boolean;
	onAction: (id: DocumentToolbarActionId) => void;
} = $props();

const primaryActions = PRIMARY_MOBILE_ACTION_IDS.map((id) =>
	DOCUMENT_TOOLBAR_ACTIONS.find((action) => action.id === id),
).filter((action) => action !== undefined);
const overflowActions = DOCUMENT_TOOLBAR_ACTIONS.filter(
	(action) => !PRIMARY_MOBILE_ACTION_IDS.includes(action.id),
);

let sheetOpen = $state(false);
let moreButtonEl = $state<HTMLButtonElement | undefined>();

function openSheet(): void {
	sheetOpen = true;
}

/** Closing always returns focus to the button that opened it (UI states: "Escape closes it and returns focus to the button that opened it") — DialogShell's own focus trap restores focus on cleanup, but the trigger is what it should land on here. */
function closeSheet(): void {
	sheetOpen = false;
	moreButtonEl?.focus();
}

function handleSheetAction(id: DocumentToolbarActionId): void {
	onAction(id);
	closeSheet();
}
</script>

<div
	class="mobile-toolbar"
	role="toolbar"
	aria-label={$t('artifacts.type.document')}
>
	{#each primaryActions as action (action.id)}
		{@const Icon = action.icon}
		{@const isActive = !action.momentary && activeActionIds.has(action.id)}
		{@const label = $t(action.labelKey, action.labelParams)}
		<button
			type="button"
			class="btn-icon-bare mobile-toolbar-button"
			class:mobile-toolbar-button-active={isActive}
			{disabled}
			aria-pressed={action.momentary ? undefined : isActive}
			aria-label={label}
			title={label}
			onclick={() => onAction(action.id)}
		>
			<Icon size={18} strokeWidth={2} aria-hidden="true" />
		</button>
	{/each}
	<button
		type="button"
		bind:this={moreButtonEl}
		class="btn-icon-bare mobile-toolbar-button"
		{disabled}
		aria-haspopup="dialog"
		aria-expanded={sheetOpen}
		aria-label={$t('artifacts.document.toolbar.more')}
		title={$t('artifacts.document.toolbar.more')}
		onclick={openSheet}
	>
		<Ellipsis size={18} strokeWidth={2} aria-hidden="true" />
	</button>
</div>

{#if sheetOpen}
	<DialogShell
		title={$t('artifacts.document.toolbar.moreSheetTitle')}
		onClose={closeSheet}
		phonePresentation="sheet"
		zIndexClass="z-[150]"
	>
		<div class="mobile-toolbar-sheet-grid">
			{#each overflowActions as action (action.id)}
				{@const Icon = action.icon}
				{@const isActive = !action.momentary && activeActionIds.has(action.id)}
				{@const label = $t(action.labelKey, action.labelParams)}
				<button
					type="button"
					class="mobile-toolbar-sheet-item"
					class:mobile-toolbar-sheet-item-active={isActive}
					{disabled}
					aria-pressed={action.momentary ? undefined : isActive}
					onclick={() => handleSheetAction(action.id)}
				>
					<Icon size={16} strokeWidth={2} aria-hidden="true" />
					<span>{label}</span>
				</button>
			{/each}
		</div>
	</DialogShell>
{/if}

<style>
	/*
	 * The row's total height is its border plus the tallest child (the
	 * buttons) — box-sizing is border-box (Tailwind's Preflight,
	 * `src/app.css`), so a button's own padding does NOT add to its
	 * `min-height`. The buttons are the 44px phone target (redesign §5.4;
	 * review 233-238; the global `.btn-icon-bare` rule in `src/app.css` says the
	 * same), so the row has no vertical padding of its own: budget, at 390×844
	 * (T11.1, the prototype's own 226px/137px figures being exactly what this
	 * stays well under): 1px border + 44px button = 45px ≤ 48px. Seven buttons
	 * and their gaps are 320px, which fits a 360px phone with the 8px sides.
	 */
	.mobile-toolbar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0 0.5rem;
		border-bottom: 1px solid var(--border-subtle);
		background-color: var(--surface-page);
	}

	.mobile-toolbar-button {
		min-height: 44px;
		min-width: 44px;
		padding: 0.25rem;
	}

	.mobile-toolbar-button-active {
		color: var(--text-primary);
		background-color: var(--surface-elevated);
	}

	.mobile-toolbar-button:disabled {
		color: var(--text-muted);
		cursor: not-allowed;
		opacity: 0.5;
	}

	.mobile-toolbar-button:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.mobile-toolbar-sheet-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.5rem;
		max-height: 50vh;
		overflow-y: auto;
	}

	.mobile-toolbar-sheet-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		border: none;
		border-radius: var(--radius-md);
		background: none;
		padding: 0.625rem 0.25rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-2xs, 0.66rem);
		cursor: pointer;
	}

	.mobile-toolbar-sheet-item-active {
		background-color: var(--surface-elevated);
	}

	.mobile-toolbar-sheet-item:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}
</style>
