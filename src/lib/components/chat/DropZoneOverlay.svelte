<script lang="ts">
import { AlertCircle, Upload } from "@lucide/svelte";
import { t } from "$lib/i18n";
import { maxFileUploadSizeMb } from "$lib/stores/upload-limits";
let {
	active = false,
	rejected = false,
}: {
	active?: boolean;
	rejected?: boolean;
} = $props();
</script>

{#if active}
	<div class="drop-zone-overlay" data-testid="drop-zone-overlay">
		<div class="drop-zone-content">
			{#if rejected}
				<AlertCircle class="drop-zone-icon drop-zone-icon-rejected" size={48} strokeWidth={1.5} aria-hidden="true" />
				<p class="drop-zone-text">{$t('chat.dropZone.blocked')}</p>
			{:else}
				<Upload class="drop-zone-icon" size={48} strokeWidth={1.5} aria-hidden="true" />
				<p class="drop-zone-text">{$t('chat.dropZone.attach', { max: $maxFileUploadSizeMb })}</p>
			{/if}
		</div>
	</div>
{/if}
