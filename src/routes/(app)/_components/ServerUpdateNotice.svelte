<script lang="ts">
let {
	visible,
	onRefresh,
}: {
	visible: boolean;
	onRefresh: () => void;
} = $props();
</script>

{#if visible}
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
				Update available
			</h2>
			<p id="server-update-description" class="text-sm leading-6 text-text-muted">
				The server was updated. Refresh when you're ready to load the latest version.
			</p>
		</div>
		<div class="flex justify-end">
			<button type="button" class="btn-primary" onclick={onRefresh}>Refresh</button>
		</div>
	</div>
{/if}
