<script lang="ts">
// Test-only stand-in for the lazily loaded `ImageLightbox`: the strip hands it
// the pictures of its call and the index it was opened at, and the tests read
// both back off the DOM without mounting the real viewer, its focus trap and
// its portal. Like the real viewer it draws nothing while `index` is null, so
// a close is visible as the viewer leaving the page.
let {
	images = [],
	index = null,
	onClose = () => {},
	onNavigate = () => {},
}: {
	images?: { src: string; alt: string }[];
	index?: number | null;
	onClose?: () => void;
	onNavigate?: (next: number) => void;
} = $props();
</script>

{#if index !== null}
	<div data-testid="fs-viewer" data-index={String(index)}>
		{#each images as image, at (image.src)}
			<span
				data-testid="fs-viewer-image"
				data-src={image.src}
				data-alt={image.alt}
				data-open={String(at === index)}
			></span>
		{/each}
		<button type="button" onclick={onClose}>close</button>
		<button type="button" onclick={() => onNavigate(index + 1)}>next</button>
	</div>
{/if}
