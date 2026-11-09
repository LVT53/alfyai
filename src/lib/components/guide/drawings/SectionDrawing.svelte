<script lang="ts">
/**
 * One section's drawing, with the spot its hovered row names ringed.
 *
 * Ask and Make are drawn. Until the other four are, a section gets an empty
 * frame, so the page lays out as it will and a row naming a spot lights nothing.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import type { GuideSectionId } from "../guide-content";
import AskDrawing from "./AskDrawing.svelte";
import MakeDrawing from "./MakeDrawing.svelte";

let { section, lit }: { section: GuideSectionId; lit: string | null } =
	$props();
</script>

{#if section === 'ask'}
	<AskDrawing {lit} />
{:else if section === 'make'}
	<MakeDrawing {lit} />
{:else}
	<DrawingFrame />
{/if}
