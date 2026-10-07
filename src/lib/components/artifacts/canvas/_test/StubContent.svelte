<script lang="ts">
// A test stand-in for a block's lazily loaded content: it records the props the
// wrapper passed it, so a test can prove which ones arrive.
const props: Record<string, unknown> = $props();
</script>

<div
	data-testid="content-stub"
	data-prop-names={JSON.stringify(Object.keys(props).sort())}
	data-node-id={String(props.id ?? "")}
	data-selected={String(props.selected ?? "")}
	data-data={JSON.stringify(props.data ?? null)}
	data-editing={String(props.editing ?? "")}
>
	{#if props.editing}
		<button type="button" data-testid="content-stub-close" onclick={() => (props.onclose as () => void)?.()}>close</button>
	{/if}
</div>
