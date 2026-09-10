<script lang="ts">
// Leaving with work pending. The old screen dropped the pending half silently;
// this lists what is pending — by page and by setting — and offers all three
// honest outcomes.
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import { SYSTEM_PAGE_LABEL_KEY, type SystemPageId } from "./pages";
import "./system.css";

let {
	pending,
	items = [],
	saving = false,
	onKeepEditing,
	onDiscard,
	onSave,
}: {
	pending: number;
	items?: Array<{ key: string; label: string; page: SystemPageId }>;
	saving?: boolean;
	onKeepEditing: () => void;
	onDiscard: () => void;
	onSave: () => void;
} = $props();
</script>

<DialogShell
	title={pending === 1
		? $t('admin.system.leave.titleOne')
		: $t('admin.system.leave.titleMany', { count: String(pending) })}
	description={$t('admin.system.leave.description')}
	maxWidthClass="max-w-[520px]"
	zIndexClass="z-[120]"
	onClose={onKeepEditing}
>
	<ul class="sys-list" data-testid="leave-guard-items">
		{#each items as item (item.key)}
			<li class="sys-list-row">
				<span class="sys-grow">
					<span class="sys-label">{item.label}</span>
					<span class="sys-key">{item.key}</span>
				</span>
				<span class="sys-pill sys-pill-outline">
					{$t(SYSTEM_PAGE_LABEL_KEY[item.page])}
				</span>
			</li>
		{/each}
	</ul>

	<div class="mt-lg flex flex-wrap justify-end gap-sm">
		<button type="button" class="btn-secondary" onclick={onKeepEditing}>
			{$t('admin.system.leave.keepEditing')}
		</button>
		<button type="button" class="btn-danger" onclick={onDiscard}>
			{$t('admin.system.leave.discardAndLeave')}
		</button>
		<button type="button" class="btn-primary" disabled={saving} onclick={onSave}>
			{saving ? $t('common.saving') : $t('admin.system.leave.saveAndLeave')}
		</button>
	</div>
</DialogShell>
