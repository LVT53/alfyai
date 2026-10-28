<script lang="ts">
// Remembers the highest value it was given, written while it mounts (as the
// picture card's progress once was), which re-runs the batch being flushed.
let { value }: { value: number } = $props();
let seen = $state(0);
$effect.pre(() => {
	if (value > seen) seen = value;
});
</script>

<span data-testid="seen">{seen}</span>
