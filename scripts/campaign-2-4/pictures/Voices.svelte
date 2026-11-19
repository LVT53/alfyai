<script lang="ts">
/**
 * Card 2, voices: the personal voice editor open over Settings, a dialog on a
 * desktop and a full-height sheet on a phone.
 */
import DrawingFrame from "$lib/components/drawings/DrawingFrame.svelte";
import VoiceEditor from "../parts/VoiceEditor.svelte";
import { DESIGN_SIZE, type Variant } from "../sizes";

let { variant }: { variant: Variant } = $props();

let phone = $derived(variant === "mobile");
</script>

<DrawingFrame width={DESIGN_SIZE[variant].width} height={DESIGN_SIZE[variant].height} bare>
	<div class="page" class:phone>
		<div class="dialog"><VoiceEditor {phone} /></div>
	</div>
</DrawingFrame>

<style>
	/* The page under the dialog, dimmed as the dialog shell dims it. */
	.page {
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--text-primary) 16%, var(--surface-page));
	}

	.dialog {
		position: absolute;
		top: calc(var(--u) * 6);
		right: calc(var(--u) * 24);
		bottom: calc(var(--u) * 6);
		left: calc(var(--u) * 24);
	}

	.phone .dialog {
		top: calc(var(--u) * 16);
		right: 0;
		bottom: 0;
		left: 0;
	}
</style>
