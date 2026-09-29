<script lang="ts">
/**
 * The Document's desktop toolbar (Feature 2 · Artifacts, Slice 1, T7;
 * redesign §5.2/§9.2, Wave 2.5 Step 5): one row, rendered from the shared
 * `DOCUMENT_TOOLBAR_ACTIONS` list, grouped with dividers exactly like the
 * approved mockup (`B I S | H1 H2 | • 1. ☑ | ❝ ⊞ 🔗 | ↶ ↷`), with a single
 * roving tabindex across the whole row (WAI-ARIA toolbar pattern) and the
 * save state on the right. This file imports NOTHING from `@tiptap/*` —
 * T7.8's source-scan test enforces that — so the toolbar's own chunk
 * resolves instantly while the editor loads beside it. `DocumentBody.svelte`
 * owns the live editor and translates an `onAction` id into the actual
 * `editor.chain()...run()` call; this component only knows "a button with
 * this id was pressed."
 *
 * `disabled` covers the whole row while the editor chunk has not resolved
 * yet (`slice-1.md §UI states`, "Loading": "the toolbar renders immediately…
 * and is disabled until ready"). No Download or History here any more —
 * both live in the panel header now (`ArtifactPanelHeader`'s version button
 * and Download action, via `DocumentBody.svelte`'s `registerPanelActions`).
 */
import { CircleCheck, TriangleAlert } from "@lucide/svelte";
import { t } from "$lib/i18n";
import {
	DOCUMENT_TOOLBAR_ACTIONS,
	type DocumentToolbarActionId,
	toolbarActionText,
} from "./toolbar-actions";

let {
	activeActionIds = new Set<DocumentToolbarActionId>(),
	disabled = false,
	saveState = undefined,
	onAction,
}: {
	activeActionIds?: ReadonlySet<DocumentToolbarActionId>;
	disabled?: boolean;
	/** The right-aligned save indicator (redesign §5.2/§9.2's "✓ Saved"). `undefined` renders nothing — a caller with no save loop at all (there is none today) simply omits it. */
	saveState?: "saving" | "saved" | "offline" | "conflict" | undefined;
	onAction: (id: DocumentToolbarActionId) => void;
} = $props();

let buttonEls: (HTMLButtonElement | null)[] = $state([]);
let rovingIndex = $state(0);

function focusButton(index: number): void {
	rovingIndex = index;
	buttonEls[index]?.focus();
}

/** WAI-ARIA toolbar pattern: one tab stop for the whole row, Left/Right (wrapping) plus Home/End move it. */
function handleToolbarKeydown(event: KeyboardEvent): void {
	const count = DOCUMENT_TOOLBAR_ACTIONS.length;
	if (count === 0) return;
	if (event.key === "ArrowRight") {
		event.preventDefault();
		focusButton((rovingIndex + 1) % count);
	} else if (event.key === "ArrowLeft") {
		event.preventDefault();
		focusButton((rovingIndex - 1 + count) % count);
	} else if (event.key === "Home") {
		event.preventDefault();
		focusButton(0);
	} else if (event.key === "End") {
		event.preventDefault();
		focusButton(count - 1);
	}
}
</script>

<div
	class="document-toolbar"
	role="toolbar"
	aria-label={$t('artifacts.type.document')}
	tabindex="-1"
	onkeydown={handleToolbarKeydown}
>
	{#each DOCUMENT_TOOLBAR_ACTIONS as action, index (action.id)}
		{@const Icon = action.icon}
		{@const isActive = !action.momentary && activeActionIds.has(action.id)}
		{@const text = toolbarActionText(action, $t)}
		{#if index > 0 && DOCUMENT_TOOLBAR_ACTIONS[index - 1].group !== action.group}
			<span class="document-toolbar-divider" aria-hidden="true"></span>
		{/if}
		<button
			type="button"
			bind:this={buttonEls[index]}
			class="btn-icon-bare document-toolbar-button"
			class:document-toolbar-button-active={isActive}
			{disabled}
			tabindex={index === rovingIndex ? 0 : -1}
			aria-pressed={action.momentary ? undefined : isActive}
			aria-label={text.label}
			aria-keyshortcuts={text.ariaKeyShortcuts}
			title={text.label}
			onclick={() => {
				rovingIndex = index;
				onAction(action.id);
			}}
		>
			<Icon size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	{/each}
	{#if saveState}
		<span class="document-toolbar-grow"></span>
		<span
			class="document-toolbar-save-state"
			class:document-toolbar-save-state-saved={saveState === 'saved'}
			class:document-toolbar-save-state-warn={saveState === 'offline' || saveState === 'conflict'}
			role="status"
		>
			{#if saveState === 'saved'}
				<CircleCheck size={13} strokeWidth={2} aria-hidden="true" />
			{:else if saveState === 'offline' || saveState === 'conflict'}
				<TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
			{/if}
			<span>{$t(`artifacts.document.toolbar.saveState.${saveState}`)}</span>
		</span>
	{/if}
</div>

<style>
	.document-toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.125rem;
		padding: 0.375rem 0.5rem;
		border-bottom: 1px solid var(--border-subtle);
		background-color: var(--surface-page);
	}

	.document-toolbar-divider {
		width: 1px;
		height: 1.125rem;
		margin: 0 0.375rem;
		background: var(--border-default);
	}

	.document-toolbar-button {
		min-height: 32px;
		min-width: 32px;
		padding: 0.25rem;
	}

	.document-toolbar-button-active {
		color: var(--text-primary);
		background-color: var(--surface-elevated);
	}

	.document-toolbar-button:disabled {
		color: var(--text-muted);
		cursor: not-allowed;
		opacity: 0.5;
	}

	.document-toolbar-button:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 1px;
	}

	.document-toolbar-grow {
		flex: 1;
	}

	.document-toolbar-save-state {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0 0.3rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.document-toolbar-save-state-saved {
		color: var(--success-text);
	}

	.document-toolbar-save-state-warn {
		color: var(--warning-text);
	}
</style>
