<script lang="ts">
import { t } from "$lib/i18n";

let {
	visible,
	held = false,
	onRefresh,
}: {
	visible: boolean;
	/**
	 * A message waits for the update: it has not reached the server, and a reload
	 * now would lose it. The notice stays down until this is false.
	 */
	held?: boolean;
	onRefresh: () => void;
} = $props();
</script>

{#if visible && !held}
	<div
		role="dialog"
		aria-modal="false"
		aria-labelledby="server-update-title"
		aria-describedby="server-update-description"
		aria-live="polite"
		class="fixed inset-x-md bottom-md z-[140] ml-auto flex w-auto max-w-[400px] flex-col gap-sm rounded-lg border border-border bg-surface-page p-md shadow-lg sm:inset-x-auto sm:right-md sm:w-[360px]"
		data-testid="server-update-notice"
	>
		<div class="space-y-xs">
			<h2 id="server-update-title" class="text-base font-semibold text-text-primary">
				{$t('serverUpdate.title')}
			</h2>
			<p id="server-update-description" class="text-sm leading-6 text-text-muted">
				{$t('serverUpdate.description')}
			</p>
		</div>
		<div class="flex justify-end">
			<button type="button" class="btn-primary" onclick={onRefresh}>{$t('serverUpdate.refresh')}</button>
		</div>
	</div>
{/if}
