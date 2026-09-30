<script lang="ts">
/**
 * An App block: the App itself, running on the board in the panel's own frame
 * (`AppFrame.svelte`, untouched) at the node's size. It is the panel's frame, not
 * a lookalike: the same `sandbox="allow-scripts allow-forms"` under the same strict
 * CSP (the served route sets both, ruling 58), the same storage bridge, the same
 * tripwire. What it keeps in `window.alfy.storage` is the App's OWN — the bridge is
 * given the App's id and nothing else, so it is never the board's and two Apps on
 * one board never share it. The frame is drawn only once the panel has read the App
 * (its current version is what reloads the frame, and a deleted or out-of-reach App
 * is said in words instead of drawing the route's raw 404 inside the frame).
 *
 * Dragging, scrolling and panning on the App belong to the App (`nodrag`,
 * `nowheel`, `nopan`): the block is moved by its header and its edge. The App loads
 * when its block mounts, never with the editor.
 */
import { untrack } from "svelte";
import {
	fetchArtifact,
	subscribeArtifactChanges,
} from "$lib/client/api/artifacts";
import { ApiError } from "$lib/client/api/http";
import AppFrame from "$lib/components/artifacts/app/AppFrame.svelte";
import { t } from "$lib/i18n";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import { BLOCK_META } from "../_lib/block-meta";
import { useChatContext } from "../_lib/chat-context";
import NodeShell from "../NodeShell.svelte";

type AppData = Extract<CanvasBlockData, { kind: "app" }>;
type Phase = "loading" | "ready" | "gone" | "error";

let {
	id,
	data,
	selected = false,
}: { id: string; data: AppData; selected?: boolean } = $props();

const chat = useChatContext();
const minSize = BLOCK_META.app.minSize;

let phase = $state<Phase>("loading");
let version = $state(0);
let attempt = $state(0);
let token = 0;

/** Reads the App: its current version, or that it is gone (deleted, out of reach, or no longer an App). */
async function load(
	artifactId: string,
	conversationId: string | null,
): Promise<void> {
	token += 1;
	const run = token;
	phase = "loading";
	try {
		const detail = await fetchArtifact(artifactId, conversationId);
		if (run !== token) return;
		if (detail.artifact.kind !== "app") {
			// A block can be rewritten to name any id the reader owns; only an App
			// is served by the App route.
			phase = "gone";
			return;
		}
		version = detail.artifact.versionNumber;
		phase = "ready";
	} catch (error) {
		if (run !== token) return;
		phase =
			error instanceof ApiError && error.status === 404 ? "gone" : "error";
	}
}

$effect(() => {
	const artifactId = data.artifactId;
	const conversationId = chat.conversationId;
	// A retry is a new attempt of the same read.
	void attempt;
	untrack(() => void load(artifactId, conversationId));
});

// The App's own news: a newer version reloads the frame (a stale App must not
// keep running), a deletion ends it.
$effect(() => {
	const artifactId = data.artifactId;
	return subscribeArtifactChanges((change) => {
		if (change.artifactId !== artifactId) return;
		if (change.type === "deleted") {
			token += 1;
			phase = "gone";
			return;
		}
		if (phase === "ready" && change.version > version) version = change.version;
	});
});
</script>

<NodeShell
	{id}
	kind="app"
	{selected}
	minWidth={minSize.width}
	minHeight={minSize.height}
	title={data.title}
	summary={data.title}
>
	<div class="app nodrag nowheel nopan" data-testid="canvas-app">
		{#if phase === "ready"}
			<AppFrame
				artifactId={data.artifactId}
				{version}
				title={data.title}
				conversationId={chat.conversationId}
			/>
		{:else if phase === "loading"}
			<p class="app__state" aria-busy="true">{$t("artifacts.canvas.app.loading")}</p>
		{:else if phase === "gone"}
			<p class="app__state" data-testid="canvas-app-gone">{$t("artifacts.canvas.app.gone")}</p>
		{:else}
			<div class="app__state" data-testid="canvas-app-failed">
				<p>{$t("artifacts.canvas.app.failed")}</p>
				<button type="button" class="app__retry" onclick={() => (attempt += 1)}>
					{$t("artifacts.canvas.chat.retry")}
				</button>
			</div>
		{/if}
	</div>
</NodeShell>

<style>
	/* The frame fills what the block was given: a frame has no content height of
	   its own, so an App is drawn at a height that is stored with the block. */
	.app {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 200px;
		padding: 6px;
	}

	.app :global(.app-frame-stage) {
		flex: 1 1 auto;
		min-height: 0;
	}

	.app__state {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 0;
		padding: 12px;
		color: var(--text-muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	.app__state p {
		margin: 0;
	}

	.app__retry {
		min-height: 30px;
		padding: 0 12px;
		border: 1px solid var(--border-default);
		border-radius: 6px;
		background: var(--surface-elevated);
		color: var(--text-primary);
		font: inherit;
		cursor: pointer;
	}

	.app__retry:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.app__retry {
			min-height: 44px;
		}
	}
</style>
