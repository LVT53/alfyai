<script lang="ts">
// The analytics kit's tab idiom, reused so Diagnostics and the Atlas card look
// like the rest of the product rather than inventing a third tab style.
import "./system.css";

let {
	tabs,
	active = $bindable(""),
	label,
	onselect = undefined,
}: {
	tabs: Array<{ id: string; label: string; badge?: string }>;
	active?: string;
	label: string;
	onselect?: ((id: string) => void) | undefined;
} = $props();

function select(id: string) {
	active = id;
	onselect?.(id);
}

function onkeydown(event: KeyboardEvent) {
	const index = tabs.findIndex((tab) => tab.id === active);
	if (index < 0) return;
	if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
		event.preventDefault();
		const next =
			event.key === "ArrowRight"
				? (index + 1) % tabs.length
				: (index - 1 + tabs.length) % tabs.length;
		select(tabs[next].id);
	}
}
</script>

<div class="sys-tabs" role="tablist" aria-label={label} tabindex={-1} {onkeydown}>
	{#each tabs as tab (tab.id)}
		<button
			type="button"
			role="tab"
			class="sys-tab"
			id={`sys-tab-${tab.id}`}
			aria-selected={active === tab.id}
			aria-controls={`sys-tabpanel-${tab.id}`}
			tabindex={active === tab.id ? 0 : -1}
			onclick={() => select(tab.id)}
		>
			{tab.label}
			{#if tab.badge}
				<span class="sys-tab-badge">{tab.badge}</span>
			{/if}
		</button>
	{/each}
</div>
