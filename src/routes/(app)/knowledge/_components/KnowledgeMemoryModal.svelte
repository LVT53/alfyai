<script lang="ts">
import { onDestroy, onMount } from "svelte";
import type {
	MemoryProfileActionPayload,
	MemoryProfilePublicItemDetail,
	MemoryProfilePublicItem,
} from "$lib/types";
import { t } from "$lib/i18n";
import { Check, Loader, Save, Trash2, Undo2, X } from "@lucide/svelte";

type OptionalItemDetail = MemoryProfilePublicItem & {
	whyRemembered?: string | null;
	sourceChips?: MemoryProfilePublicItemDetail["sourceChips"];
};

let {
	item,
	projectionRevision,
	pendingActionKey,
	actionError,
	onClose,
	onAction,
}: {
	item: OptionalItemDetail;
	projectionRevision: number;
	pendingActionKey: string | null;
	actionError: string;
	onClose: () => void;
	onAction: (
		payload: MemoryProfileActionPayload,
	) => boolean | Promise<boolean | undefined>;
} = $props();

let statement = $state("");
let sourcesExpanded = $state(false);
let dialogRef = $state<HTMLElement | null>(null);
let statementInputRef = $state<HTMLTextAreaElement | null>(null);
let previousFocus: HTMLElement | null = null;

let actionKey = $derived(`${item.id}:edit`);
let deleteKey = $derived(`${item.id}:delete`);
let isSaving = $derived(pendingActionKey === actionKey);
let isDeleting = $derived(pendingActionKey === deleteKey);
let trimmedStatement = $derived(statement.trim());
let canSave = $derived(
	trimmedStatement.length > 0 && trimmedStatement !== item.statement,
);
let sourceChips = $derived(
	(item.sourceChips ?? []).filter((chip) => chip.label || chip.summary),
);
let visibleSourceChips = $derived(
	sourcesExpanded ? sourceChips : sourceChips.slice(0, 3),
);
let hiddenSourceCount = $derived(
	Math.max(0, sourceChips.length - visibleSourceChips.length),
);
let fullScopeLabel = $derived(formatFullScope(item.scope));

$effect(() => {
	statement = item.statement;
	sourcesExpanded = false;
});

function formatFullScope(scope: MemoryProfilePublicItem["scope"]): string {
	if (scope.type === "global") return $t("memoryProfile.globalScope");
	const scopeLabel =
		scope.type === "project"
			? $t("memoryProfile.projectScope")
			: scope.type === "conversation"
				? $t("memoryProfile.conversationScope")
				: $t("memoryProfile.documentScope");
	return `${scopeLabel} ${scope.id}`;
}

function submitEdit() {
	if (!canSave || isSaving) return;
	void onAction({
		action: "edit",
		itemId: item.id,
		statement: trimmedStatement,
		expectedProjectionRevision: projectionRevision,
	});
}

function submitDelete() {
	if (isDeleting) return;
	void onAction({
		action: "delete",
		itemId: item.id,
		expectedProjectionRevision: projectionRevision,
	});
}

function getFocusableElements(): HTMLElement[] {
	return Array.from(
		dialogRef?.querySelectorAll<HTMLElement>(
			'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
		) ?? [],
	);
}

