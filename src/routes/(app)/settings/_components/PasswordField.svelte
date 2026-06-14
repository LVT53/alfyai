<script lang="ts">
import { t } from "$lib/i18n";
import { Eye, EyeOff } from "@lucide/svelte";

let {
	id,
	label,
	value = $bindable(""),
	shown = $bindable(false),
	autocomplete,
	placeholder = "",
}: {
	id: string;
	label: string;
	value: string;
	shown: boolean;
	autocomplete?: string;
	placeholder?: string;
} = $props();
</script>

<div>
	<div class="mb-1 flex items-center justify-between">
		<label class="settings-label !mb-0" for={id}>{label}</label>
		<button
			type="button"
			class="pw-toggle"
			onclick={() => (shown = !shown)}
			tabindex="-1"
			aria-label={shown ? $t('settings_hidePassword') : $t('settings_showPassword')}
		>
			{#if shown}
				<EyeOff size={14} strokeWidth={2} aria-hidden="true" />
			{:else}
				<Eye size={14} strokeWidth={2} aria-hidden="true" />
			{/if}
		</button>
	</div>
	<input
		{id}
		type={shown ? 'text' : 'password'}
		class="settings-input"
		bind:value
		{autocomplete}
		{placeholder}
	/>
</div>

<style>
	.pw-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--text-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		font-family: inherit;
		transition: color 150ms;
	}

	.pw-toggle:hover {
		color: var(--text-primary);
	}
</style>
