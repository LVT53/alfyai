<script lang="ts">
import { t } from "$lib/i18n";
import ImportChatGPTModal from "$lib/components/chat/ImportChatGPTModal.svelte";
import type { Project } from "$lib/types";

let showImportModal = $state(false);
let { projects = [] }: { projects?: Project[] } = $props();
</script>

<section class="settings-card mb-4">
	<h2 class="settings-section-title">{$t('chatgptImport.settingsTitle')}</h2>
	<p class="text-sm text-text-secondary mb-3">
		{$t('chatgptImport.settingsDescription')}
	</p>
	<button class="btn-secondary text-sm" onclick={() => (showImportModal = true)}>
		{$t('chatgptImport.settingsButton')}
	</button>
</section>

{#if showImportModal}
	<ImportChatGPTModal
		show={showImportModal}
		onClose={() => (showImportModal = false)}
		{projects}
	/>
{/if}
