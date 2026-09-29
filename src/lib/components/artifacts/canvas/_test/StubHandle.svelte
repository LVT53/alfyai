<script lang="ts">
// A test stand-in for Svelte Flow's `Handle`: the real one needs a running
// flow (a store, measured nodes). It records what the shell asked for.
let {
	id,
	type,
	position,
	class: className,
}: {
	id?: string;
	type?: string;
	position?: string;
	class?: unknown;
} = $props();
</script>

<span
	data-testid="canvas-anchor"
	data-handle-id={id}
	data-handle-type={type}
	data-position={position}
	class={className as string}
></span>
