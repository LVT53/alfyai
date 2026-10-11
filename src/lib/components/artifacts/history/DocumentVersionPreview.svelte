<script lang="ts">
/**
 * A Document version, read-only, with its changes marked (ruling 76,
 * versioning.md §5.4). The stored Markdown is drawn block by block with the app's
 * own renderer, never through Tiptap (History must not pay for, or disturb, the
 * editor); blocks are matched to the version they are compared with by id, and the
 * words inside a block that changed by a word diff: the words only this version
 * has are marked (Alfy's in its accent, the reader's in a neutral ink), the words
 * it lost are put back struck through, a block that is gone stands struck where it
 * stood, and a long stretch of unchanged paragraphs folds into one line. The
 * stepper in the toolbar walks the changes (`changeCursor`).
 *
 * Bodies come from the existing version route and are cached by version: stepping
 * through the rail never fetches one twice.
 */
import { tick } from "svelte";
import { get } from "svelte/store";
import {
	fetchArtifact,
	fetchArtifactVersionBody,
} from "$lib/client/api/artifacts";
import { documentTabsFromCardMetadata } from "$lib/components/artifacts/document/card-view";
import { t } from "$lib/i18n";
import { stripEmptyTabAnchorPlaceholder } from "$lib/shared/artifact-document/blocks";
import { isDark } from "$lib/stores/theme";
import { renderMarkdown } from "$lib/utils/markdown-loader";
import { prefersReducedMotion } from "$lib/utils/motion";
import { alignDocuments, type DiffBlock, foldUnchanged } from "./document-diff";
import type { HistoryPreviewProps } from "./history-previews";
import { markAdded, markWords } from "./mark-html";

let {
	artifactId,
	conversationId,
	versionId,
	baseVersionId,
	compare,
	author,
	nowVersionId,
	nowHash,
	label,
	changeCursor,
	onState,
}: HistoryPreviewProps = $props();

/** A body over this many characters is not compared (the server does not diff it either): "Too large to compare". */
const LARGE_BODY_CHARS = 256 * 1024;

interface Item {
	key: string;
	type: DiffBlock["type"] | "fold";
	html: string;
	/** The stepper's stop this block is, or `null` for an unchanged one. */
	change: number | null;
	/** The tab this block starts, when the Document has tabs. */
	heading: string | null;
	count?: number;
	foldBlocks?: DiffBlock[];
}

type Tab = { id: string; title: string; startBlockId: string };

let status = $state<"loading" | "ready" | "error" | "large">("loading");
let items = $state.raw<Item[]>([]);
let changeCount = $state(0);
let hadBase = $state(false);
let expanded = $state.raw<ReadonlySet<string>>(new Set());
let foldHtml = $state.raw<ReadonlyMap<string, string>>(new Map());
let scroller = $state<HTMLElement | null>(null);
let flashing = $state<number | null>(null);
let token = 0;

// Immutable: a stored version's body never changes under its id, except the
// newest, whose burst of typing saves into one row; its key carries its hash.
const bodies = new Map<string, Promise<string>>();
const tabsByDocument = new Map<string, Promise<Tab[]>>();

function bodyOf(id: string): Promise<string> {
	const key = `${artifactId}:${id}${id === nowVersionId ? `:${nowHash}` : ""}`;
	let pending = bodies.get(key);
	if (!pending) {
		pending = fetchArtifactVersionBody(artifactId, id, conversationId);
		bodies.set(key, pending);
		pending.catch(() => bodies.delete(key));
	}
	return pending;
}

/** The Document's tabs as they are now (an older version keeps the strip it has: tabs live on the item, not in a body). */
function tabsOf(): Promise<Tab[]> {
	const key = `${artifactId}:${nowHash}`;
	let pending = tabsByDocument.get(key);
	if (!pending) {
		pending = fetchArtifact(artifactId, conversationId)
			.then((detail) => documentTabsFromCardMetadata(detail.artifact.metadata))
			.catch((): Tab[] => []);
		tabsByDocument.set(key, pending);
	}
	return pending;
}

