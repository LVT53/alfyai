<script lang="ts">
/**
 * The smallest editor a block can have: a title, and for a chart and a diagram its
 * own source, in a form that takes the place of the block's content while it is open
 * (the shell around it, its header and its toolbar, stays). Nothing is written until
 * Save: what is typed is a draft, the block keeps drawing what it had, and Cancel (or
 * Escape) leaves everything as it was. Save is ONE `updateNodeData` for what changed,
 * which the board settles into one step of the reader's own undo (ruling 16).
 *
 * The block's own schema judges a source (`block-edit.ts`): one it would refuse cannot
 * be saved, and says why. The form is the content module's, loaded with the block, and
 * imports neither the shell nor the flow library (`lazy-nodes.ts`).
 *
 * On a phone (CV-B2) the same form is the app's bottom sheet, like the board's other
 * phone surfaces, and not a form in the block: in the block it is drawn at the board's
 * zoom (a few pixels tall on a zoomed-out board), and a block low in the pane left its
 * Save and Cancel below the fold, behind the board's own toolbar. The sheet is at its
 * own size, its buttons are pinned in its footer, and what the block draws stays where
 * it is behind it (`children`).
 */
import type { Snippet } from "svelte";
import type { Attachment } from "svelte/attachments";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t, type I18nKey } from "$lib/i18n";
import { LABEL_MAX_CHARS } from "$lib/shared/artifacts/canvas-limits";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import {
	type EditedKind,
	editPatch,
	shownTitle,
	sourceProblem,
	sourceToEdit,
} from "../_lib/block-edit";
import { useBoardContext } from "../_lib/board-context";

let {
	id,
	kind,
	data,
	onclose,
	overlay = false,
	children,
}: {
	id: string;
	kind: EditedKind;
	data: CanvasBlockData;
	/** The form is done (saved, cancelled): the block draws its content again. */
	onclose: () => void;
	/** Lies over the top of the block's content, which stays drawn beneath (a block whose content has a state of its own: a running App, a map). Without it the form takes the content's place. */
	overlay?: boolean;
	/** What the block draws. On a phone the form is a sheet over the page, and this stays where it is; where the form is in the block and takes its place, it is not drawn. */
	children?: Snippet;
} = $props();

const board = useBoardContext();

/** The kinds that have a source of their own to edit. */
const sourceKind = $derived(
	kind === "chart" || kind === "mermaid" ? kind : null,
);

// What the form starts with is what the block had when it opened: a draft the block
// changing underneath (Alfy landing a change) does not rewrite.
// svelte-ignore state_referenced_locally
let title = $state(shownTitle(kind, data));
// svelte-ignore state_referenced_locally
let source = $state(
	sourceKind ? sourceToEdit(sourceKind, (data as { code: string }).code) : "",
);

let problem = $derived(sourceKind ? sourceProblem(sourceKind, source) : null);
let problemText = $derived(
	problem ? $t(`artifacts.canvas.edit.error.${problem}` as I18nKey) : "",
);
let sourceLabel = $derived(
	sourceKind === "chart"
		? $t("artifacts.canvas.edit.chartSource")
		: $t("artifacts.canvas.edit.diagramSource"),
);

let form = $state<HTMLFormElement | null>(null);

// A phone gets a sheet; a window that is wide (or becomes so) gets the form in the block.
let phone = $state(isPhoneViewport());
$effect(() => watchPhoneViewport((now) => (phone = now)));
// The sheet's Save is outside the form, which it submits by this id.
const formId = $props.id();

// The title takes the focus when the form shows. The block is on the board and drawn by
// then (the form opens from a press on it), so there is no waiting for it to appear, and
// this module imports nothing the editor shares with it but what it must: a shared module
// is a chunk of its own, loaded with the editor's first paint.
const focusFirst: Attachment<HTMLInputElement> = (element) => {
	element.focus();
};

/** The block's wrapper (the library's own, which takes focus), found before the form goes: from the form in the block, or from the page when the form is a sheet. */
function leave(): void {
	const owner =
		form?.closest<HTMLElement>(".svelte-flow__node") ??
		[...document.querySelectorAll<HTMLElement>(".svelte-flow__node")].find(
			(node) => node.dataset.id === id,
		);
	onclose();
	owner?.focus();
}

function save(): void {
	if (problem) return;
	const patch = editPatch(kind, data, {
		title,
		source: sourceKind ? source : undefined,
	});
	if (patch) board.updateData?.(id, patch);
	leave();
}

// Escape and Ctrl/Cmd+Enter are the form's own: the panel around the board must not
// take them for its own (closing, or a send). Heard on the form itself, from
// whichever of its fields has the focus.
const ownKeys: Attachment<HTMLFormElement> = (element) => {
	const handle = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			leave();
		} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			event.stopPropagation();
			save();
		}
	};
	element.addEventListener("keydown", handle);
	return () => element.removeEventListener("keydown", handle);
};
</script>