function trapTabNavigation(event: KeyboardEvent) {
	const focusable = getFocusableElements();
	if (focusable.length === 0) {
		event.preventDefault();
		dialogRef?.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const activeElement = document.activeElement;
	if (!(activeElement instanceof Node) || !dialogRef?.contains(activeElement)) {
		event.preventDefault();
		first.focus();
		return;
	}
	if (event.shiftKey && activeElement === first) {
		event.preventDefault();
		last.focus();
		return;
	}
	if (!event.shiftKey && activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		onClose();
		return;
	}
	if (event.key === "Tab") {
		trapTabNavigation(event);
	}
}

onMount(() => {
	previousFocus = document.activeElement as HTMLElement | null;
	setTimeout(() => {
		const initialFocus =
			statementInputRef ?? getFocusableElements()[0] ?? dialogRef;
		initialFocus?.focus();
	}, 0);
});

onDestroy(() => {
	previousFocus?.focus?.();
	previousFocus = null;
});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-[120] flex items-center justify-center bg-surface-overlay/65 p-4 backdrop-blur-sm"
	role="presentation"
	onclick={onClose}
>
	<div
		bind:this={dialogRef}
		role="dialog"
		aria-modal="true"
		aria-labelledby="memory-profile-item-title"
		tabindex={-1}
		class="max-h-[88vh] w-full max-w-[640px] overflow-hidden rounded-[1rem] border border-border bg-surface-elevated shadow-2xl"
		onclick={(event) => event.stopPropagation()}
	>
		<div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
			<div>
				<div class="text-xs font-sans uppercase text-text-muted">{$t("memory.title")}</div>
				<h3 id="memory-profile-item-title" class="mt-1 text-xl font-serif text-text-primary">
					{$t("memoryProfile.itemTitle")}
				</h3>
			</div>
			<button
				type="button"
				class="btn-icon-bare h-10 w-10 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
				onclick={onClose}
				aria-label={$t("memoryProfile.closeMemoryItem")}
				title={$t("memoryProfile.close")}
			>
				<X size={18} strokeWidth={2.1} aria-hidden="true" />
			</button>
		</div>

		<div class="max-h-[calc(88vh-84px)] overflow-y-auto px-5 py-5">
			<label class="block text-sm font-sans font-medium text-text-primary" for="memory-profile-statement">
				{$t("memoryProfile.statement")}
			</label>
			<textarea
				bind:this={statementInputRef}
				id="memory-profile-statement"
				class="mt-2 min-h-36 w-full resize-y rounded-[0.75rem] border border-border bg-surface-page px-3 py-3 text-sm font-sans leading-[1.55] text-text-primary outline-none transition focus:border-primary"
				bind:value={statement}
			></textarea>
			{#if actionError}
				<div class="mt-3 rounded-[0.75rem] border border-danger bg-surface-page px-3 py-2 text-sm font-sans text-danger" role="alert">
					{actionError}
				</div>
			{/if}

			<div class="mt-4 flex flex-wrap gap-2">
				<span class="rounded-full border border-border bg-surface-page px-3 py-1 text-xs font-sans text-text-secondary">
					{$t("memoryProfile.scope")}: {fullScopeLabel}
				</span>
			</div>

			{#if item.whyRemembered || sourceChips.length > 0}
				<div class="mt-4 flex flex-wrap gap-2">
					{#if item.whyRemembered}
						<span class="rounded-full border border-border bg-surface-page px-3 py-1 text-xs font-sans text-text-secondary">
							{$t("memoryProfile.why")}: {item.whyRemembered}
						</span>
					{/if}
					{#each visibleSourceChips as chip, index (`${chip.label ?? ''}:${chip.summary ?? ''}:${index}`)}
						<span class="rounded-full border border-border bg-surface-page px-3 py-1 text-xs font-sans text-text-secondary">
							{chip.label ?? $t("memoryProfile.source")}{chip.summary ? `: ${chip.summary}` : ""}
						</span>
					{/each}
					{#if hiddenSourceCount > 0}
						<button
							type="button"
							class="cursor-pointer rounded-full border border-border bg-surface-page px-3 py-1 text-xs font-sans font-medium text-text-secondary transition hover:bg-surface-elevated"
							onclick={() => (sourcesExpanded = true)}
							aria-label={$t("memoryProfile.showMoreSources", {
								count: hiddenSourceCount,
							})}
						>
							{$t("memoryProfile.moreSources", { count: hiddenSourceCount })}
						</button>
					{/if}
				</div>
			{/if}

			<div class="mt-5 flex flex-wrap items-center justify-end gap-2">
				<button
					type="button"
					class="btn-icon-bare h-10 w-10 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
					onclick={onClose}
					aria-label={$t("memoryProfile.cancelEditing")}
					title={$t("memoryProfile.cancel")}
				>
					<Undo2 size={18} strokeWidth={2.1} aria-hidden="true" />
				</button>
				{#if item.canDelete}
					<button
						type="button"
						class="btn-icon-bare h-10 w-10 cursor-pointer rounded-full text-icon-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
						onclick={submitDelete}
						disabled={isDeleting}
						aria-label={$t("memoryProfile.deleteMemoryItem")}
						title={$t("memoryProfile.delete")}
					>
						{#if isDeleting}
							<Loader size={18} strokeWidth={2.1} class="animate-spin" aria-hidden="true" />
						{:else}
							<Trash2 size={18} strokeWidth={2.1} aria-hidden="true" />
						{/if}
					</button>
				{/if}
				<button
					type="button"
					class="btn-icon inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-primary text-white disabled:cursor-not-allowed disabled:opacity-50"
					onclick={submitEdit}
					disabled={!canSave || isSaving}
					aria-label={$t("memoryProfile.saveMemoryItem")}
					title={$t("memoryProfile.save")}
				>
					{#if isSaving}
						<Loader size={18} strokeWidth={2.1} class="animate-spin" aria-hidden="true" />
					{:else if canSave}
						<Save size={18} strokeWidth={2.1} aria-hidden="true" />
					{:else}
						<Check size={18} strokeWidth={2.1} aria-hidden="true" />
					{/if}
				</button>
			</div>
		</div>
	</div>
</div>
