<script lang="ts">
import { preserveScrollOnToggle } from "$lib/actions/preserve-scroll";
import {
	Book,
	ExternalLink,
	FileText,
	Globe,
	Paperclip,
	Quote,
	ChevronDown,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import type {
	DocumentWorkspaceItem,
	EvidenceSourceType,
	MessageEvidenceItem,
	MessageEvidenceSummary,
} from "$lib/types";

let {
	evidenceSummary,
	onOpenDocument = undefined,
}: {
	evidenceSummary: MessageEvidenceSummary;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
} = $props();

let expanded = $state(false);
let container = $state<HTMLDivElement | null>(null);

// Flatten every item across groups; the disclosure reports overall counts
// and re-groups by status (Used / Set aside), not by sourceType.
let allItems = $derived(evidenceSummary.groups.flatMap((group) => group.items));
// `reference` items are contextual memory that informed the answer (task state,
// recent turns, session memory), so they count as Used alongside `selected`;
// only `rejected` items are set aside.
let usedItems = $derived(
	allItems.filter(
		(item) => item.status === "selected" || item.status === "reference",
	),
);
let setAsideItems = $derived(
	allItems.filter((item) => item.status === "rejected"),
);

let consideredCount = $derived(allItems.length);
let usedCount = $derived(usedItems.length);

async function toggle() {
	await preserveScrollOnToggle(container ?? undefined, expanded, () => {
		expanded = !expanded;
	});
}

// Map each EvidenceSourceType to its Lucide type icon.
function typeIconFor(sourceType: EvidenceSourceType): typeof FileText {
	switch (sourceType) {
		case "document":
			return FileText;
		case "web":
			return Globe;
		case "memory":
			return Quote;
		case "tool":
			return Paperclip;
		default:
			return FileText;
	}
}

// Privacy proxy (ADR 0043, Slice 12/15): route web favicons through our own
// /api/favicon endpoint so researched domains are not leaked to third-party
// favicon services. Mirrors the getFaviconUrl helper in ThinkingBlock.svelte.
function getFaviconUrl(raw: string): string | null {
	try {
		const parsed = new URL(raw);
		const host = parsed.hostname.replace(/^www\./, "");
		return `/api/favicon?domain=${encodeURIComponent(host)}`;
	} catch {
		return null;
	}
}

function isDocument(item: MessageEvidenceItem): boolean {
	return (
		item.sourceType === "document" &&
		Boolean(item.artifactId) &&
		Boolean(onOpenDocument)
	);
}

function openDocument(item: MessageEvidenceItem) {
	if (!onOpenDocument || !item.artifactId) return;
	const document: DocumentWorkspaceItem = {
		id: `artifact:${item.artifactId}`,
		source: "knowledge_artifact",
		filename: item.title,
		title: item.title,
		mimeType: null,
		artifactId: item.artifactId,
	};
	onOpenDocument(document);
}
</script>

<div class="evidence-shell" bind:this={container}>
	<button
		type="button"
		class="evidence-toggle"
		aria-expanded={expanded}
		onclick={toggle}
	>
		<span class="evidence-toggle-copy">
			<Book size={14} strokeWidth={2} class="evidence-book" aria-hidden="true" />
			<span class="evidence-label">{$t('messageEvidenceDetails.sourcesLabel')}</span>
			{#if expanded}
				<span class="evidence-summary-line">
					{$t('messageEvidenceDetails.consideredUsedFormat', {
						considered: consideredCount,
						used: usedCount,
					})}
				</span>
			{/if}
		</span>
		<ChevronDown size={14} strokeWidth={2} class={`chevron${expanded ? ' expanded' : ''}`} aria-hidden="true" />
	</button>

	{#if expanded}
		<div class="evidence-groups">
			{#if usedItems.length > 0}
				<section class="evidence-group evidence-group--used">
					<h4 class="evidence-group-title">{$t('messageEvidenceDetails.used')}</h4>
					<div class="evidence-list" role="group" aria-label={$t('messageEvidenceDetails.used')}>
						{#each usedItems as item, itemIndex (`used-${item.id}-${item.status}-${itemIndex}`)}
							{@render renderItem(item)}
						{/each}
					</div>
				</section>
			{/if}
			{#if setAsideItems.length > 0}
				<section class="evidence-group evidence-group--aside">
					<h4 class="evidence-group-title">{$t('messageEvidenceDetails.setAside')}</h4>
					<div class="evidence-list" role="group" aria-label={$t('messageEvidenceDetails.setAside')}>
						{#each setAsideItems as item, itemIndex (`aside-${item.id}-${item.status}-${itemIndex}`)}
							{@render renderItem(item)}
						{/each}
					</div>
				</section>
			{/if}
		</div>
	{/if}
</div>

{#snippet renderItem(item: MessageEvidenceItem)}
	{@const TypeIcon = typeIconFor(item.sourceType)}
	{@const clickableDoc = isDocument(item)}
	<div class={`evidence-row${clickableDoc ? ' evidence-row--clickable' : ''}${item.status === 'rejected' ? ' evidence-row--aside' : ''}`}>
		{#if clickableDoc}
			<button
				type="button"
				class="evidence-row-button"
				title={$t('messageEvidenceDetails.openDocument')}
				onclick={() => openDocument(item)}
			>
				<TypeIcon size={13} strokeWidth={1.8} class="evidence-type-icon" aria-hidden="true" />
				<span class="evidence-title">{item.title}</span>
				<ExternalLink size={12} strokeWidth={1.8} class="evidence-open-icon" aria-hidden="true" />
			</button>
		{:else if item.url}
			{@const faviconUrl = getFaviconUrl(item.url)}
			<a
				class="evidence-row-link"
				href={item.url}
				target="_blank"
				rel="noopener noreferrer"
			>
				<span class="evidence-type-icon-stack" aria-hidden="true">
					{#if faviconUrl}
						<img
							class="evidence-favicon"
							src={faviconUrl}
							alt=""
							loading="lazy"
							decoding="async"
							referrerpolicy="no-referrer"
							onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
						/>
					{/if}
					<TypeIcon
						size={13}
						strokeWidth={1.8}
						class="evidence-type-icon"
						aria-hidden="true"
					/>
				</span>
				<span class="evidence-title evidence-title--web">{item.title}</span>
			</a>
		{:else}
			<div class="evidence-row-plain">
				<TypeIcon size={13} strokeWidth={1.8} class="evidence-type-icon" aria-hidden="true" />
				<span class="evidence-title">{item.title}</span>
			</div>
		{/if}
		{#if item.description}
			<div class="evidence-description">{item.description}</div>
		{/if}
	</div>
{/snippet}

<style>
	.evidence-shell {
		margin-top: var(--space-md);
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent 30%);
		padding-top: var(--space-sm);
	}

	.evidence-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		width: 100%;
		border: none;
		background: transparent;
		padding: var(--space-xs) 0;
		font-family: var(--font-sans);
		color: var(--text-muted);
		cursor: pointer;
	}

	.evidence-toggle:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: 2px;
	}

	.evidence-toggle-copy {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.evidence-book {
		color: var(--accent);
		flex-shrink: 0;
	}

	.evidence-label {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.evidence-summary-line {
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	.chevron {
		color: var(--icon-muted);
		flex-shrink: 0;
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.chevron.expanded {
		transform: rotate(180deg);
	}

	.evidence-groups {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		margin-top: var(--space-sm);
	}

	.evidence-group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.evidence-group--used {
		border-left: 2px solid var(--accent);
		padding-left: 0.6rem;
	}

	.evidence-group-title {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
	}

	.evidence-group--aside .evidence-group-title {
		color: var(--text-muted);
	}

	.evidence-list {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.evidence-row {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.evidence-row--clickable {
		border-radius: var(--radius-sm);
	}

	.evidence-row-button,
	.evidence-row-link,
	.evidence-row-plain {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.35rem;
		width: 100%;
		border: none;
		background: transparent;
		font-family: var(--font-sans);
		text-align: left;
		cursor: default;
		color: var(--text-primary);
	}

	.evidence-row-button {
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.evidence-row-button:hover {
		background: color-mix(in srgb, var(--surface-elevated) 60%, transparent 40%);
	}

	.evidence-row-link {
		cursor: pointer;
		text-decoration: none;
	}

	.evidence-type-icon {
		color: var(--icon-muted);
		flex-shrink: 0;
	}

	.evidence-type-icon-stack {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 13px;
		height: 13px;
	}

	.evidence-favicon {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		border-radius: 2px;
		/* The Globe icon sits underneath; the favicon covers it when it loads.
		   If the favicon fails to load, onerror hides the <img> and the Globe
		   shows through as the graceful fallback. */
	}

	.evidence-title {
		font-size: var(--text-sm);
		line-height: 1.35;
		color: var(--text-primary);
		word-break: break-word;
		flex: 1;
		min-width: 0;
	}

	.evidence-title--web {
		text-decoration: underline;
		text-underline-offset: 2px;
		text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent 60%);
	}

	.evidence-row-link:hover .evidence-title--web {
		text-decoration-color: var(--accent);
	}

	.evidence-open-icon {
		color: var(--icon-muted);
		flex-shrink: 0;
		opacity: 0.55;
	}

	.evidence-row--aside {
		opacity: 0.55;
	}

	.evidence-description {
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-secondary);
		word-break: break-word;
		padding-left: 0.35rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
</style>
