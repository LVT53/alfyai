<script lang="ts">
// The line over a picture while Mark is on: what to do next.
let { text }: { text: string } = $props();
</script>

<p class="image-body-mark-note" class:is-shown={text !== ''} role="status" data-testid="image-body-mark-note">
	{text}
</p>

<style>
	.image-body-mark-note {
		position: absolute;
		top: var(--space-sm);
		left: 50%;
		z-index: 1;
		margin: 0;
		max-width: calc(100% - 2 * var(--space-md));
		padding: var(--space-xs) var(--space-md);
		border-radius: 999px;
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		opacity: 0;
		transform: translateX(-50%);
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.image-body-mark-note.is-shown {
		opacity: 1;
	}
</style>
