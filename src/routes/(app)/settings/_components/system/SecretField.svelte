<script lang="ts">
// One idiom for every secret on the screen: a state pill, when it last
// changed, and a Replace button that reveals the write-only input. Replaces
// the three idioms the old pane had (a `[set]` sentinel, an "unchanged"
// placeholder, and a plain password input bound straight to the value).
import { Eye, EyeOff, Lock } from "@lucide/svelte";
import { t } from "$lib/i18n";
import "./system.css";

let {
	label,
	value,
	lastChanged = "",
	inputId,
	onchange,
	onCancelReplace = undefined,
}: {
	label: string;
	/** Current stored value: "" when unset, "[set]" when masked server-side. */
	value: string;
	lastChanged?: string;
	inputId: string;
	onchange: (next: string) => void;
	/** Called when the admin backs out of a replacement. */
	onCancelReplace?: (() => void) | undefined;
} = $props();

let replacing = $state(false);
let reveal = $state(false);
let draft = $state("");

const isSet = $derived(value !== "" && value !== undefined);

function startReplace() {
	draft = "";
	reveal = false;
	replacing = true;
}

function cancelReplace() {
	replacing = false;
	draft = "";
	onCancelReplace?.();
}
</script>

{#if replacing}
	<span class="sys-field">
		<input
			id={inputId}
			class="sys-input sys-input-md"
			type={reveal ? 'text' : 'password'}
			autocomplete="off"
			aria-label={$t('admin.system.secret.newValue', { label })}
			bind:value={draft}
			oninput={() => onchange(draft)}
		/>
		<button
			type="button"
			class="sys-mini"
			aria-label={reveal ? $t('admin.hide') : $t('admin.show')}
			onclick={() => (reveal = !reveal)}
		>
			{#if reveal}
				<EyeOff size={12} strokeWidth={2} aria-hidden="true" />
			{:else}
				<Eye size={12} strokeWidth={2} aria-hidden="true" />
			{/if}
		</button>
	</span>
	<button type="button" class="sys-mini" onclick={cancelReplace}>
		{$t('admin.system.secret.cancel')}
	</button>
{:else}
	<span class="sys-pill" class:sys-pill-ok={isSet} class:sys-pill-muted={!isSet}>
		{#if isSet}
			<Lock size={10} strokeWidth={2.5} aria-hidden="true" />
			{$t('admin.system.secret.set')}
		{:else}
			{$t('admin.system.secret.notSet')}
		{/if}
	</span>
	{#if isSet && lastChanged}
		<span class="sys-xs sys-muted">{$t('admin.system.secret.lastChanged', { date: lastChanged })}</span>
	{/if}
	<button type="button" class="sys-mini" id={inputId} onclick={startReplace}>
		{isSet ? $t('admin.system.secret.replace') : $t('admin.system.secret.add')}
	</button>
{/if}
