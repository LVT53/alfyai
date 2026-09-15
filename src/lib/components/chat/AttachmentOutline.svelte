<script lang="ts">
import { ChevronDown, ChevronRight, List } from "@lucide/svelte";
import { t } from "$lib/i18n";
import type { DocumentOutlineEntry } from "$lib/server/services/knowledge/types";

// "Long-document comfort" (owner-approved mockup, 2026-09-06): renders the
// heading outline extracted from a long attachment. Clicking a row hands
// the caller a ready-to-send quote ("Section 2.3 Break clause: <preview>…")
// instead of inserting text itself, so this component works the same way
// whether it sits in the composer's own pending-attachment list (which can
// splice straight into the textarea) or under an already-sent message in
// the chat history (which has to route the request back to the composer
// through $lib/stores/composer-quote).
const DISPLAY_CAP = 40;

let {
	outline,
	onQuote,
	variant = "panel",
	disclosureLabel = "",
}: {
	outline: DocumentOutlineEntry[];
	onQuote: (quote: string) => void;
	// Chips redesign (owner-approved boards, 2026-09-15): in the composer
	// the outline is no longer a bordered panel stacked under a file card —
	// every chip has exactly one × and everything else is a disclosure
	// BESIDE it. "disclosure" draws a 24px pill button next to the chip that
	// opens the same list in a popover; "panel" is the original, still used
	// under an already-sent message in the stream, where there is room.
	variant?: "panel" | "disclosure";
	disclosureLabel?: string;
} = $props();

// A panel starts open (it is the whole surface); a disclosure starts closed
// (it is a button beside a pill). `null` means "the user has not decided
// yet", so the default follows the variant without capturing it once.
let collapsedOverride = $state<boolean | null>(null);
let collapsed = $derived(collapsedOverride ?? variant === "disclosure");
let showAll = $state(false);

let visibleEntries = $derived(
	showAll ? outline : outline.slice(0, DISPLAY_CAP),
);
let hiddenCount = $derived(Math.max(0, outline.length - DISPLAY_CAP));

function buildQuote(entry: DocumentOutlineEntry): string {
	const preview = entry.preview.trim();
	return preview ? `${entry.title}: ${preview}…` : entry.title;
}

function handleQuote(entry: DocumentOutlineEntry) {
	onQuote(buildQuote(entry));
}

function toggleCollapsed() {
	collapsedOverride = !collapsed;
}

function handleQuoteAndClose(entry: DocumentOutlineEntry) {
	handleQuote(entry);
	// Picking a section from the disclosure produces a chip in the row
	// behind it; leaving the popover open would cover the chip it just made.
	if (variant === "disclosure") collapsedOverride = true;
}

function showRemaining() {
	showAll = true;
}
</script>

{#if outline.length > 0}
	<div
		class="attachment-outline"
		class:attachment-outline--disclosure={variant === 'disclosure'}
	>
		{#if variant === 'disclosure'}
			<button
				type="button"
				class="attachment-outline-disclosure"
				data-testid="attachment-outline-disclosure"
				aria-expanded={!collapsed}
				aria-label={disclosureLabel || $t('attachmentOutline.outline')}
				title={disclosureLabel || $t('attachmentOutline.outline')}
				onclick={toggleCollapsed}
			>
				<List size={13} strokeWidth={2} aria-hidden="true" />
			</button>
		{:else}
			<button
				type="button"
				class="attachment-outline-header"
				onclick={toggleCollapsed}
				aria-expanded={!collapsed}
			>
				{#if collapsed}
					<ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
				{:else}
					<ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
				{/if}
				<span
					>{$t('attachmentOutline.outline')} · {$t('attachmentOutline.sectionsLabel', {
						count: outline.length,
					})}</span
				>
			</button>
		{/if}
		{#if !collapsed}
			<div class="attachment-outline-body">
				{#if variant === 'disclosure'}
					<p class="attachment-outline-caption">
						{$t('attachmentOutline.outline')} · {$t('attachmentOutline.sectionsLabel', {
							count: outline.length,
						})}
					</p>
				{/if}
				<ul class="attachment-outline-list">
					{#each visibleEntries as entry, index (`${entry.offset}-${index}`)}
						<li>
							<button
								type="button"
								class="attachment-outline-row"
								class:indented={entry.level > 1}
								onclick={() => handleQuoteAndClose(entry)}
							>
								<span class="attachment-outline-title">{entry.title}</span>
								<span class="attachment-outline-quote">{$t('attachmentOutline.quote')}</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if hiddenCount > 0 && !showAll}
					<button type="button" class="attachment-outline-more" onclick={showRemaining}>
						{$t('attachmentOutline.more', { count: hiddenCount })}
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style lang="postcss">
	.attachment-outline {
		margin-top: 4px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-page);
		overflow: hidden;
	}

	/* Chips redesign — beside a chip the outline is a 24px pill button that
	   opens the same list in a popover, so the composer's chip row stays one
	   row high whatever is attached to it. */
	.attachment-outline--disclosure {
		position: relative;
		margin-top: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		overflow: visible;
	}

	.attachment-outline-disclosure {
		display: inline-grid;
		place-items: center;
		position: relative;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.attachment-outline-disclosure::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		width: 44px;
		height: 44px;
		transform: translate(-50%, -50%);
	}

	@media (pointer: fine) {
		.attachment-outline-disclosure::after {
			width: 24px;
			height: 24px;
		}
	}

	.attachment-outline-disclosure:hover {
		border-radius: var(--radius-full);
		background-color: var(--surface-elevated);
		color: var(--text-primary);
	}

	.attachment-outline-disclosure:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.attachment-outline--disclosure .attachment-outline-body {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 0;
		z-index: 3;
		width: max-content;
		min-width: 220px;
		max-width: 320px;
		max-height: 260px;
		overflow-y: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding-top: 4px;
	}

	.attachment-outline-caption {
		margin: 0;
		padding: 4px 10px 2px;
		font-family: var(--font-sans);
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.attachment-outline-header {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}

	.attachment-outline-header:hover {
		color: var(--text-primary);
	}

	.attachment-outline-header:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.attachment-outline-list {
		list-style: none;
		margin: 0;
		padding: 0 4px 4px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.attachment-outline-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		padding: 4px 8px;
		border-radius: 5px;
		border: none;
		background: transparent;
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
	}

	.attachment-outline-row.indented {
		padding-left: 20px;
	}

	.attachment-outline-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.attachment-outline-quote {
		flex-shrink: 0;
		color: var(--accent);
		font-size: 0.7rem;
		font-weight: 500;
		opacity: 0;
	}

	.attachment-outline-row:hover,
	.attachment-outline-row:focus-visible {
		background-color: var(--surface-elevated);
		color: var(--text-primary);
	}

	.attachment-outline-row:hover .attachment-outline-quote,
	.attachment-outline-row:focus-visible .attachment-outline-quote {
		opacity: 1;
	}

	.attachment-outline-row:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.attachment-outline-more {
		width: 100%;
		padding: 4px 8px 6px;
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		text-align: left;
		cursor: pointer;
	}

	.attachment-outline-more:hover {
		color: var(--text-primary);
	}
</style>
