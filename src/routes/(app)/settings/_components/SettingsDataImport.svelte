<script lang="ts">
import { t } from "$lib/i18n";
import ImportChatGPTModal from "$lib/components/chat/ImportChatGPTModal.svelte";
import type { Project } from "$lib/server/services/projects";

let showImportModal = $state(false);
let {
	projects = [],
	// Profile redesign: Import folded into the Data & privacy card, where it
	// belongs. In "row" mode the component drops its own card chrome and
	// renders just the button, because the surrounding settings row already
	// carries the label and the one line of meaning. The modal, the button
	// and every string are unchanged; "card" stays the default so the
	// component still stands alone wherever else it is used.
	variant = "card",
}: { projects?: Project[]; variant?: "card" | "row" } = $props();
</script>

{#if variant === 'row'}
	<button
		class="btn-secondary btn-sm"
		onclick={() => (showImportModal = true)}
	>
		{$t('chatgptImport.settingsButton')}
	</button>
{:else}
	<section class="settings-card mb-4">
		<h2 class="settings-section-title">{$t('chatgptImport.settingsTitle')}</h2>
		<p class="text-sm text-text-secondary mb-3">
			{$t('chatgptImport.settingsDescription')}
		</p>
		<button class="btn-secondary" onclick={() => (showImportModal = true)}>
			{$t('chatgptImport.settingsButton')}
		</button>
	</section>
{/if}

{#if showImportModal}
	<ImportChatGPTModal
		show={showImportModal}
		onClose={() => (showImportModal = false)}
		{projects}
	/>
{/if}
