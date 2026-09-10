<script lang="ts">
// One setting, said the same way everywhere: what it is in plain words, the
// key it writes, the control, and a mark saying whether the edit is already
// written ("Applies immediately") or waiting for the save bar ("Unsaved").
import type { Snippet } from "svelte";
import { Bolt, Pencil, RotateCcw } from "@lucide/svelte";
import { t } from "$lib/i18n";
import "./system.css";

let {
	label,
	meaning = "",
	configKey = "",
	dirty = false,
	instant = false,
	highlighted = false,
	wide = false,
	stacked = false,
	error = "",
	controlId = undefined,
	onReset = undefined,
	canReset = true,
	control,
	below = undefined,
}: {
	label: string;
	meaning?: string;
	configKey?: string;
	dirty?: boolean;
	/** True for controls that PATCH the moment they change. */
	instant?: boolean;
	highlighted?: boolean;
	wide?: boolean;
	stacked?: boolean;
	error?: string;
	controlId?: string | undefined;
	onReset?: (() => void) | undefined;
	/** False hides the reset affordance — the row is already at its default. */
	canReset?: boolean;
	control: Snippet;
	below?: Snippet | undefined;
} = $props();
</script>

<div
	class="sys-row"
	class:sys-row-wide={wide}
	class:sys-row-dirty={dirty}
	class:sys-row-highlight={highlighted}
	data-config-key={configKey || undefined}
	data-dirty={dirty ? "true" : undefined}
>
	<div class="sys-row-label">
		{#if controlId}
			<label class="sys-label" for={controlId}>
				{label}
				{#if dirty}
					<span class="sys-chip sys-chip-dirty">
						<Pencil size={9} strokeWidth={2.5} aria-hidden="true" />
						{$t('admin.system.unsaved')}
					</span>
				{/if}
				{#if instant}
					<span class="sys-chip sys-chip-live">
						<Bolt size={9} strokeWidth={2.5} aria-hidden="true" />
						{$t('admin.system.appliesImmediately')}
					</span>
				{/if}
			</label>
		{:else}
			<p class="sys-label">
				{label}
				{#if dirty}
					<span class="sys-chip sys-chip-dirty">
						<Pencil size={9} strokeWidth={2.5} aria-hidden="true" />
						{$t('admin.system.unsaved')}
					</span>
				{/if}
				{#if instant}
					<span class="sys-chip sys-chip-live">
						<Bolt size={9} strokeWidth={2.5} aria-hidden="true" />
						{$t('admin.system.appliesImmediately')}
					</span>
				{/if}
			</p>
		{/if}
		{#if meaning}
			<p class="sys-help">{meaning}</p>
		{/if}
		{#if configKey}
			<span class="sys-key">{configKey}</span>
		{/if}
	</div>
	<div class="sys-row-control" class:sys-row-control-col={stacked}>
		{@render control()}
		{#if onReset && canReset}
			<button
				type="button"
				class="sys-mini"
				aria-label={$t('admin.system.resetToDefaultA11y', { label })}
				onclick={onReset}
			>
				<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
				{$t('admin.system.resetToDefault')}
			</button>
		{/if}
		{#if error}
			<p class="sys-error" role="alert">{error}</p>
		{/if}
		{#if below}
			{@render below()}
		{/if}
	</div>
</div>
