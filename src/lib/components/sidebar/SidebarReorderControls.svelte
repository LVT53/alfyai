<script lang="ts">
import { t } from "$lib/i18n";

type MoveDirection = "up" | "down";

let {
	id,
	label,
	index,
	total,
	disabled = false,
	onMove,
	onDragStart,
	onDragEnd,
}: {
	id: string;
	label: string;
	index: number;
	total: number;
	disabled?: boolean;
	onMove?: (payload: { id: string; direction: MoveDirection }) => void;
	onDragStart?: (payload: { id: string }) => void;
	onDragEnd?: (payload: { id: string }) => void;
} = $props();

const canMoveUp = $derived(!disabled && index > 0);
const canMoveDown = $derived(!disabled && index < total - 1);

function move(direction: MoveDirection, event: MouseEvent) {
	event.stopPropagation();
	if (disabled) return;
	if (direction === "up" && !canMoveUp) return;
	if (direction === "down" && !canMoveDown) return;
	onMove?.({ id, direction });
}

function startDrag(event: DragEvent) {
	event.stopPropagation();
	if (disabled) {
		event.preventDefault();
		return;
	}
	event.dataTransfer?.setData("application/x-alfyai-sidebar-reorder", id);
	event.dataTransfer?.setData("text/plain", id);
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
	}
	onDragStart?.({ id });
}

function endDrag(event: DragEvent) {
	event.stopPropagation();
	onDragEnd?.({ id });
}
</script>

<div class="sidebar-reorder-controls flex shrink-0 items-center gap-px" aria-hidden={disabled ? 'true' : undefined}>
	<button
		type="button"
		class="sidebar-reorder-button sidebar-reorder-handle btn-icon-bare"
		draggable={!disabled}
		disabled={disabled}
		aria-label={$t('sidebar.reorderItem', { label })}
		title={$t('sidebar.reorderItem', { label })}
		ondragstart={startDrag}
		ondragend={endDrag}
		onclick={(event) => event.stopPropagation()}
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
			<path d="M8 6h.01"/>
			<path d="M16 6h.01"/>
			<path d="M8 12h.01"/>
			<path d="M16 12h.01"/>
			<path d="M8 18h.01"/>
			<path d="M16 18h.01"/>
		</svg>
	</button>
	<button
		type="button"
		class="sidebar-reorder-button btn-icon-bare"
		disabled={!canMoveUp}
		aria-label={$t('sidebar.moveItemUp', { label })}
		title={$t('sidebar.moveItemUp', { label })}
		onclick={(event) => move('up', event)}
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="m18 15-6-6-6 6"/>
		</svg>
	</button>
	<button
		type="button"
		class="sidebar-reorder-button btn-icon-bare"
		disabled={!canMoveDown}
		aria-label={$t('sidebar.moveItemDown', { label })}
		title={$t('sidebar.moveItemDown', { label })}
		onclick={(event) => move('down', event)}
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="m6 9 6 6 6-6"/>
		</svg>
	</button>
</div>

<style>
	.sidebar-reorder-controls {
		width: 56px;
		justify-content: flex-start;
	}

	.sidebar-reorder-button {
		align-items: center;
		border-radius: 0.375rem;
		color: var(--text-muted);
		cursor: pointer;
		display: inline-flex;
		height: 22px;
		justify-content: center;
		min-height: 22px;
		min-width: 18px;
		padding: 0;
		width: 18px;
	}

	.sidebar-reorder-button:hover,
	.sidebar-reorder-button:focus-visible {
		background: var(--surface-page);
		color: var(--text-primary);
		outline: none;
	}

	.sidebar-reorder-button:disabled {
		cursor: default;
		opacity: 0.32;
	}

	.sidebar-reorder-handle {
		cursor: grab;
	}

	.sidebar-reorder-handle:active {
		cursor: grabbing;
	}
</style>
