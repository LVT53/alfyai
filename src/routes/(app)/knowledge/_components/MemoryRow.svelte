<script lang="ts">
// One remembered fact. Every row still answers "why do you think that?" in
// place: a filled dot means you said it, a hollow one means AlfyAI worked it
// out, and the source line underneath names when. Edit and Remove carry their
// words rather than being two bare 14px glyphs — at fifty rows, a mystery icon
// repeated a hundred times is not a saving.
import type { MemoryProfilePublicItem } from "$lib/memory-profile-types";
import { t } from "$lib/i18n";
import { Eye, Pencil, Trash2 } from "@lucide/svelte";

let {
	item,
	pendingActionKey = null,
	first = false,
	onEdit,
	onRemove,
}: {
	item: MemoryProfilePublicItem;
	pendingActionKey?: string | null;
	/** The row that opens its category — it wears no divider above it. */
	first?: boolean;
	onEdit: (item: MemoryProfilePublicItem) => void;
	onRemove: (item: MemoryProfilePublicItem) => void;
} = $props();

// Absent confidence is not a claim: a row whose provenance the projection
// never recorded gets no dot and a neutral source line, rather than being
// drawn as something you said.
const confidence = $derived(item.confidence ?? null);
const stated = $derived(confidence === "stated");

function formatDate(value: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return value;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		parsed,
	);
}

const sourceLine = $derived.by(() => {
	const date = formatDate(item.updatedAt);
	if (confidence === "stated") {
		return $t("memoryProfile.sourceStated", { date });
	}
	if (confidence === "inferred") {
		return $t("memoryProfile.sourceInferred", { date });
	}
	return $t("memoryProfile.sourceUpdated", { date });
});

const scopeLabel = $derived.by(() => {
	if (item.scope.type === "global") return null;
	if (item.scope.type === "project") return $t("memoryProfile.projectScope");
	if (item.scope.type === "conversation")
		return $t("memoryProfile.conversationScope");
	return $t("memoryProfile.documentScope");
});

const removeBusy = $derived(
	pendingActionKey === `${item.id}:suppress` ||
		pendingActionKey === `${item.id}:delete` ||
		pendingActionKey === `${item.id}:retire`,
);
</script>

