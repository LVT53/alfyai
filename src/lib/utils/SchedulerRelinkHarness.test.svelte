<script lang="ts">
// The shape that froze the chat (images part 2, Task 11): a component mounted
// by an update writes state in its `$effect.pre` while the update is flushed.
import SchedulerRelinkChild from "./SchedulerRelinkChild.test.svelte";

let { show = false, value = 0 }: { show?: boolean; value?: number } = $props();
</script>

{#if show}<SchedulerRelinkChild {value} />{/if}
<p data-testid="value">{value}</p>