function labels() {
	const translate = get(t);
	return {
		added: translate("artifacts.history.added"),
		removed: translate("artifacts.history.removedSr"),
	};
}

async function renderBlock(block: DiffBlock, dark: boolean): Promise<string> {
	const clean = (markdown: string) => stripEmptyTabAnchorPlaceholder(markdown);
	switch (block.type) {
		case "same":
			return renderMarkdown(clean(block.markdown), dark);
		case "added":
			return markAdded(
				await renderMarkdown(clean(block.markdown), dark),
				labels(),
			).html;
		case "removed": {
			const html = await renderMarkdown(clean(block.markdown), dark);
			return `<del class="hd-block" data-sr="${labels().removed}">${html}</del>`;
		}
		case "changed": {
			const [html, baseHtml] = await Promise.all([
				renderMarkdown(clean(block.markdown), dark),
				renderMarkdown(clean(block.baseMarkdown), dark),
			]);
			return markWords(html, baseHtml, labels()).html;
		}
	}
}

async function load(id: string, baseId: string | null): Promise<void> {
	const mine = ++token;
	status = "loading";
	onState({ status: "loading", changeCount: 0 });
	try {
		const [target, base, tabs] = await Promise.all([
			bodyOf(id),
			baseId ? bodyOf(baseId) : Promise.resolve<string | null>(null),
			tabsOf(),
		]);
		const large =
			target.length > LARGE_BODY_CHARS ||
			(base !== null && base.length > LARGE_BODY_CHARS);
		const blocks = alignDocuments(large ? null : base, target);
		const folded =
			large || base === null
				? blocks.map((block) => ({ type: "block" as const, block }))
				: foldUnchanged(blocks);
		const dark = get(isDark);
		const startTitles =
			tabs.length > 1
				? new Map(tabs.map((tab) => [tab.startBlockId, tab.title]))
				: new Map<string, string>();

		const rendered = await Promise.all(
			folded.map((entry) =>
				entry.type === "block" ? renderBlock(entry.block, dark) : null,
			),
		);
		let changes = 0;
		const next: Item[] = [];
		folded.forEach((entry, index) => {
			if (entry.type === "fold") {
				next.push({
					key: `fold:${entry.blocks[0]?.id ?? index}`,
					type: "fold",
					html: "",
					change: null,
					heading: null,
					count: entry.count,
					foldBlocks: entry.blocks,
				});
				return;
			}
			const block = entry.block;
			next.push({
				key: `${block.type}:${block.id}:${index}`,
				type: block.type,
				html: rendered[index] ?? "",
				change: block.type === "same" ? null : changes++,
				heading: startTitles.get(block.id) ?? null,
			});
		});
		if (mine !== token) return;
		items = next;
		changeCount = large ? 0 : changes;
		hadBase = base !== null && !large;
		expanded = new Set();
		foldHtml = new Map();
		status = large ? "large" : "ready";
		onState({ status, changeCount });
	} catch {
		if (mine !== token) return;
		status = "error";
		onState({ status: "error", changeCount: 0 });
	}
}

$effect(() => {
	const id = versionId;
	const baseId = baseVersionId;
	// What the compared-with body is when the newest row's burst saved again.
	nowHash;
	void load(id, baseId);
});

async function openFold(item: Item) {
	if (!item.foldBlocks) return;
	const dark = get(isDark);
	const parts = await Promise.all(
		item.foldBlocks.map((block) => renderBlock(block, dark)),
	);
	foldHtml = new Map(foldHtml).set(
		item.key,
		parts.map((html) => `<div class="block block-same">${html}</div>`).join(""),
	);
	expanded = new Set(expanded).add(item.key);
}

