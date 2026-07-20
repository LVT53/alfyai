<script lang="ts">
import { cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import { preserveScrollOnToggle } from "$lib/actions/preserve-scroll";
import { prefersReducedMotion, reducedMotionAware } from "$lib/utils/motion";
import {
	Archive,
	Book,
	Check,
	ExternalLink,
	EyeOff,
	FileText,
	Globe,
	Paperclip,
	Pencil,
	Quote,
	ChevronDown,
} from "@lucide/svelte";
import { t } from "$lib/i18n";
import {
	fetchMemoryProfile,
	submitKnowledgeMemoryAction,
	submitMemoryV2Action,
} from "$lib/client/api/knowledge";
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

/**
 * Left-to-right wipe reveal for the "considered/used" line. A single
 * custom transition (rather than a CSS animation + a separate out:
 * transition) so the exit is guaranteed to retrace the same left-to-right
 * axis in reverse, instead of drifting off in some other direction.
 */
function wipeReveal(_node: HTMLElement, params: { duration?: number } = {}) {
	return {
		duration: prefersReducedMotion() ? 0 : (params.duration ?? 260),
		easing: cubicOut,
		css: (t: number) =>
			`opacity: ${t}; clip-path: inset(0 ${(1 - t) * 100}% 0 0);`,
	};
}

const flyOut = reducedMotionAware(fly);

let expanded = $state(false);
let container = $state<HTMLDivElement | null>(null);

// Flatten every item across groups; the disclosure reports overall counts and
// re-groups by the C1 citation-driven status, not by sourceType:
//   selected  → "Cited by the answer" (the answer actually cited this source)
//   reference → "Also found" (retrieved, informed context, but not cited)
//   rejected  → "Set aside" (only surfaces in the zero-citation fallback)
let allItems = $derived(evidenceSummary.groups.flatMap((group) => group.items));
let citedItems = $derived(
	allItems.filter((item) => item.status === "selected"),
);
let alsoFoundItems = $derived(
	allItems.filter((item) => item.status === "reference"),
);
let setAsideItems = $derived(
	allItems.filter((item) => item.status === "rejected"),
);

// Memory-derived items (task state, recent turns, persona facts, session/
// workflow memory, project-folder siblings, memory-tool candidates) all
// share sourceType "memory" and, rendered individually, can flood the
// disclosure with many near-identical rows. Collapse every memory item
// within a bucket (Used / Set aside) into a single expandable "Memory" row
// carrying a count; non-memory items keep their existing one-row-per-item
// rendering untouched. In practice memory items are always `reference`, so
// the Set-aside bucket rarely (if ever) contains one — but the same
// collapsing rule applies there too for consistency should it happen.
type EvidenceRow =
	| { kind: "item"; item: MessageEvidenceItem }
	| { kind: "memory-group"; items: MessageEvidenceItem[] };

function buildRows(items: MessageEvidenceItem[]): EvidenceRow[] {
	const rows: EvidenceRow[] = [];
	let memoryGroup: MessageEvidenceItem[] | null = null;
	for (const item of items) {
		if (item.sourceType === "memory") {
			if (!memoryGroup) {
				memoryGroup = [];
				rows.push({ kind: "memory-group", items: memoryGroup });
			}
			memoryGroup.push(item);
			continue;
		}
		rows.push({ kind: "item", item });
	}
	return rows;
}

let citedRows = $derived(buildRows(citedItems));
let alsoFoundRows = $derived(buildRows(alsoFoundItems));
let setAsideRows = $derived(buildRows(setAsideItems));

let citedMemoryExpanded = $state(false);
let alsoFoundMemoryExpanded = $state(false);
let asideMemoryExpanded = $state(false);

type EvidenceBucket = "cited" | "also" | "aside";

function memoryGroupExpanded(bucket: EvidenceBucket): boolean {
	if (bucket === "cited") return citedMemoryExpanded;
	if (bucket === "also") return alsoFoundMemoryExpanded;
	return asideMemoryExpanded;
}

function toggleMemoryGroup(bucket: EvidenceBucket) {
	if (bucket === "cited") {
		citedMemoryExpanded = !citedMemoryExpanded;
	} else if (bucket === "also") {
		alsoFoundMemoryExpanded = !alsoFoundMemoryExpanded;
	} else {
		asideMemoryExpanded = !asideMemoryExpanded;
	}
}

// "Considered" reflects the raw number of candidate signals the system
// evaluated. With the C1 citation-driven statuses, "used" now means the
// sources the answer actually cited (status "selected") — the precise,
// user-meaningful count, independent of how memory rows collapse for display.
let consideredCount = $derived(allItems.length);
let usedCount = $derived(citedItems.length);

// Entrance-cascade timing: each row/title is one "slot" in a single running
// sequence (title, then its rows, then the next section's title, etc.) so
// the whole expanded box reveals top-to-bottom, one piece after another,
// rather than every group starting its own cascade at the same instant.
const STAGGER_STEP_MS = 70;
const MAX_STAGGER_SLOTS = 14;

function slotDelay(slot: number): string {
	return `${Math.min(slot, MAX_STAGGER_SLOTS) * STAGGER_STEP_MS}ms`;
}

const citedTitleSlot = 0;
const citedRowSlotStart = 1;
let alsoFoundTitleSlot = $derived(citedRows.length + 1);
let alsoFoundRowSlotStart = $derived(alsoFoundTitleSlot + 1);
let asideTitleSlot = $derived(alsoFoundTitleSlot + 1 + alsoFoundRows.length);
let asideRowSlotStart = $derived(asideTitleSlot + 1);

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

// --- Memory-fact inline actions (ADR-aligned Correct / Don't use / Retire) ---
// Persona facts surface in evidence with ids like `memory-fact:<itemId>`;
// tapping one reveals inline actions that post through the same knowledge
// memory API the Knowledge page uses.
const MEMORY_FACT_PREFIX = "memory-fact:";

type MemoryActionOutcome = "corrected" | "suppressed" | "retired";

let openMemoryActionId = $state<string | null>(null);
let correctingId = $state<string | null>(null);
let correctionDraft = $state("");
let memoryActionBusyId = $state<string | null>(null);
let memoryActionErrorId = $state<string | null>(null);
let memoryActionDoneById = $state<Record<string, MemoryActionOutcome>>({});

function isMemoryFact(item: MessageEvidenceItem): boolean {
	return item.id.startsWith(MEMORY_FACT_PREFIX);
}

function memoryItemIdOf(item: MessageEvidenceItem): string {
	const fromMetadata = item.metadata?.memoryItemId;
	if (typeof fromMetadata === "string" && fromMetadata) return fromMetadata;
	return item.id.slice(MEMORY_FACT_PREFIX.length);
}

function toggleMemoryActions(item: MessageEvidenceItem) {
	if (memoryActionDoneById[item.id]) return;
	openMemoryActionId = openMemoryActionId === item.id ? null : item.id;
	correctingId = null;
	memoryActionErrorId = null;
}

function startCorrection(item: MessageEvidenceItem) {
	correctingId = item.id;
	correctionDraft = item.title;
}

function outcomeLabel(outcome: MemoryActionOutcome): string {
	if (outcome === "corrected")
		return $t("messageEvidenceDetails.memoryCorrected");
	if (outcome === "retired") return $t("messageEvidenceDetails.memoryRetired");
	return $t("messageEvidenceDetails.memorySuppressed");
}

async function runMemoryAction(
	item: MessageEvidenceItem,
	action: "correct" | "suppress" | "retire",
) {
	if (memoryActionBusyId) return;
	const statement = correctionDraft.trim();
	if (action === "correct" && !statement) return;
	memoryActionBusyId = item.id;
	memoryActionErrorId = null;
	try {
		const itemId = memoryItemIdOf(item);
		// The optimistic-concurrency flow needs the latest projection
		// revision; chat has no profile in scope, so fetch it just-in-time.
		const profile = await fetchMemoryProfile();
		const expectedProjectionRevision = profile.projectionRevision;
		if (action === "suppress") {
			await submitKnowledgeMemoryAction({
				target: "profile_item",
				action: "suppress",
				itemId,
				expectedProjectionRevision,
			});
			memoryActionDoneById = {
				...memoryActionDoneById,
				[item.id]: "suppressed",
			};
		} else if (action === "retire") {
			await submitMemoryV2Action({
				kind: "profile_item",
				action: "retire",
				itemId,
				expectedProjectionRevision,
			});
			memoryActionDoneById = { ...memoryActionDoneById, [item.id]: "retired" };
		} else {
			await submitMemoryV2Action({
				kind: "profile_item",
				action: "correct",
				itemId,
				statement,
				expectedProjectionRevision,
			});
			memoryActionDoneById = {
				...memoryActionDoneById,
				[item.id]: "corrected",
			};
		}
		openMemoryActionId = null;
		correctingId = null;
	} catch {
		memoryActionErrorId = item.id;
	} finally {
		memoryActionBusyId = null;
	}
}

// Compact per-item detail line: prefer the explicit description, fall back to
// the citation reason C1 attaches to web items. Surfaced both inline and as a
// hover tooltip (title) so a long reason stays reachable without bloating the
// row.
function itemDetail(item: MessageEvidenceItem): string | undefined {
	const detail = item.description ?? item.reason;
	return detail && detail.trim() ? detail.trim() : undefined;
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
				<span class="evidence-summary-line" transition:wipeReveal={{ duration: 260 }}>
					{$t('messageEvidenceDetails.consideredUsedFormat', {
						considered: consideredCount,
						used: usedCount,
					})}
				</span>
			{/if}
		</span>
		<span class={`chevron${expanded ? ' expanded' : ''}`}>
			<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
		</span>
	</button>

	{#if expanded}
		<div class="evidence-groups" out:flyOut={{ y: -6, duration: 200 }}>
			{#if citedRows.length > 0}
				{@const citedLabel = $t('messageEvidenceDetails.citedByAnswer', { count: citedItems.length })}
				<section
					class="evidence-group evidence-group--cited"
					style={`animation-delay: ${slotDelay(citedTitleSlot)}`}
				>
					<h4 class="evidence-group-title" style={`animation-delay: ${slotDelay(citedTitleSlot)}`}>
						{citedLabel}
					</h4>
					<div class="evidence-list" role="group" aria-label={citedLabel}>
						{#each citedRows as row, rowIndex (row.kind === 'item' ? `cited-${row.item.id}-${row.item.status}-${rowIndex}` : 'cited-memory-group')}
							{#if row.kind === 'item'}
								{@render renderItem(row.item, citedRowSlotStart + rowIndex)}
							{:else}
								{@render renderMemoryGroup(row.items, citedRowSlotStart + rowIndex, 'cited')}
							{/if}
						{/each}
					</div>
				</section>
			{/if}
			{#if alsoFoundRows.length > 0}
				{@const alsoFoundLabel = $t('messageEvidenceDetails.alsoFound', { count: alsoFoundItems.length })}
				<section
					class="evidence-group evidence-group--reference"
					style={`animation-delay: ${slotDelay(alsoFoundTitleSlot)}`}
				>
					<h4 class="evidence-group-title" style={`animation-delay: ${slotDelay(alsoFoundTitleSlot)}`}>
						{alsoFoundLabel}
					</h4>
					<div class="evidence-list" role="group" aria-label={alsoFoundLabel}>
						{#each alsoFoundRows as row, rowIndex (row.kind === 'item' ? `also-${row.item.id}-${row.item.status}-${rowIndex}` : 'also-memory-group')}
							{#if row.kind === 'item'}
								{@render renderItem(row.item, alsoFoundRowSlotStart + rowIndex)}
							{:else}
								{@render renderMemoryGroup(row.items, alsoFoundRowSlotStart + rowIndex, 'also')}
							{/if}
						{/each}
					</div>
				</section>
			{/if}
			{#if setAsideRows.length > 0}
				<section
					class="evidence-group evidence-group--aside"
					style={`animation-delay: ${slotDelay(asideTitleSlot)}`}
				>
					<h4 class="evidence-group-title" style={`animation-delay: ${slotDelay(asideTitleSlot)}`}>
						{$t('messageEvidenceDetails.setAside')}
					</h4>
					<div class="evidence-list" role="group" aria-label={$t('messageEvidenceDetails.setAside')}>
						{#each setAsideRows as row, rowIndex (row.kind === 'item' ? `aside-${row.item.id}-${row.item.status}-${rowIndex}` : 'aside-memory-group')}
							{#if row.kind === 'item'}
								{@render renderItem(row.item, asideRowSlotStart + rowIndex)}
							{:else}
								{@render renderMemoryGroup(row.items, asideRowSlotStart + rowIndex, 'aside')}
							{/if}
						{/each}
					</div>
				</section>
			{/if}
		</div>
	{/if}
</div>

{#snippet renderItem(item: MessageEvidenceItem, slot: number)}
	{@const TypeIcon = typeIconFor(item.sourceType)}
	{@const clickableDoc = isDocument(item)}
	<div
		class={`evidence-row${clickableDoc ? ' evidence-row--clickable' : ''}${item.status === 'rejected' ? ' evidence-row--aside' : ''}`}
		style={`animation-delay: ${slotDelay(slot)}`}
	>
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
		{:else if isMemoryFact(item)}
			<button
				type="button"
				class="evidence-row-button"
				aria-expanded={openMemoryActionId === item.id}
				onclick={() => toggleMemoryActions(item)}
			>
				<TypeIcon size={13} strokeWidth={1.8} class="evidence-type-icon" aria-hidden="true" />
				<span class="evidence-title">{item.title}</span>
			</button>
			{#if memoryActionDoneById[item.id]}
				<div class="evidence-memory-confirm" role="status">
					<Check size={12} strokeWidth={2.1} aria-hidden="true" />
					{outcomeLabel(memoryActionDoneById[item.id])}
				</div>
			{:else if openMemoryActionId === item.id}
				<div
					class="evidence-memory-actions"
					role="group"
					aria-label={$t('messageEvidenceDetails.memoryActions')}
				>
					{#if correctingId === item.id}
						<input
							type="text"
							class="evidence-memory-input"
							bind:value={correctionDraft}
							placeholder={$t('messageEvidenceDetails.memoryCorrectPlaceholder')}
							aria-label={$t('messageEvidenceDetails.memoryCorrect')}
						/>
						<button
							type="button"
							class="evidence-memory-action"
							disabled={memoryActionBusyId === item.id || correctionDraft.trim().length === 0}
							onclick={() => void runMemoryAction(item, 'correct')}
						>
							<Check size={12} strokeWidth={2.1} aria-hidden="true" />
							{$t('messageEvidenceDetails.memorySaveCorrection')}
						</button>
					{:else}
						<button
							type="button"
							class="evidence-memory-action"
							disabled={memoryActionBusyId === item.id}
							onclick={() => startCorrection(item)}
						>
							<Pencil size={12} strokeWidth={2.1} aria-hidden="true" />
							{$t('messageEvidenceDetails.memoryCorrect')}
						</button>
						<button
							type="button"
							class="evidence-memory-action"
							disabled={memoryActionBusyId === item.id}
							onclick={() => void runMemoryAction(item, 'suppress')}
						>
							<EyeOff size={12} strokeWidth={2.1} aria-hidden="true" />
							{$t('messageEvidenceDetails.memoryDontUse')}
						</button>
						<button
							type="button"
							class="evidence-memory-action"
							disabled={memoryActionBusyId === item.id}
							onclick={() => void runMemoryAction(item, 'retire')}
						>
							<Archive size={12} strokeWidth={2.1} aria-hidden="true" />
							{$t('messageEvidenceDetails.memoryRetire')}
						</button>
					{/if}
				</div>
				{#if memoryActionErrorId === item.id}
					<div class="evidence-memory-error" role="alert">
						{$t('messageEvidenceDetails.memoryActionFailed')}
					</div>
				{/if}
			{/if}
		{:else}
			<div class="evidence-row-plain">
				<TypeIcon size={13} strokeWidth={1.8} class="evidence-type-icon" aria-hidden="true" />
				<span class="evidence-title">{item.title}</span>
			</div>
		{/if}
		{#if itemDetail(item)}
			<div class="evidence-description" title={itemDetail(item)}>{itemDetail(item)}</div>
		{/if}
	</div>
{/snippet}

{#snippet renderMemoryGroup(items: MessageEvidenceItem[], slot: number, bucket: EvidenceBucket)}
	{@const TypeIcon = typeIconFor('memory')}
	{@const isExpanded = memoryGroupExpanded(bucket)}
	<div
		class={`evidence-row${bucket === 'aside' ? ' evidence-row--aside' : ''}`}
		style={`animation-delay: ${slotDelay(slot)}`}
	>
		<button
			type="button"
			class="evidence-row-button"
			aria-expanded={isExpanded}
			onclick={() => toggleMemoryGroup(bucket)}
		>
			<TypeIcon size={13} strokeWidth={1.8} class="evidence-type-icon" aria-hidden="true" />
			<span class="evidence-title">
				{$t('messageEvidenceDetails.memoryGroupLabel', { count: items.length })}
			</span>
			<ChevronDown
				size={12}
				strokeWidth={1.8}
				class={`evidence-open-icon${isExpanded ? ' expanded' : ''}`}
				aria-hidden="true"
			/>
		</button>
		{#if isExpanded}
			<div class="evidence-memory-group-items">
				{#each items as item (item.id)}
					{@render renderItem(item, 0)}
				{/each}
			</div>
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
		/* The section (including its accent border) fades + drops in together
		   with its title, so the box itself doesn't just snap into existence
		   while only the text inside animates. */
		animation: evidence-fade-drop-in 0.26s ease-out backwards;
	}

	/* Cited group leads with the accent rail — these are the sources the answer
	   actually cited. "Also found" gets a quieter neutral rail so it reads as
	   secondary without disappearing. */
	.evidence-group--cited {
		border-left: 2px solid var(--accent);
		padding-left: 0.6rem;
	}

	.evidence-group--reference {
		border-left: 2px solid color-mix(in srgb, var(--border-default) 70%, transparent);
		padding-left: 0.6rem;
	}

	.evidence-group--reference .evidence-group-title {
		color: var(--text-muted);
	}

	.evidence-group-title {
		margin: 0;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
		animation: evidence-fade-drop-in 0.26s ease-out backwards;
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
		/* backwards (not forwards): holds the 0% frame during animation-delay
		   for the stagger, then releases back to normal cascade so the
		   --aside dimmed opacity below still applies at rest. */
		animation: evidence-fade-drop-in 0.26s ease-out backwards;
	}

	/* Shared top-to-bottom entrance: each piece drops down into place from
	   just above its resting position, rather than rising up from below. */
	@keyframes evidence-fade-drop-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
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
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.evidence-open-icon.expanded {
		transform: rotate(180deg);
	}

	.evidence-row--aside {
		opacity: 0.55;
	}

	.evidence-memory-group-items {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		margin-left: 0.25rem;
		padding-left: 1.1rem;
		border-left: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent 40%);
	}

	.evidence-memory-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		padding: 0.15rem 0.35rem 0.3rem 1.6rem;
	}

	.evidence-memory-action {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: 1px solid var(--border-default);
		border-radius: 9999px;
		background: transparent;
		padding: 0.25rem 0.6rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-primary);
		cursor: pointer;
		transition: border-color var(--duration-standard) var(--ease-out);
	}

	.evidence-memory-action:hover {
		border-color: var(--accent);
	}

	.evidence-memory-action:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.evidence-memory-action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.evidence-memory-input {
		flex: 1;
		min-width: 10rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--surface-page);
		padding: 0.3rem 0.5rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.evidence-memory-input:focus-visible {
		outline: none;
		border-color: var(--accent);
	}

	.evidence-memory-confirm {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.1rem 0.35rem 0.2rem 1.6rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--accent);
	}

	.evidence-memory-error {
		padding: 0.1rem 0.35rem 0.2rem 1.6rem;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		color: var(--danger);
	}

	.evidence-description {
		font-size: var(--text-xs);
		line-height: 1.45;
		color: var(--text-secondary);
		word-break: break-word;
		padding-left: 0.35rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron,
		.evidence-open-icon {
			transition: none;
		}

		.evidence-summary-line,
		.evidence-group,
		.evidence-group-title,
		.evidence-row {
			animation: none;
		}
	}
</style>
