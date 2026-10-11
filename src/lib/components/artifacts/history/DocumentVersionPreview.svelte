<script lang="ts">
/**
 * A Document version, read-only (ruling 76, versioning.md §5.4): the stored
 * Markdown drawn block by block with the app's own renderer, never through
 * Tiptap (History must not pay for, or disturb, the editor). The body arrives
 * from the existing version route and is cached by version, so stepping through
 * the rail does not fetch a version twice.
 */
import { get } from "svelte/store";
import { fetchArtifactVersionBody } from "$lib/client/api/artifacts";
import { t } from "$lib/i18n";
import {
	parseDocument,
	stripEmptyTabAnchorPlaceholder,
} from "$lib/shared/artifact-document/blocks";
import { isDark } from "$lib/stores/theme";
import { renderMarkdown } from "$lib/utils/markdown-loader";
import type { HistoryPreviewProps } from "./history-previews";

let {
	artifactId,
	conversationId,
	versionId,
	label,
	onState,
}: HistoryPreviewProps = $props();

interface RenderedBlock {
	id: string;
	html: string;
}

let status = $state<"loading" | "ready" | "error">("loading");
let blocks = $state.raw<RenderedBlock[]>([]);
let token = 0;

// Immutable: a stored version's body never changes under its id.
const bodyCache = new Map<string, Promise<string>>();

function bodyOf(id: string): Promise<string> {
	const key = `${artifactId}:${id}`;
	let pending = bodyCache.get(key);
	if (!pending) {
		pending = fetchArtifactVersionBody(artifactId, id, conversationId);
		bodyCache.set(key, pending);
		pending.catch(() => bodyCache.delete(key));
	}
	return pending;
}

async function load(id: string): Promise<void> {
	const mine = ++token;
	status = "loading";
	onState({ status: "loading", changeCount: 0 });
	try {
		const body = await bodyOf(id);
		// A stored body carries its block ids; one that does not (an old or foreign
		// body) gets fresh ones, so every block has a key of its own.
		const parsed = parseDocument(body, { mint: true }).blocks;
		const dark = get(isDark);
		const rendered: RenderedBlock[] = [];
		for (const block of parsed) {
			rendered.push({
				id: block.id,
				html: await renderMarkdown(
					stripEmptyTabAnchorPlaceholder(block.markdown),
					dark,
				),
			});
		}
		if (mine !== token) return;
		blocks = rendered;
		status = "ready";
		onState({ status: "ready", changeCount: 0 });
	} catch {
		if (mine !== token) return;
		status = "error";
		onState({ status: "error", changeCount: 0 });
	}
}

$effect(() => {
	const id = versionId;
	void load(id);
});
</script>

<!-- A scrolling region must be reachable by keyboard (WCAG 2.1.1): the
     preview scrolls, so it takes the focus, and the focus ring says so. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="history-doc"
	role="document"
	aria-label={label}
	aria-busy={status === 'loading'}
	tabindex="0"
	data-testid="history-preview"
>
	{#if status === 'error'}
		<div class="state" role="alert">
			<span>{$t('artifacts.history.previewError')}</span>
			<button type="button" class="btn-secondary btn-sm" onclick={() => load(versionId)}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if status === 'loading' && blocks.length === 0}
		<div class="skeleton" aria-hidden="true">
			<span class="line"></span>
			<span class="line short"></span>
			<span class="line"></span>
			<span class="line medium"></span>
		</div>
	{:else}
		<div class="page">
			{#each blocks as block (block.id)}
				<div class="block" data-block-id={block.id}>{@html block.html}</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.history-doc {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 1.25rem 1rem 2rem;
		outline: none;
	}

	.history-doc:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	.page {
		max-width: 42rem;
		margin: 0 auto;
		padding: 1.25rem 1.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-page);
		font-family: var(--font-serif);
		font-size: 1rem;
		line-height: 1.65;
		color: var(--text-primary);
	}

	.block :global(p),
	.block :global(ul),
	.block :global(ol),
	.block :global(blockquote),
	.block :global(pre),
	.block :global(.markdown-table-wrap) {
		margin: 0 0 0.75rem;
	}

	.block :global(h1),
	.block :global(h2),
	.block :global(h3),
	.block :global(h4) {
		margin: 1rem 0 0.375rem;
		font-family: var(--font-sans);
		font-weight: 700;
		line-height: 1.3;
	}

	.block :global(h1) {
		font-size: 1.25rem;
	}

	.block :global(h2) {
		font-size: 1.0625rem;
	}

	.block :global(h3),
	.block :global(h4) {
		font-size: 0.9375rem;
	}

	.block :global(ul),
	.block :global(ol) {
		padding-left: 1.4rem;
	}

	.block :global(blockquote) {
		padding-left: 0.875rem;
		border-left: 3px solid var(--border-default);
		color: var(--text-muted);
	}

	.block :global(code) {
		font-family: var(--font-mono);
		font-size: 0.875em;
	}

	.block :global(pre) {
		overflow-x: auto;
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	.block :global(input[type='checkbox']) {
		margin-right: 0.4rem;
		pointer-events: none;
	}

	.block :global(table) {
		border-collapse: collapse;
		font-size: 0.9em;
	}

	.block :global(th),
	.block :global(td) {
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--border-default);
	}

	.state {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 1rem;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.skeleton {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		max-width: 42rem;
		margin: 0 auto;
		padding: 1.5rem;
	}

	.line {
		height: 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
	}

	.line.short {
		width: 40%;
	}

	.line.medium {
		width: 70%;
	}
</style>
