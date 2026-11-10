<script lang="ts">
/**
 * One section's drawing, with the spot its hovered row names ringed. Each of
 * the six sections has its own, drawn from the real screens where its
 * features live.
 */
import type { GuideSectionId } from "../guide-content";
import AccountDrawing from "./AccountDrawing.svelte";
import AskDrawing from "./AskDrawing.svelte";
import KnowsYouDrawing from "./KnowsYouDrawing.svelte";
import MakeDrawing from "./MakeDrawing.svelte";
import OrganizedDrawing from "./OrganizedDrawing.svelte";
import YourThingsDrawing from "./YourThingsDrawing.svelte";

let { section, lit }: { section: GuideSectionId; lit: string | null } =
	$props();
</script>

{#if section === 'ask'}
	<AskDrawing {lit} />
{:else if section === 'make'}
	<MakeDrawing {lit} />
{:else if section === 'knowsYou'}
	<KnowsYouDrawing {lit} />
{:else if section === 'yourThings'}
	<YourThingsDrawing {lit} />
{:else if section === 'organized'}
	<OrganizedDrawing {lit} />
{:else}
	<AccountDrawing {lit} />
{/if}
