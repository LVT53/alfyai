<script lang="ts">
/**
 * What the registry draws for a block made from the chat (a file, an App, a map)
 * until its own code has loaded, and then the block itself. The editor's first
 * paint does not pay for these blocks: each one's component (and what it brings —
 * the App's frame, the chat's map card) is a chunk of its own, fetched when a
 * block of that kind is on the board. Every prop the flow hands a node is passed
 * on untouched, so the block cannot tell it was loaded late.
 *
 * While it loads this is a plain box the size of the block's smallest form, not a
 * node (it has no anchors and is not counted as a block); if the chunk cannot be
 * fetched (the network went away) it says so and offers a retry, and the block
 * stays in the board's data either way.
 */
import type { NodeProps, NodeTypes } from "@xyflow/svelte";
import { t } from "$lib/i18n";
import { metaFor } from "../_lib/block-meta";
import { lazyNodeLoader } from "../_lib/lazy-nodes";
import MissingKindNode from "./MissingKindNode.svelte";

let props: NodeProps = $props();

let Loaded = $state.raw<NodeTypes[string] | null>(null);
let failed = $state(false);
let attempt = $state(0);

let loader = $derived(lazyNodeLoader(String(props.type)));
let minHeight = $derived(metaFor(String(props.type)).minSize.height);

$effect(() => {
	const load = loader;
	// A retry is a new attempt of the same load.
	void attempt;
	if (!load) return;
	let current = true;
	Loaded = null;
	failed = false;
	load().then(
		(module) => {
			if (current) Loaded = module.default;
		},
		() => {
			if (current) failed = true;
		},
	);
	return () => {
		current = false;
	};
});
</script>

{#if !loader}
	<MissingKindNode id={props.id} type={String(props.type)} selected={props.selected} />
{:else if Loaded}
	<Loaded {...props} />
{:else}
	<div
		class="lazy"
		class:lazy--failed={failed}
		style:min-height="{minHeight}px"
		aria-busy={!failed}
		data-testid="canvas-node-loading"
	>
		{#if failed}
			<p class="lazy__text">{$t("artifacts.canvas.block.loadFailed")}</p>
			<button type="button" class="lazy__retry nodrag" onclick={() => (attempt += 1)}>
				{$t("artifacts.canvas.chat.retry")}
			</button>
		{:else}
			<span class="lazy__bar" aria-hidden="true"></span>
		{/if}
	</div>
{/if}

<style>
	.lazy {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 6px;
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--border-default);
		border-radius: 10px;
		background: var(--surface-page);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
	}

	.lazy__bar {
		display: block;
		width: 45%;
		height: 8px;
		border-radius: 4px;
		background: var(--surface-elevated);
		animation: lazy-pulse 1.4s ease-in-out infinite;
	}

	.lazy__text {
		margin: 0;
	}

	.lazy__retry {
		align-self: flex-start;
		min-height: 28px;
		padding: 0 10px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-elevated);
		color: var(--text-primary);
		font: inherit;
		cursor: pointer;
	}

	.lazy__retry:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.lazy__retry {
			min-height: 44px;
		}
	}

	@keyframes lazy-pulse {
		50% {
			opacity: 0.45;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.lazy__bar {
			animation: none;
		}
	}
</style>
