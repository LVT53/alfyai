<script lang="ts">
// The bar in its three states: nothing pending, N pending (named by page), and
// saving. One global Save used to cover about forty fields while at least five
// controls wrote instantly; the bar now counts only what is actually pending.
import { Check, Loader2 } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { SYSTEM_PAGE_LABEL_KEY, type SystemPageId } from "./pages";
import "./system.css";

let {
	pending = 0,
	pendingByPage = {},
	saving = false,
	invalid = 0,
	lastSavedAt = "",
	message = "",
	error = "",
	onSave,
	onDiscard,
}: {
	pending?: number;
	pendingByPage?: Partial<Record<SystemPageId, number>>;
	saving?: boolean;
	invalid?: number;
	lastSavedAt?: string;
	message?: string;
	error?: string;
	onSave: () => void;
	onDiscard: () => void;
} = $props();

const breakdown = $derived(
	Object.entries(pendingByPage)
		.filter(([, count]) => (count ?? 0) > 0)
		.map(
			([page, count]) =>
				`${$t(SYSTEM_PAGE_LABEL_KEY[page as SystemPageId])} · ${count}`,
		)
		.join("  •  "),
);
</script>

<div class="sys-savebar" data-testid="system-save-bar" data-pending={pending}>
	<span class="sys-savebar-lead">
		{#if saving}
			<span class="sys-savebar-spin">
				<Loader2 size={14} strokeWidth={2} aria-hidden="true" />
			</span>
			<span style="color: var(--accent)">
				{pending === 1
					? $t('admin.system.save.savingOne')
					: $t('admin.system.save.savingMany', { count: String(pending) })}
			</span>
		{:else if pending > 0}
			<span class="sys-dot sys-dot-on" style="background: var(--accent)"></span>
			<span>
				{pending === 1
					? $t('admin.system.save.pendingOne')
					: $t('admin.system.save.pendingMany', { count: String(pending) })}
			</span>
		{:else}
			<Check size={14} strokeWidth={2} aria-hidden="true" />
			<span>{$t('admin.system.save.allSaved')}</span>
		{/if}
	</span>

	<span class="sys-savebar-detail sys-grow" aria-live="polite">
		{#if saving}
			{$t('admin.system.save.savingDetail')}
		{:else if error}
			<span style="color: var(--danger)" role="alert">{error}</span>
		{:else if invalid > 0}
			<span style="color: var(--danger)">
				{invalid === 1
					? $t('admin.system.invalidCount', { count: String(invalid) })
					: $t('admin.system.invalidCountPlural', { count: String(invalid) })}
			</span>
		{:else if pending > 0}
			{breakdown}
		{:else if message}
			<span style="color: var(--success)">{message}</span>
		{:else if lastSavedAt}
			{$t('admin.system.save.lastSaved', { time: lastSavedAt })}
		{/if}
	</span>

	<button
		type="button"
		class="btn-secondary btn-sm"
		disabled={pending === 0 || saving}
		onclick={onDiscard}
	>
		{$t('admin.system.save.discard')}
	</button>
	<button
		type="button"
		class="btn-primary btn-sm"
		data-testid="system-save"
		disabled={pending === 0 || saving || invalid > 0}
		onclick={onSave}
	>
		{#if pending === 0}
			{$t('admin.system.save.nothing')}
		{:else if pending === 1}
			{$t('admin.system.save.buttonOne')}
		{:else}
			{$t('admin.system.save.button', { count: String(pending) })}
		{/if}
	</button>
</div>
