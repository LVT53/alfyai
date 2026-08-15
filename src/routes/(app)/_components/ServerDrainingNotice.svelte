<script lang="ts">
import { t } from "$lib/i18n";

let {
	visible,
}: {
	visible: boolean;
} = $props();
</script>

{#if visible}
	<div
		role="status"
		aria-live="polite"
		aria-labelledby="server-draining-title"
		aria-describedby="server-draining-description"
		class="pointer-events-none fixed inset-x-0 top-0 z-[140] flex justify-center px-md pt-md"
		data-testid="server-draining-notice"
	>
		<div
			class="pointer-events-auto flex max-w-[420px] items-center gap-sm rounded-lg border border-border bg-surface-page px-md py-sm shadow-lg"
		>
			<span class="sr-only" id="server-draining-title">{$t('serverDraining.title')}</span>
			<p id="server-draining-description" class="text-sm leading-6 text-text-primary">
				{$t('serverDraining.description')}
			</p>
		</div>
	</div>
{/if}