{#snippet actions()}
	<button
		type="button"
		class={phone ? "btn-secondary" : "edit__button"}
		data-testid="canvas-edit-cancel"
		onclick={leave}
	>
		{$t("common.cancel")}
	</button>
	<button
		type="submit"
		form={formId}
		class={phone ? "btn-primary" : "edit__button edit__button--primary"}
		disabled={Boolean(problem)}
		data-testid="canvas-edit-save"
	>
		{$t("common.save")}
	</button>
{/snippet}

{#snippet formView()}
	<form
		bind:this={form}
		id={formId}
		class="edit canvas-edit-form nodrag nopan nowheel"
		class:edit--fill={sourceKind !== null && !overlay && !phone}
		class:edit--overlay={overlay && !phone}
		class:edit--sheet={phone}
		aria-label={$t("common.edit")}
		data-testid="canvas-edit-form"
		data-export-skip
		onsubmit={(event) => {
			event.preventDefault();
			save();
		}}
		{@attach ownKeys}
	>
		<label class="edit__field">
			<span class="edit__label">{$t("artifacts.canvas.edit.title")}</span>
			<!-- On a phone the field is not focused for the reader: the keyboard it opens would cover the sheet. -->
			<input
				{@attach phone ? undefined : focusFirst}
				type="text"
				class="edit__input"
				bind:value={title}
				maxlength={LABEL_MAX_CHARS}
				enterkeyhint="done"
				data-testid="canvas-edit-title"
			/>
		</label>
		{#if sourceKind}
			<label class="edit__field edit__field--grow">
				<span class="edit__label">{sourceLabel}</span>
				<textarea
					class="edit__source"
					bind:value={source}
					spellcheck="false"
					autocapitalize="off"
					aria-invalid={problem ? "true" : undefined}
					aria-describedby={problem ? `edit-problem-${id}` : undefined}
					data-testid="canvas-edit-source"
				></textarea>
			</label>
		{/if}
		{#if problem}
			<p
				id="edit-problem-{id}"
				class="edit__problem"
				role="alert"
				data-testid="canvas-edit-error"
			>
				{problemText}
			</p>
		{/if}
		{#if !phone}
			<div class="edit__actions">
				{@render actions()}
			</div>
		{/if}
	</form>
{/snippet}

{#if phone}
	{@render children?.()}
	<!-- z-[150]: the phone shell's own backdrop is at 95, as for the panel's other sheets (AnchoredPopover). -->
	<DialogShell
		title={$t("common.edit")}
		phonePresentation="sheet"
		zIndexClass="z-[150]"
		onClose={leave}
	>
		{@render formView()}
		{#snippet footer()}
			{@render actions()}
		{/snippet}
	</DialogShell>
{:else}
	{@render formView()}
{/if}

<style>
	/* A block that is being changed grows (a chart's form is taller than its plot) and may
	   reach what is beside it. Its buttons are pressed with a pointer, so while its form is
	   open the block is above its neighbours: the library draws the blocks in their listed
	   order, and one listed before another would have its Save under it. */
	:global(.svelte-flow__node:has(.canvas-edit-form)) {
		z-index: 12 !important;
	}

	.edit {
		display: flex;
		flex-direction: column;
		gap: 8px;
		box-sizing: border-box;
		padding: 10px 12px;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		cursor: default;
	}

	/* A form with a source takes the content's whole place, however tall the block is. */
	.edit--fill {
		height: 100%;
	}

	/* Over what the block draws, which stays where it is (a frame that reloads or a map that
	   re-fits when its box changes is not asked to): the form is the first thing on top. */
	.edit--overlay {
		position: absolute;
		top: 0;
		right: 0;
		left: 0;
		z-index: 2;
		border-bottom: 1px solid var(--border-default);
		background: var(--surface-page);
		box-shadow: 0 6px 14px rgba(0, 0, 0, 0.1);
	}

	.edit__field {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-height: 0;
	}

	.edit__field--grow {
		flex: 1 1 auto;
	}

	.edit__label {
		color: var(--text-muted);
	}

	.edit__input,
	.edit__source {
		box-sizing: border-box;
		width: 100%;
		padding: 5px 7px;
		border: 1px solid var(--border-default);
		border-radius: 5px;
		background: var(--surface-page);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--text-sm);
	}

	.edit__source {
		flex: 1 1 auto;
		min-height: 150px;
		resize: none;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: 1.45;
		white-space: pre;
		overflow: auto;
	}

	.edit__input:focus-visible,
	.edit__source:focus-visible,
	.edit__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.edit__problem {
		margin: 0;
		color: var(--danger);
	}

	.edit__actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}

	.edit__button {
		min-width: 64px;
		height: 30px;
		padding: 0 12px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		cursor: pointer;
	}

	.edit__button:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.edit__button--primary {
		border-color: transparent;
		background: var(--accent-fill);
		color: var(--on-accent);
	}

	.edit__button--primary:hover:not(:disabled) {
		background: var(--accent-fill);
		filter: brightness(1.08);
	}

	.edit__button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.edit__button {
			min-width: 76px;
			height: 44px;
		}
	}

	/* On a phone the form is in the sheet, whose body has its own padding, at its own size:
	   16 px fields (a smaller one makes a phone zoom the page in on it), and a source tall
	   enough to read. Its buttons are the sheet's footer. */
	.edit--sheet {
		padding: 0;
		font-size: var(--text-sm);
	}

	.edit--sheet .edit__input,
	.edit--sheet .edit__source {
		font-size: 1rem;
	}

	.edit--sheet .edit__input {
		min-height: 44px;
	}

	.edit--sheet .edit__source {
		min-height: 180px;
	}
</style>
