<script lang="ts">
/**
 * What the registry draws for a block made from the chat (a file, an App, a map):
 * the block's shell at once — its chrome, its anchors, its resize corners, its
 * toolbar, its name for a screen reader, so an edge can attach and a block can be
 * moved before anything has loaded — and, inside it, the block's content when its
 * own chunk has arrived. The editor's first paint does not pay for the content of
 * these blocks (the App's frame, the chat's map card); it pays only for this
 * wrapper, and the shell it already has.
 *
 * The content module says how it dresses the shell (`shell`: a title, a summary,
 * what Enter does) once it is loaded. If its chunk cannot be fetched (the network
 * went away) the block says so and offers a retry; it stays in the board's data
 * either way.
 */
import type { NodeProps } from "@xyflow/svelte";
import { t } from "$lib/i18n";
import { metaFor } from "../_lib/block-meta";
import { useChatContext } from "../_lib/chat-context";
import {
	type LazyNodeModule,
	type LazyShell,
	lazyNodeLoader,
} from "../_lib/lazy-nodes";
import NodeShell from "../NodeShell.svelte";
import MissingKindNode from "./MissingKindNode.svelte";

let props: NodeProps = $props();

const chat = useChatContext();

let loaded = $state.raw<LazyNodeModule | null>(null);
let failed = $state(false);
let attempt = $state(0);

let kind = $derived(String(props.type));
let loader = $derived(lazyNodeLoader(kind));
let blockMeta = $derived(metaFor(kind));
let shell = $derived<LazyShell>(
	loaded?.shell?.(props.data as never, chat) ?? {},
);

$effect(() => {
	const load = loader;
	// A retry is a new attempt of the same load.
	void attempt;
	if (!load) return;
	let current = true;
	loaded = null;
	failed = false;
	load().then(
		(module) => {
			if (current) loaded = module;
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
	<MissingKindNode id={props.id} type={kind} selected={props.selected} />
{:else}
	<NodeShell
		id={props.id}
		{kind}
		selected={props.selected}
		minWidth={blockMeta.minSize.width}
		minHeight={blockMeta.minSize.height}
		title={shell.title}
		meta={shell.meta}
		summary={shell.summary}
		activate={shell.activate}
	>
		{#if loaded}
			{@const Content = loaded.default}
			<Content id={props.id} data={props.data} selected={props.selected} />
		{:else if failed}
			<div class="lazy lazy--failed" role="alert" data-testid="canvas-node-load-failed">
				<p class="lazy__text">{$t("artifacts.canvas.block.loadFailed")}</p>
				<button type="button" class="lazy__retry nodrag" onclick={() => (attempt += 1)}>
					{$t("artifacts.canvas.chat.retry")}
				</button>
			</div>
		{:else}
			<div
				class="lazy"
				style:min-height="{blockMeta.minSize.height}px"
				aria-busy="true"
				data-testid="canvas-node-loading"
			>
				<span class="lazy__bar" aria-hidden="true"></span>
			</div>
		{/if}
	</NodeShell>
{/if}

<style>
	.lazy {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 6px;
		width: 100%;
		height: 100%;
		padding: 10px 12px;
		border-radius: 10px;
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
