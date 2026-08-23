<script lang="ts">
import { Loader } from "@lucide/svelte";

let {
	size = 16,
	class: className = "",
}: {
	size?: number;
	class?: string;
} = $props();
</script>

<Loader
	data-testid="spinner"
	class={`animate-spin ${className}`.trim()}
	{size}
	strokeWidth={2}
	aria-hidden="true"
/>
