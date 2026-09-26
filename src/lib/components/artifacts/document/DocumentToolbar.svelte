<script lang="ts">
/**
 * The Document's desktop toolbar (Feature 2 · Artifacts, Slice 1, T7): one
 * row, rendered from the shared `DOCUMENT_TOOLBAR_ACTIONS` list. This file
 * imports NOTHING from `@tiptap/*` — T7.8's source-scan test enforces that —
 * so the toolbar's own chunk resolves instantly while the editor loads
 * beside it. `DocumentBody.svelte` owns the live editor and translates an
 * `onAction` id into the actual `editor.chain()...run()` call; this
 * component only knows "a button with this id was pressed."
 *
 * `disabled` covers the whole row while the editor chunk has not resolved
 * yet (`slice-1.md §UI states`, "Loading": "the toolbar renders immediately…
 * and is disabled until ready").
 */
import { t } from "$lib/i18n";
import {
	DOCUMENT_TOOLBAR_ACTIONS,
	type DocumentToolbarActionId,
} from "./toolbar-actions";

let {
	activeActionIds = new Set<DocumentToolbarActionId>(),
	disabled = false,
	onAction,
}: {
	activeActionIds?: ReadonlySet<DocumentToolbarActionId>;
	disabled?: boolean;
	onAction: (id: DocumentToolbarActionId) => void;
} = $props();
</script>

<div
	class="document-toolbar"
	role="toolbar"
	aria-label={$t('artifacts.type.document')}
>
	{#each DOCUMENT_TOOLBAR_ACTIONS as action (action.id)}
		{@const Icon = action.icon}
		{@const isActive = !action.momentary && activeActionIds.has(action.id)}
		{@const label = $t(action.labelKey, action.labelParams)}
		<button
			type="button"
			class="btn-icon-bare document-toolbar-button"
			class:document-toolbar-button-active={isActive}
			{disabled}
			aria-pressed={action.momentary ? undefined : isActive}
			aria-label={label}
			title={label}
			onclick={() => onAction(action.id)}
		>
			<Icon size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	{/each}
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
</style>
