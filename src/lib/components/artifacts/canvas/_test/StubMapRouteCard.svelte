<script lang="ts">
// A test stand-in for the chat's `MapRouteCard.svelte` (MapLibre needs a WebGL
// context jsdom does not have): it records which props the canvas passed it, so
// a test can prove they are the chat's own.
const props: Record<string, unknown> = $props();
</script>

<div
	data-testid="map-card-stub"
	data-prop-names={JSON.stringify(Object.keys(props).sort())}
	data-route={JSON.stringify((props.map as { originLabel?: string })?.originLabel ?? null)}
></div>
