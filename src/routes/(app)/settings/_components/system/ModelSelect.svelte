<script lang="ts">
import type { ModelOptionGroup } from "./model-options";
import "./system.css";

let {
	id,
	label,
	groups,
	value,
	inheritLabel = "",
	disabled = false,
	onchange,
}: {
	id: string;
	/** Accessible name when the row's label is not tied to this control. */
	label?: string;
	groups: ModelOptionGroup[];
	value: string;
	/** When set, an extra first option whose value is the empty string. */
	inheritLabel?: string;
	disabled?: boolean;
	onchange: (next: string) => void;
} = $props();
</script>

<select
	{id}
	class="sys-input"
	aria-label={label}
	{value}
	{disabled}
	onchange={(event) => onchange(event.currentTarget.value)}
>
	{#if inheritLabel}
		<option value="">{inheritLabel}</option>
	{/if}
	{#each groups as group, index (group.label + index)}
		{#if group.label}
			<optgroup label={group.label}>
				{#each group.options as option (option.id)}
					<option value={option.id}>
						{option.label}{option.hint ? ` · ${option.hint}` : ''}
					</option>
				{/each}
			</optgroup>
		{:else}
			{#each group.options as option (option.id)}
				<option value={option.id}>
					{option.label}{option.hint ? ` · ${option.hint}` : ''}
				</option>
			{/each}
		{/if}
	{/each}
</select>