<div class="memory-row" class:is-first={first} data-testid="memory-row">
	{#if confidence}
		<span
			class={`memory-dot ${stated ? "memory-dot--stated" : "memory-dot--inferred"}`}
			role="img"
			aria-label={stated
				? $t("memoryProfile.confidenceStated")
				: $t("memoryProfile.confidenceInferred")}
			title={stated
				? $t("memoryProfile.confidenceStated")
				: $t("memoryProfile.confidenceInferred")}
		></span>
	{:else}
		<span class="memory-dot memory-dot--unknown" aria-hidden="true"></span>
	{/if}

	<div class="memory-row-body">
		<p class="memory-statement">
			<span>{item.statement}</span>
			{#if scopeLabel}
				<span class="memory-chip memory-chip--scope">{scopeLabel}</span>
			{/if}
			{#if item.expiresAt}
				<span class="memory-chip memory-chip--expiry">
					{$t("memoryProfile.expiresOn", { date: formatDate(item.expiresAt) })}
				</span>
			{/if}
		</p>
		<p class="memory-source">{sourceLine}</p>
	</div>

	<div class="memory-row-actions">
		<!-- A memory the projection will not let you rewrite opens read-only.
		     Saying "Edit" over it invites a change the dialog then refuses, so
		     the row names what the button actually does. -->
		<button
			type="button"
			class="memory-action"
			onclick={() => onEdit(item)}
			aria-label={item.canEdit
				? $t("memoryProfile.editMemoryItem")
				: $t("memoryProfile.viewMemoryItem")}
		>
			{#if item.canEdit}
				<Pencil size={12} strokeWidth={2.1} aria-hidden="true" />
				<span>{$t("memoryProfile.edit")}</span>
			{:else}
				<Eye size={12} strokeWidth={2.1} aria-hidden="true" />
				<span>{$t("memoryProfile.view")}</span>
			{/if}
		</button>
		{#if item.canSuppress || item.canDelete}
			<button
				type="button"
				class="memory-action memory-action--danger"
				onclick={() => onRemove(item)}
				disabled={removeBusy}
				aria-label={$t("memoryProfile.removeThisMemory")}
			>
				<Trash2 size={12} strokeWidth={2.1} aria-hidden="true" />
				<span>{$t("memoryProfile.remove")}</span>
			</button>
		{/if}
	</div>
</div>

<style>
	/* A grid, not a flex row: the dot sits in the section's shared gutter, so
	   its column, the statement column and the actions column are in the same
	   place on every row whether the statement runs to one line or three.
	   `--memory-gutter` comes from the section; the fallback keeps a row
	   rendered on its own honest. */
	.memory-row {
		display: grid;
		grid-template-columns: var(--memory-gutter, 1.4rem) minmax(0, 1fr) auto;
		align-items: start;
		padding: 0.6rem 0;
		border-top: 1px solid
			color-mix(in srgb, var(--border-default) 50%, transparent 50%);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	/* Only the row that opens the list loses its divider. `:first-child` is not
	   enough: the rows a category discloses are each wrapped in their own
	   transition element, so every one of them would be a first child and the
	   whole expanded tail would come up without separators. The section marks
	   the opening row instead. */
	.memory-row.is-first {
		border-top: none;
	}

	/* The same 4%/7% the document rows use, so a row on either tab answers a
	   pointer with the same amount of colour. */
	.memory-row:hover {
		background: color-mix(in srgb, var(--accent) 4%, transparent 96%);
	}

	:global(.dark) .memory-row:hover {
		background: color-mix(in srgb, var(--accent) 7%, transparent 93%);
	}

	.memory-dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		/* Optically centred on the statement's first line: 0.82rem of text at
		   1.5 line-height is a 19.7px line box, so the 8px dot starts 6px in. */
		margin-top: 0.375rem;
		border-radius: var(--radius-full);
	}

	.memory-dot--stated {
		background: var(--accent);
	}

	.memory-dot--inferred {
		background: transparent;
		border: 1.5px solid var(--accent);
	}

	.memory-dot--unknown {
		background: transparent;
	}

	.memory-row-body {
		min-width: 0;
	}

	.memory-statement {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--text-primary);
		overflow-wrap: anywhere;
	}

	.memory-source {
		margin: 0.15rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.memory-chip {
		display: inline-flex;
		align-items: center;
		margin-left: 0.4rem;
		padding: 0 0.4rem;
		border-radius: var(--radius-full);
		font-size: 0.6rem;
		line-height: 1.5;
		white-space: nowrap;
		vertical-align: 0.05em;
	}

	.memory-chip--scope {
		border: 1px solid var(--border-default);
		color: var(--text-muted);
	}

	.memory-chip--expiry {
		border: 1px solid
			color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
		color: var(--accent);
	}

	.memory-row-actions {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.15rem;
		/* Centred on the statement's FIRST line, not on a row whose height
		   depends on how long the sentence ran: that line box is 1.23rem
		   (0.82rem × 1.5) and the buttons are 1.65rem, so they come up by
		   half the difference. Without this the pair drifts down a row as
		   soon as a statement wraps, and no two rows agree. */
		margin-top: -0.21rem;
	}

	.memory-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.28rem;
		min-height: 1.65rem;
		padding: 0 0.45rem;
		border: 1px solid transparent;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.66rem;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.memory-action:hover:not(:disabled),
	.memory-action:focus-visible:not(:disabled) {
		color: var(--text-primary);
		background: color-mix(in srgb, var(--text-primary) 7%, transparent 93%);
	}

	.memory-action:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Danger is a hover state, not a resting one: fifty rows of standing red
	   is a warning nobody reads. */
	.memory-action--danger:hover:not(:disabled),
	.memory-action--danger:focus-visible:not(:disabled) {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 38%, transparent);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}

	.memory-action:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* The actions wrap under the statement on a narrow screen rather than
	   squeezing the words they exist to explain. */
	/* The actions drop under the statement on a narrow screen rather than
	   squeezing the words they exist to explain. */
	@media (max-width: 640px) {
		.memory-row {
			grid-template-columns: var(--memory-gutter, 1.4rem) minmax(0, 1fr);
		}

		.memory-row-actions {
			grid-column: 2;
			justify-content: flex-end;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.memory-row,
		.memory-action {
			transition: none !important;
		}
	}
</style>
