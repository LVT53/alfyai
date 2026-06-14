<script lang="ts">
let { show = false }: { show?: boolean } = $props();
</script>

{#if show}
	<div data-testid="import-chatgpt-modal">ImportChatGPTModal</div>
{/if}
