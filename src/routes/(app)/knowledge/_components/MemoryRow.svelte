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
	.memory-row {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		padding: 0.6rem 0;
		border-top: 1px solid
			color-mix(in srgb, var(--border-default) 50%, transparent 50%);
	}

	/* Only the row that opens the list loses its divider. `:first-child` is not
	   enough: the rows a category discloses are each wrapped in their own
	   transition element, so every one of them would be a first child and the
	   whole expanded tail would come up without separators. The section marks
	   the opening row instead. */
	.memory-row.is-first {
		border-top: none;
	}

	.memory-row:hover {
		background: color-mix(in srgb, var(--accent) 3%, transparent 97%);
	}

	:global(.dark) .memory-row:hover {
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
	}

	.memory-dot {
		flex-shrink: 0;
		width: 0.5rem;
		height: 0.5rem;
		margin-top: 0.4rem;
		border-radius: 9999px;
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
		flex: 1 1 auto;
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
		border-radius: 9999px;
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
		gap: 0.3rem;
		opacity: 0.55;
		transition: opacity 150ms ease;
	}

	.memory-row:hover .memory-row-actions,
	.memory-row:focus-within .memory-row-actions {
		opacity: 1;
	}

	.memory-action {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.55rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: 9999px;
		background: transparent;
		color: var(--text-secondary);
		font-family: var(--font-sans);
		font-size: 0.66rem;
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
		transition:
			border-color 150ms ease,
			background-color 150ms ease,
			color 150ms ease;
	}

	.memory-action:hover:not(:disabled),
	.memory-action:focus-visible:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
	}

	.memory-action--danger {
		color: var(--danger);
	}

	.memory-action--danger:hover:not(:disabled),
	.memory-action--danger:focus-visible:not(:disabled) {
		border-color: var(--danger);
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 7%, transparent 93%);
	}

	.memory-action:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* The actions wrap under the statement on a narrow screen rather than
	   squeezing the words they exist to explain. */
	@media (max-width: 640px) {
		.memory-row {
			flex-wrap: wrap;
		}

		.memory-row-actions {
			opacity: 1;
			width: 100%;
			justify-content: flex-end;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.memory-row-actions,
		.memory-action {
			transition: none !important;
		}
	}
</style>
