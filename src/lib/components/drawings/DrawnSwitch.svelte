<script lang="ts">
/**
 * The on and off switch of `Toggle.svelte`: a track and its thumb, in the
 * accent while on and in the border colour while off.
 */
let { on = true }: { on?: boolean } = $props();
</script>

<span class="drawn-switch" class:on><span class="thumb"></span></span>

<style>
	.drawn-switch {
		position: relative;
		display: inline-block;
		flex: none;
		width: calc(var(--u) * 22);
		height: calc(var(--u) * 12);
		border-radius: calc(var(--u) * 12);
		background: var(--border-default);
	}

	.drawn-switch.on {
		background: var(--accent);
	}

	.thumb {
		position: absolute;
		top: calc(var(--u) * 1);
		left: calc(var(--u) * 1);
		width: calc(var(--u) * 10);
		height: calc(var(--u) * 10);
		border-radius: 50%;
		background: var(--accent-contrast);
		box-shadow: var(--shadow-sm);
	}

	.on .thumb {
		transform: translateX(calc(var(--u) * 10));
	}
</style>
