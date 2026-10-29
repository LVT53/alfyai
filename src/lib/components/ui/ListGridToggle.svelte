<script lang="ts">
// List or Grid for a list of items (plan 2b Task 22 / 22b): two pressed-state
// icon buttons in one hairline pill. The pressed one is filled; colours change at
// once (no transition). The Knowledge Base's library and the chat panel's "What
// this chat made" both use it; each keeps its own choice (`list-view-preference.ts`).
import { LayoutGrid, List } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { ListView } from "$lib/utils/list-view-preference";

let {
	view,
	onChange,
	testIdPrefix,
}: {
	view: ListView;
	onChange: (view: ListView) => void;
	/** `<prefix>-list` and `<prefix>-grid` on the buttons, `<prefix>-toggle` on the group. */
	testIdPrefix: string;
} = $props();
</script>

<div
	class="list-grid-toggle"
	role="group"
	aria-label={$t('common.view.label')}
	data-testid="{testIdPrefix}-toggle"
>
	<button
		type="button"
		class="list-grid-toggle-button"
		aria-pressed={view === 'list'}
		aria-label={$t('common.view.list')}
		title={$t('common.view.list')}
		data-testid="{testIdPrefix}-list"
		onclick={() => onChange('list')}
	>
		<List size={15} strokeWidth={2} aria-hidden="true" />
	</button>
	<button
		type="button"
		class="list-grid-toggle-button"
		aria-pressed={view === 'grid'}
		aria-label={$t('common.view.grid')}
		title={$t('common.view.grid')}
		data-testid="{testIdPrefix}-grid"
		onclick={() => onChange('grid')}
	>
		<LayoutGrid size={15} strokeWidth={2} aria-hidden="true" />
	</button>
</div>

<style>
	.list-grid-toggle {
		display: inline-flex;
		align-items: center;
		flex: none;
		padding: 2px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
	}

	.list-grid-toggle-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: calc(var(--radius-md) - 2px);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.list-grid-toggle-button:hover {
		color: var(--accent);
	}

	.list-grid-toggle-button[aria-pressed='true'] {
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.list-grid-toggle-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* 40 px targets where the finger is the pointer, in a 44 px pill. */
	@media (hover: none) and (pointer: coarse) {
		.list-grid-toggle-button {
			width: 40px;
			height: 40px;
		}
	}
</style>
