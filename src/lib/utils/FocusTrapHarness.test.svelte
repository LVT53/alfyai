<script lang="ts">
import type { Snippet } from "svelte";
import { focusTrap, type FocusTrapOptions } from "./focus-trap";

// A minimal host for focus-trap.test.ts's "wrapper" coverage: proves the
// `{@attach}` binding actually wires focusTrap(...) up through Svelte's own
// mount/unmount lifecycle, rather than only through a hand-called function
// (see the "direct" describe blocks in focus-trap.test.ts for that).
let {
	options = {},
	show = true,
	children,
}: {
	options?: FocusTrapOptions;
	show?: boolean;
	children?: Snippet;
} = $props();
</script>

{#if show}
	<div data-testid="trap-container" tabindex="-1" {@attach focusTrap(options)}>
		{@render children?.()}
	</div>
{/if}