// The stepper: scroll to the change and flash it (a 3 px ring and a deeper tint
// for 900 ms; the ring alone, still, under reduced motion).
let lastNonce = -1;
$effect(() => {
	const { index, nonce } = changeCursor;
	if (nonce === lastNonce) return;
	lastNonce = nonce;
	if (index < 0 || status !== "ready") return;
	void tick().then(() => {
		const target = scroller?.querySelector<HTMLElement>(
			`[data-change="${index}"]`,
		);
		if (!target) return;
		target.scrollIntoView({
			block: "center",
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
		flashing = index;
		setTimeout(() => {
			if (flashing === index) flashing = null;
		}, 900);
	});
});

const note = $derived(
	status === "large"
		? $t("artifacts.history.tooLarge")
		: status === "ready" && hadBase && compare === "step" && changeCount === 0
			? $t("artifacts.history.noChanges")
			: null,
);
const tone = $derived(
	compare === "step" && author === "alfy" ? "alfy" : "user",
);
</script>

<!-- A scrolling region must be reachable by keyboard (WCAG 2.1.1): the preview
     scrolls, so it takes the focus, and the focus ring says so. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={scroller}
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
			<button type="button" class="btn-secondary btn-sm" onclick={() => load(versionId, baseVersionId)}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if status === 'loading' && items.length === 0}
		<div class="skeleton" aria-hidden="true">
			<span class="line"></span>
			<span class="line short"></span>
			<span class="line"></span>
			<span class="line medium"></span>
		</div>
	{:else}
		{#if note}
			<p class="note" data-testid="history-preview-note">{note}</p>
		{/if}
		<div class="page" data-marks={tone}>
			{#each items as item (item.key)}
				{#if item.heading}
					<h2 class="tab-heading">{item.heading}</h2>
				{/if}
				{#if item.type === 'fold'}
					{#if expanded.has(item.key)}
						{@html foldHtml.get(item.key) ?? ''}
					{:else}
						<button
							type="button"
							class="fold"
							data-testid="history-fold"
							onclick={() => openFold(item)}
						>
							{$t('artifacts.history.unchanged', { count: item.count ?? 0 })}
						</button>
					{/if}
				{:else}
					<div
						class="block block-{item.type}"
						class:flash={item.change !== null && flashing === item.change}
						data-change={item.change}
					>{@html item.html}</div>
				{/if}
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

	.note {
		max-width: 42rem;
		margin: 0 auto 0.75rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
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

	.tab-heading {
		margin: 1.25rem 0 0.5rem;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid var(--border-default);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	/* What changed. Alfy's words wear its accent with an underline; the reader's
	   a neutral ink tint with a quiet underline; the words a version lost are
	   struck through on a faint danger tint. Colour is never the only sign: each
	   mark is a real <mark> or <del>, and says "Added:" or "Removed:" to a screen
	   reader through its ::before. */
	.block :global(.hm) {
		background: var(--alfy-mark);
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-decoration-thickness: 2px;
		text-underline-offset: 3px;
		border-radius: 2px;
	}

	.page[data-marks='user'] .block :global(.hm) {
		background: color-mix(in srgb, var(--text-primary) 8%, transparent);
		text-decoration-color: var(--text-muted);
	}

	.block :global(.hd),
	.block :global(.hd-block) {
		color: var(--text-muted);
		text-decoration: line-through;
		background: color-mix(in srgb, var(--danger) 8%, transparent);
		border-radius: 2px;
	}

	.block :global(.hd-block) {
		display: block;
		padding: 0.125rem 0.25rem;
	}

	.block :global(.hm::before),
	.block :global(.hd::before),
	.block :global(.hd-block::before) {
		content: attr(data-sr);
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
	}

	.block {
		border-radius: var(--radius-md);
		transition: box-shadow var(--duration-standard) var(--ease-out);
	}

	.block.flash {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.fold {
		display: block;
		width: 100%;
		margin: 0.25rem 0 0.75rem;
		padding: 0.375rem 0.75rem;
		border: 1px dashed var(--border-default);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.fold:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.fold:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
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

	@media (prefers-reduced-motion: reduce) {
		.block {
			transition: none;
		}
	}
</style>
