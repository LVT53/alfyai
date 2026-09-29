<script lang="ts">
// A test stand-in for the chat's `Chart.svelte`: it records which props the
// canvas passed it, so a test can prove they are exactly the chat's own.
const props: Record<string, unknown> = $props();
</script>

<div
	data-testid="chart-stub"
	data-prop-names={JSON.stringify(Object.keys(props).sort())}
	data-code={String(props.code ?? "")}
></div>
