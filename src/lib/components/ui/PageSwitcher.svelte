<script lang="ts">
type PageSwitcherItem = {
	id: string;
	label: string;
	href?: string;
	tabId?: string;
	panelId?: string;
	badge?: string | number | null;
	badgeLabel?: string;
};

interface PageSwitcherProps {
	items: PageSwitcherItem[];
	activeId: string;
	ariaLabel: string;
	onChange?: (id: string) => void;
}

let { items, activeId, ariaLabel, onChange }: PageSwitcherProps = $props();
</script>

<div class="page-switcher" role="tablist" aria-label={ariaLabel}>
	{#each items as item (item.id)}
		{@const active = activeId === item.id}
		{@const tabId = item.tabId ?? `${item.id}-tab`}
		{#if item.href}
			<a
				id={tabId}
				href={item.href}
				class="page-switcher__item"
				class:page-switcher__item--active={active}
				role="tab"
				aria-selected={active}
				aria-controls={item.panelId}
				onclick={(event) => {
					if (!onChange) return;
					event.preventDefault();
					onChange(item.id);
				}}
			>
				<span class="page-switcher__label">{item.label}</span>
				{#if item.badge != null && String(item.badge).length > 0}
					<span class="page-switcher__badge" aria-label={item.badgeLabel}>
						{item.badge}
					</span>
				{/if}
			</a>
		{:else}
			<button
				id={tabId}
				type="button"
				class="page-switcher__item"
				class:page-switcher__item--active={active}
				role="tab"
				aria-selected={active}
				aria-controls={item.panelId}
				onclick={() => onChange?.(item.id)}
			>
				<span class="page-switcher__label">{item.label}</span>
				{#if item.badge != null && String(item.badge).length > 0}
					<span class="page-switcher__badge" aria-label={item.badgeLabel}>
						{item.badge}
					</span>
				{/if}
			</button>
		{/if}
	{/each}
</div>

<style>
	.page-switcher {
		display: flex;
		gap: 0.25rem;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		background: var(--surface-overlay);
		padding: 0.25rem;
	}

	.page-switcher__item {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		flex: 1 1 0;
		border: 0;
		border-radius: 0.375rem;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0.5rem 1rem;
		text-align: center;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1.25rem;
		transition:
			background var(--duration-standard),
			color var(--duration-standard),
			box-shadow var(--duration-standard);
	}

	.page-switcher__label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-switcher__badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.35rem;
		height: 1.35rem;
		padding: 0 0.35rem;
		border-radius: 999px;
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: 0.72rem;
		font-weight: 700;
		line-height: 1;
	}

	.page-switcher__item:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.page-switcher__item--active {
		background: var(--surface-page);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
		color: var(--text-primary);
		font-weight: 600;
	}
</style>
