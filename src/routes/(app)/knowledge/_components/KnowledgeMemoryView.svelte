<script lang="ts">
import type {
	MemoryDirtyReason,
	MemoryProfileActionPayload,
	MemoryProfileCategory,
	MemoryProfilePublicItem,
	MemoryProfilePublicItemDetail,
	MemoryProfilePublicPayload,
	MemoryProfileReviewItem,
	MemoryProfileScope,
	MemoryTimelineReport,
} from "$lib/memory-profile-types";
import { t, type I18nKey } from "$lib/i18n";
import { fetchMemoryProfileItemDetail } from "$lib/client/api/knowledge";
import {
	Archive,
	Check,
	EyeOff,
	HelpCircle,
	Pencil,
	Trash2,
	X,
} from "@lucide/svelte";
import KnowledgeMemoryModal from "./KnowledgeMemoryModal.svelte";
import MemoryTimeline from "./MemoryTimeline.svelte";
import MemoryPortraitCard from "./MemoryPortraitCard.svelte";
import MemoryRailCards from "./MemoryRailCards.svelte";
import Spinner from "$lib/components/ui/Spinner.svelte";
import {
	countActiveMemories,
	type MemoryCategorySelection,
	toggleExpandedCategory,
} from "./memory-categories";

type CategoryDefinition = {
	category: MemoryProfileCategory;
	label: I18nKey;
	empty: I18nKey;
};

const categoryDefinitions: CategoryDefinition[] = [
	{
		category: "about_you",
		label: "memoryProfile.aboutYou",
		empty: "memoryProfile.aboutYouEmpty",
	},
	{
		category: "preferences",
		label: "memoryProfile.preferences",
		empty: "memoryProfile.preferencesEmpty",
	},
	{
		category: "goals_ongoing_work",
		label: "memoryProfile.goals",
		empty: "memoryProfile.goalsEmpty",
	},
	{
		category: "constraints_boundaries",
		label: "memoryProfile.constraints",
		empty: "memoryProfile.constraintsEmpty",
	},
];

let {
	profile,
	memoryLoading,
	memoryLoaded,
	memoryLoadError,
	pendingActionKey,
	actionError,
	onRetryLoadMemory,
	onAction,
	summary = null,
	summaryBusy = false,
	processing = null,
	onEditSummary = undefined,
	timelineReports = [],
	onUndoConsolidation = undefined,
	onRetire = undefined,
}: {
	profile: MemoryProfilePublicPayload | null;
	memoryLoading: boolean;
	memoryLoaded: boolean;
	memoryLoadError: string;
	pendingActionKey: string | null;
	actionError: string;
	onRetryLoadMemory: () => void | Promise<void>;
	onAction: (
		payload: MemoryProfileActionPayload,
	) => boolean | Promise<boolean | undefined>;
	summary?: {
		text: string;
		links?: Array<{ text: string; factIds: string[] }>;
		updatedAt: string;
	} | null;
	summaryBusy?: boolean;
	processing?: {
		active: boolean;
		pendingCount: number;
		operations?: Array<{
			reason: MemoryDirtyReason;
			scope: MemoryProfileScope;
			count: number;
		}>;
	} | null;
	onEditSummary?:
		| ((text: string) => boolean | undefined | Promise<boolean | undefined>)
		| undefined;
	timelineReports?: MemoryTimelineReport[];
	onUndoConsolidation?:
		| ((reportId: string, actionIndex: number) => void | Promise<void>)
		| undefined;
	onRetire?:
		| ((itemId: string) => boolean | undefined | Promise<boolean | undefined>)
		| undefined;
} = $props();

let selectedItem = $state<
	MemoryProfilePublicItem | MemoryProfilePublicItemDetail | null
>(null);
// Filter + inline disclosure state. Both live here rather than in the portrait
// card so that a profile reload (an edit, a retire) keeps the reader exactly
// where they were instead of snapping every category shut.
let memoryFilterText = $state("");
let memorySelection = $state<MemoryCategorySelection>("all");
let expandedCategories = $state<Set<MemoryProfileCategory>>(
	new Set<MemoryProfileCategory>(),
);
let reviewOverflowOpen = $state(false);
let editingReviewItem = $state<MemoryProfileReviewItem | null>(null);
let reviewStatement = $state("");
let reviewOverflowDialog = $state<HTMLElement | null>(null);
let reviewEditDialog = $state<HTMLElement | null>(null);
let reviewEditTextarea = $state<HTMLTextAreaElement | null>(null);
let reviewOverflowPreviousFocus: HTMLElement | null = null;
let reviewEditPreviousFocus: HTMLElement | null = null;

type RemoveTarget =
	| {
			kind: "profile_item";
			item: MemoryProfilePublicItem;
	  }
	| {
			kind: "review_item";
			item: MemoryProfileReviewItem;
	  };
let removeTarget = $state<RemoveTarget | null>(null);
let removeDialog = $state<HTMLElement | null>(null);
let removePreviousFocus: HTMLElement | null = null;

let removeCanDelete = $derived(
	removeTarget?.kind === "profile_item" && removeTarget.item.canDelete,
);
let removeStatement = $derived.by(() => {
	if (!removeTarget) return "";
	if (removeTarget.kind === "profile_item") return removeTarget.item.statement;
	return removeTarget.item.subject;
});

let activeItemCount = $derived(countActiveMemories(profile));
let reviewItems = $derived(
	profile?.review.items ?? profile?.review.visibleItems ?? [],
);
let visibleReviewItems = $derived(
	(profile?.review.visibleItems ?? reviewItems).slice(0, 3),
);
let additionalReviewItems = $derived.by(() => {
	const visibleIds = new Set(visibleReviewItems.map((item) => item.id));
	return reviewItems.filter((item) => !visibleIds.has(item.id));
});
let reviewOverflowCount = $derived(Math.max(0, additionalReviewItems.length));

function handleToggleCategory(category: MemoryProfileCategory) {
	expandedCategories = toggleExpandedCategory(expandedCategories, category);
}

function autoExpireDays(expiresAt: string): number {
	return Math.max(
		0,
		Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000),
	);
}

async function confirmRetire() {
	if (!removeTarget || removeTarget.kind !== "profile_item" || !onRetire) {
		return;
	}
	const success = await onRetire(removeTarget.item.id);
	// Same contract as Forget/Delete: an explicit `false` keeps the modal open
	// so the user can retry or pick another option.
	if (success === false) return;
	closeRemove();
}

function retireKey(itemId: string): string {
	return `${itemId}:retire`;
}

// Privacy-safe friendly copy for the "updating your memory" notice: derived
// only from the operation's reason (never raw fact text — the server never
// sends any). Reasons without a mapped key here fall back to a generic line
// rather than rendering blank/unknown text.
const processingReasonI18nKeys: Partial<Record<MemoryDirtyReason, I18nKey>> = {
	deferred_intake: "memoryProfile.processingReasonDeferredIntake",
	possible_conflict: "memoryProfile.processingReasonPossibleConflict",
	possible_duplicate: "memoryProfile.processingReasonPossibleDuplicate",
	review_generation: "memoryProfile.processingReasonReviewGeneration",
	projection_reconciliation:
		"memoryProfile.processingReasonProjectionReconciliation",
	profile_action_reconciliation:
		"memoryProfile.processingReasonProfileActionReconciliation",
};

function processingReasonLabel(reason: MemoryDirtyReason): string {
	const key = processingReasonI18nKeys[reason];
	return $t(key ?? "memoryProfile.processingReasonFallback");
}

function processingOperationKey(operation: {
	reason: MemoryDirtyReason;
	scope: MemoryProfileScope;
}): string {
	const scopeId =
		operation.scope.type === "global" ? "global" : operation.scope.id;
	return `${operation.reason}:${operation.scope.type}:${scopeId}`;
}

function actionKey(
	itemId: string,
	action: MemoryProfileActionPayload["action"],
): string {
	return `${itemId}:${action}`;
}

function openMemoryItem(item: MemoryProfilePublicItem) {
	selectedItem = item;
	void fetchMemoryProfileItemDetail(item.id)
		.then((detail) => {
			if (selectedItem?.id === item.id) {
				selectedItem = detail;
			}
		})
		.catch((error) => {
			console.warn("[KNOWLEDGE_MEMORY] Failed to load memory item detail", {
				itemId: item.id,
				error,
			});
		});
}

function useReviewItem(item: MemoryProfileReviewItem) {
	if (!item.canAccept) return;
	void onAction({
		target: "review_item",
		action: "accept",
		itemId: item.id,
		expectedProjectionRevision: profile?.projectionRevision ?? 0,
	});
}

function openReviewEditor(item: MemoryProfileReviewItem) {
	reviewOverflowOpen = false;
	editingReviewItem = item;
	reviewStatement = item.subject;
}

function closeReviewOverflow() {
	reviewOverflowOpen = false;
}

function closeReviewEditor() {
	editingReviewItem = null;
	reviewStatement = "";
}

function openRemoveForProfileItem(item: MemoryProfilePublicItem) {
	removeTarget = { kind: "profile_item", item };
}

function openRemoveForReviewItem(item: MemoryProfileReviewItem) {
	removeTarget = { kind: "review_item", item };
}

function closeRemove() {
	removeTarget = null;
}

async function confirmRemove(action: "delete" | "suppress") {
	if (!removeTarget) return;
	const { kind, item } = removeTarget;
	const revision = profile?.projectionRevision ?? 0;
	const success =
		kind === "profile_item"
			? await onAction({
					target: "profile_item",
					action,
					itemId: item.id,
					expectedProjectionRevision: revision,
				})
			: await onAction({
					target: "review_item",
					action: "suppress",
					itemId: item.id,
					expectedProjectionRevision: revision,
				});
	if (success === false) return;
	closeRemove();
}

async function submitReviewEdit() {
	if (!editingReviewItem) return;
	const statement = reviewStatement.trim();
	if (!statement) return;
	const success = await onAction({
		target: "review_item",
		action: "edit",
		itemId: editingReviewItem.id,
		statement,
		expectedProjectionRevision: profile?.projectionRevision ?? 0,
	});
	if (success === false) return;
	closeReviewEditor();
}

function getFocusableElements(dialog: HTMLElement | null): HTMLElement[] {
	return Array.from(
		dialog?.querySelectorAll<HTMLElement>(
			'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
		) ?? [],
	);
}

function focusDialog(dialog: HTMLElement | null, initial?: HTMLElement | null) {
	setTimeout(() => {
		const focusTarget = initial ?? getFocusableElements(dialog)[0] ?? dialog;
		focusTarget?.focus();
	}, 0);
}

function trapTabNavigation(dialog: HTMLElement | null, event: KeyboardEvent) {
	const focusable = getFocusableElements(dialog);
	if (focusable.length === 0) {
		event.preventDefault();
		dialog?.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const activeElement = document.activeElement;
	if (!(activeElement instanceof Node) || !dialog?.contains(activeElement)) {
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
	if (removeTarget) {
		if (event.key === "Escape") {
			event.preventDefault();
			closeRemove();
			return;
		}
		if (event.key === "Tab") {
			trapTabNavigation(removeDialog, event);
		}
		return;
	}

	if (editingReviewItem) {
		if (event.key === "Escape") {
			event.preventDefault();
			closeReviewEditor();
			return;
		}
		if (event.key === "Tab") {
			trapTabNavigation(reviewEditDialog, event);
		}
		return;
	}

	if (!reviewOverflowOpen) return;
	if (event.key === "Escape") {
		event.preventDefault();
		closeReviewOverflow();
		return;
	}
	if (event.key === "Tab") {
		trapTabNavigation(reviewOverflowDialog, event);
	}
}

$effect(() => {
	if (!reviewOverflowOpen) return;
	reviewOverflowPreviousFocus = document.activeElement as HTMLElement | null;
	focusDialog(reviewOverflowDialog);
	return () => {
		reviewOverflowPreviousFocus?.focus?.();
		reviewOverflowPreviousFocus = null;
	};
});

$effect(() => {
	if (!removeTarget) return;
	removePreviousFocus = document.activeElement as HTMLElement | null;
	focusDialog(removeDialog);
	return () => {
		removePreviousFocus?.focus?.();
		removePreviousFocus = null;
	};
});

$effect(() => {
	if (!editingReviewItem) return;
	reviewEditPreviousFocus = document.activeElement as HTMLElement | null;
	focusDialog(reviewEditDialog, reviewEditTextarea);
	return () => {
		reviewEditPreviousFocus?.focus?.();
		reviewEditPreviousFocus = null;
	};
});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if memoryLoading && !memoryLoaded}
	<section class="rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm md:px-5">
		<div class="grid gap-3 md:grid-cols-2">
			{#each categoryDefinitions as category (category.category)}
				<div class="rounded-[0.75rem] border border-border bg-surface-page px-4 py-4">
					<div class="h-4 w-36 animate-pulse rounded-full bg-surface-elevated"></div>
					<div class="mt-4 h-12 w-full animate-pulse rounded-[0.5rem] bg-surface-elevated"></div>
				</div>
			{/each}
		</div>
	</section>
{:else if memoryLoadError && !memoryLoaded}
	<section class="rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm md:px-5">
		<div class="rounded-[0.75rem] border border-danger bg-surface-page px-4 py-5">
			<div class="text-sm font-sans font-medium text-danger">{$t("memoryProfile.failedLoad")}</div>
			<p class="mt-2 text-sm font-sans leading-[1.6] text-text-secondary">{memoryLoadError}</p>
			<button
				type="button"
				class="mt-4 cursor-pointer rounded-full border border-border px-4 py-2 text-sm font-sans font-medium text-text-primary transition hover:bg-surface-elevated"
				onclick={onRetryLoadMemory}
			>
				{$t("memory.tryAgain")}
			</button>
		</div>
	</section>
{:else}
	<section class="memory-profile-section" aria-labelledby="memory-profile-title">
		<div class="memory-profile-head">
			<h2 id="memory-profile-title" class="memory-profile-eyebrow">
				{$t("memoryProfile.eyebrow")}
			</h2>
			<span class="memory-profile-active">
				{$t("memoryProfile.activeChip", { count: activeItemCount })}
			</span>
			<span class="memory-profile-spacer"></span>
			{#if processing?.active}
				<div class="memory-processing-notice" role="status" aria-live="polite">
					<div class="memory-processing-line">
						<Spinner class="shrink-0" size={13} />
						<span>
							{processing.pendingCount > 1
								? $t("memoryProfile.processingNoticeCount", {
										count: processing.pendingCount,
									})
								: $t("memoryProfile.processingNotice")}
						</span>
					</div>
					{#if processing.operations && processing.operations.length > 0}
						<ul class="memory-processing-list">
							{#each processing.operations as operation (processingOperationKey(operation))}
								<li>
									{processingReasonLabel(operation.reason)}
									{#if operation.scope.type === "project"}
										<span> · {$t("memoryProfile.processingReasonProjectHint")}</span>
									{/if}
									{#if operation.count > 1}
										<span>
											· {$t("memoryProfile.processingReasonCount", {
												count: operation.count,
											})}
										</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</div>

		<div class="memory-profile-layout">
			<div class="memory-profile-main">
				<MemoryPortraitCard
					{profile}
					{categoryDefinitions}
					activeCount={activeItemCount}
					{summary}
					{summaryBusy}
					{pendingActionKey}
					expanded={expandedCategories}
					filterText={memoryFilterText}
					selection={memorySelection}
					onEditSummary={(text) => onEditSummary?.(text)}
					onFilterTextChange={(value) => (memoryFilterText = value)}
					onSelectionChange={(value) => (memorySelection = value)}
					onToggleCategory={handleToggleCategory}
					onEditItem={openMemoryItem}
					onRemoveItem={openRemoveForProfileItem}
				/>
			</div>

			<aside class="memory-profile-rail" aria-label={$t("memoryProfile.eyebrow")}>
				{#if profile && profile.review.openCount > 0}
					<section class="memory-review-section" aria-labelledby="memory-review-title">
						<div class="memory-review-head">
							<HelpCircle size={14} strokeWidth={2.1} class="text-accent shrink-0" aria-hidden="true" />
							<h3 id="memory-review-title" class="memory-review-title">{$t("memoryProfile.needsReview")}</h3>
							<span class="memory-review-count">{profile.review.openCount}</span>
							<span class="memory-profile-spacer"></span>
							{#if reviewOverflowCount > 0}
								<button
									type="button"
									class="memory-review-more"
									onclick={() => (reviewOverflowOpen = true)}
								>
									{$t("memoryProfile.more", { count: reviewOverflowCount })}
								</button>
							{/if}
						</div>
						<div class="memory-review-list">
							{#each visibleReviewItems as item (item.id)}
								<div class="memory-review-card">
									<div class="min-w-0 flex-1">
										{#if item.question}
											<p class="break-words text-[0.78rem] font-sans leading-[1.5] text-text-primary">{item.question}</p>
										{/if}
										<p class="break-words text-[0.68rem] font-sans leading-[1.45] text-text-muted">{item.subject}</p>
										{#if item.reason}
											<p class="memory-review-reason mt-0.5 break-words text-[0.68rem] font-sans leading-[1.45]">{item.reason}</p>
										{/if}
										{#if item.expiresAt}
											<p class="mt-0.5 break-words text-[0.68rem] font-sans leading-[1.45] text-text-muted">
												{$t("memoryProfile.autoExpiresInDays", {
													count: autoExpireDays(item.expiresAt),
												})}
											</p>
										{/if}
									</div>
									<div class="memory-card-actions flex shrink-0 items-center gap-1">
										{#if item.canAccept}
											<button
												type="button"
												class="btn-icon-bare memory-review-accept h-7 w-7 cursor-pointer rounded-full disabled:cursor-not-allowed disabled:opacity-50"
												onclick={() => useReviewItem(item)}
												disabled={pendingActionKey === actionKey(item.id, "accept")}
												aria-label={$t("memoryProfile.rememberThisItem")}
												title={$t("memoryProfile.remember")}
											>
												{#if pendingActionKey === actionKey(item.id, "accept")}
													<Spinner size={13} />
												{:else}
													<Check size={13} strokeWidth={2.1} aria-hidden="true" />
												{/if}
											</button>
										{/if}
										<button
											type="button"
											class="btn-icon-bare h-7 w-7 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
											onclick={() => openReviewEditor(item)}
											aria-label={$t("memoryProfile.editReviewItem")}
											title={$t("memoryProfile.edit")}
										>
											<Pencil size={13} strokeWidth={2.1} aria-hidden="true" />
										</button>
										<button
											type="button"
											class="btn-icon-bare memory-remove h-7 w-7 cursor-pointer rounded-full text-danger disabled:cursor-not-allowed disabled:opacity-50"
											onclick={() => openRemoveForReviewItem(item)}
											disabled={pendingActionKey === actionKey(item.id, "suppress")}
											aria-label={$t("memoryProfile.removeThisMemory")}
											title={$t("memoryProfile.removeThisMemory")}
										>
											<Trash2 size={13} strokeWidth={2.1} aria-hidden="true" />
										</button>
									</div>
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<MemoryTimeline
					reports={timelineReports}
					{pendingActionKey}
					onUndo={(reportId, actionIndex) =>
						void onUndoConsolidation?.(reportId, actionIndex)}
				/>

				<MemoryRailCards />
			</aside>
		</div>
	</section>
{/if}

{#if selectedItem && profile}
	<KnowledgeMemoryModal
		item={selectedItem}
		projectionRevision={profile.projectionRevision}
		{pendingActionKey}
		{actionError}
		onClose={() => (selectedItem = null)}
		onAction={async (payload) => {
			const success = await onAction(payload);
			if (success === false) return;
			selectedItem = null;
		}}
	/>
{/if}

{#if reviewOverflowOpen && profile}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[120] flex items-center justify-center bg-surface-overlay/65 p-4 backdrop-blur-sm"
		role="presentation"
		onclick={closeReviewOverflow}
	>
		<div
			bind:this={reviewOverflowDialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="memory-review-overflow-title"
			tabindex={-1}
			class="max-h-[88vh] w-full max-w-[720px] overflow-hidden rounded-[1rem] border border-border bg-surface-elevated shadow-2xl"
			onclick={(event) => event.stopPropagation()}
		>
			<div class="flex items-center justify-between border-b border-border px-5 py-4">
				<h3 id="memory-review-overflow-title" class="text-xl font-serif text-text-primary">{$t("memoryProfile.needsReview")}</h3>
				<button
					type="button"
					class="btn-icon-bare h-11 w-11 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
					onclick={closeReviewOverflow}
					aria-label={$t("memoryProfile.closeNeedsReview")}
					title={$t("memoryProfile.close")}
				>
					<X size={18} strokeWidth={2.1} aria-hidden="true" />
				</button>
			</div>
				<div class="max-h-[calc(88vh-80px)] overflow-y-auto px-5 py-5">
					<div class="grid gap-2">
						{#each additionalReviewItems as item (item.id)}
					<div class="memory-review-card flex items-start justify-between gap-3 bg-surface-page px-3 py-3">
								<div class="min-w-0">
									{#if item.question}
										<p class="break-words text-sm font-sans leading-[1.55] text-text-primary">{item.question}</p>
									{/if}
									<p class="break-words text-xs font-sans leading-[1.45] text-text-muted">{item.subject}</p>
									{#if item.reason}
										<p class="memory-review-reason mt-1 break-words text-xs font-sans leading-[1.45] text-text-muted">{item.reason}</p>
									{/if}
								</div>
								<div class="memory-card-actions flex shrink-0 items-center gap-1">
								{#if item.canAccept}
									<button
										type="button"
										class="btn-icon-bare btn-icon-sm memory-review-accept h-11 w-11 cursor-pointer rounded-full disabled:cursor-not-allowed disabled:opacity-50"
										onclick={() => useReviewItem(item)}
										disabled={pendingActionKey === actionKey(item.id, "accept")}
										aria-label={$t("memoryProfile.rememberThisItem")}
										title={$t("memoryProfile.remember")}
									>
										{#if pendingActionKey === actionKey(item.id, "accept")}
											<Spinner size={17} />
										{:else}
											<Check size={17} strokeWidth={2.1} aria-hidden="true" />
										{/if}
									</button>
								{/if}
								<button
									type="button"
									class="btn-icon-bare btn-icon-sm h-11 w-11 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
									onclick={() => openReviewEditor(item)}
									aria-label={$t("memoryProfile.editReviewItem")}
									title={$t("memoryProfile.edit")}
								>
									<Pencil size={17} strokeWidth={2.1} aria-hidden="true" />
								</button>
								<button
									type="button"
									class="btn-icon-bare btn-icon-sm memory-remove h-11 w-11 cursor-pointer rounded-full text-danger disabled:cursor-not-allowed disabled:opacity-50"
									onclick={() => openRemoveForReviewItem(item)}
									disabled={pendingActionKey === actionKey(item.id, "suppress")}
									aria-label={$t("memoryProfile.removeThisMemory")}
									title={$t("memoryProfile.removeThisMemory")}
								>
									<Trash2 size={17} strokeWidth={2.1} aria-hidden="true" />
								</button>
							</div>
						</div>
					{/each}
				</div>
				</div>
			</div>
		</div>
	{/if}

{#if removeTarget}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[140] flex items-center justify-center bg-surface-overlay/65 p-4 backdrop-blur-sm"
		role="presentation"
		onclick={closeRemove}
	>
		<div
			bind:this={removeDialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="memory-remove-title"
			tabindex={-1}
			class="w-full max-w-[420px] overflow-hidden rounded-[1rem] border border-border bg-surface-elevated shadow-2xl"
			onclick={(event) => event.stopPropagation()}
		>
			<div class="flex items-center justify-between border-b border-border px-4 py-3.5">
				<h3 id="memory-remove-title" class="text-sm font-sans font-semibold text-text-primary">{$t("memoryProfile.removeTitle")}</h3>
				<button
					type="button"
					class="btn-icon-bare h-9 w-9 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
					onclick={closeRemove}
					aria-label={$t("memoryProfile.close")}
					title={$t("memoryProfile.close")}
				>
					<X size={16} strokeWidth={2.1} aria-hidden="true" />
				</button>
			</div>
			<div class="memory-remove-quote border-b border-border px-4 py-3">
				<p class="break-words font-serif text-xs leading-[1.5] text-text-primary">&ldquo;{removeStatement}&rdquo;</p>
			</div>
			<p class="px-4 py-3 text-xs font-sans leading-[1.5] text-text-muted border-b border-border">{$t("memoryProfile.removeFraming")}</p>
			<div class="flex flex-col gap-1.5 p-2">
				<button
					type="button"
					class="memory-remove-option memory-remove-forget cursor-pointer rounded-[0.5rem] border border-border bg-transparent px-3 py-2.5 text-left transition hover:border-primary"
					onclick={() => confirmRemove("suppress")}
					disabled={pendingActionKey === actionKey(removeTarget.item.id, "suppress")}
				>
					<span class="flex items-center gap-2">
						<EyeOff size={14} strokeWidth={2.1} class="text-accent shrink-0" aria-hidden="true" />
						<span class="text-xs font-sans font-semibold text-text-primary">{$t("memoryProfile.forget")}</span>
					</span>
					<span class="mt-1 block pl-[22px] text-xs font-sans leading-[1.4] text-text-muted">{$t("memoryProfile.forgetDescription")}</span>
				</button>
				{#if removeTarget.kind === "profile_item" && onRetire}
					<button
						type="button"
						class="memory-remove-option memory-remove-retire cursor-pointer rounded-[0.5rem] border border-border bg-transparent px-3 py-2.5 text-left transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
						onclick={() => void confirmRetire()}
						disabled={pendingActionKey === retireKey(removeTarget.item.id)}
					>
						<span class="flex items-center gap-2">
							<Archive size={14} strokeWidth={2.1} class="text-accent shrink-0" aria-hidden="true" />
							<span class="text-xs font-sans font-semibold text-text-primary">{$t("memoryProfile.retire")}</span>
						</span>
						<span class="mt-1 block pl-[22px] text-xs font-sans leading-[1.4] text-text-muted">{$t("memoryProfile.retireDescription")}</span>
					</button>
				{/if}
				{#if removeCanDelete}
					<button
						type="button"
						class="memory-remove-option memory-remove-delete cursor-pointer rounded-[0.5rem] border bg-transparent px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50"
						style="border-color: color-mix(in srgb, var(--danger) 25%, var(--border-default) 75%);"
						onclick={() => confirmRemove("delete")}
						disabled={pendingActionKey === actionKey(removeTarget.item.id, "delete")}
					>
						<span class="flex items-center gap-2">
							<Trash2 size={14} strokeWidth={2.1} class="text-danger shrink-0" aria-hidden="true" />
							<span class="text-xs font-sans font-semibold text-danger">{$t("memoryProfile.deletePermanently")}</span>
						</span>
						<span class="mt-1 block pl-[22px] text-xs font-sans leading-[1.4] text-text-muted">{$t("memoryProfile.deletePermanentlyDescription")}</span>
					</button>
				{/if}
				<button
					type="button"
					class="memory-remove-cancel mt-0.5 cursor-pointer rounded-[0.5rem] border border-border bg-transparent px-3 py-2 text-center text-xs font-sans font-medium text-text-muted transition hover:text-text-primary"
					onclick={closeRemove}
				>
					{$t("memoryProfile.cancel")}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* ---- the page's own head row -------------------------------------- */
	.memory-profile-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.75rem;
	}

	.memory-profile-eyebrow {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.memory-profile-active {
		display: inline-flex;
		align-items: center;
		height: 1.4rem;
		padding: 0 0.5rem;
		border: 1px solid var(--border-default);
		border-radius: 9999px;
		font-family: var(--font-sans);
		font-size: 0.66rem;
		color: var(--text-muted);
	}

	.memory-profile-spacer {
		flex: 1 1 auto;
	}

	.memory-processing-notice {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		line-height: 1.4;
		color: var(--accent);
	}

	.memory-processing-line {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	.memory-processing-list {
		margin: 0 0 0 1.4rem;
		padding: 0;
		list-style: disc;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	/* ---- portrait + rail ---------------------------------------------- */
	.memory-profile-layout {
		display: flex;
		align-items: flex-start;
		gap: 1.15rem;
		min-width: 0;
	}

	.memory-profile-main {
		flex: 1 1 auto;
		min-width: 0;
	}

	.memory-profile-rail {
		display: flex;
		flex: 0 0 20rem;
		width: 20rem;
		flex-direction: column;
		gap: 0.8rem;
		min-width: 0;
	}

	@media (max-width: 1023px) {
		.memory-profile-layout {
			flex-direction: column;
		}

		.memory-profile-rail {
			flex: 1 1 auto;
			width: 100%;
		}
	}

	/* ---- needs review -------------------------------------------------- */
	.memory-review-section {
		border: 1px solid
			color-mix(in srgb, var(--accent) 28%, var(--border-default) 72%);
		border-radius: 1rem;
		background: var(--surface-elevated);
		overflow: hidden;
		box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
	}

	.memory-review-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.7rem 0.85rem 0.6rem;
	}

	.memory-review-title {
		margin: 0;
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: 0.82rem;
		font-weight: 600;
		line-height: 1.35;
	}

	.memory-review-count {
		display: inline-flex;
		align-items: center;
		height: 1.15rem;
		padding: 0 0.4rem;
		border: 1px solid
			color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		border-radius: 9999px;
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated) 92%);
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: 0.64rem;
	}

	.memory-review-more {
		color: var(--accent);
		background: none;
		border: none;
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 0.18em;
		transition: color 150ms ease;
	}

	.memory-review-more:hover {
		color: var(--accent-hover);
	}

	.memory-review-list {
		display: grid;
		gap: 1px;
		background: color-mix(in srgb, var(--border-default) 55%, transparent 45%);
	}

	.memory-review-card {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		border-left: 3px solid var(--accent);
		padding: 0.6rem 0.7rem;
		background: color-mix(in srgb, var(--accent) 5%, var(--surface-page) 95%);
	}

	:global(.dark) .memory-review-card {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page) 92%);
	}

	.memory-review-reason {
		color: var(--text-muted);
	}

	.memory-review-accept {
		background: var(--accent);
		color: var(--accent-contrast);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent 82%);
	}

	.memory-review-accept:hover {
		background: var(--accent-hover);
		color: var(--accent-contrast);
	}

	/* ---- dialogs (unchanged behaviour, kept styling) -------------------- */
	.memory-remove-quote {
		background: color-mix(in srgb, var(--surface-page) 92%, var(--accent) 8%);
	}

	.memory-profile-section {
		width: 100%;
		min-width: 0;
		max-width: 100%;
		overflow-x: hidden;
	}

	.memory-profile-section :global(*) {
		box-sizing: border-box;
	}

	@media (max-width: 640px) {
		.memory-review-card {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			gap: 0.75rem;
			width: 100%;
			min-width: 0;
		}

		.memory-card-actions {
			display: flex;
			flex-wrap: wrap;
			justify-content: flex-end;
			width: 100%;
			min-width: 0;
		}

		.memory-profile-section p,
		.memory-profile-section span,
		.memory-profile-section div {
			overflow-wrap: anywhere;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.memory-review-more {
			transition: none !important;
		}
	}
</style>

{#if editingReviewItem && profile}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[130] flex items-center justify-center bg-surface-overlay/65 p-4 backdrop-blur-sm"
		role="presentation"
		onclick={closeReviewEditor}
	>
		<div
			bind:this={reviewEditDialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="memory-review-edit-title"
			tabindex={-1}
			class="w-full max-w-[560px] rounded-[1rem] border border-border bg-surface-elevated shadow-2xl"
			onclick={(event) => event.stopPropagation()}
		>
			<div class="border-b border-border px-5 py-4">
				<h3 id="memory-review-edit-title" class="text-xl font-serif text-text-primary">{$t("memoryProfile.editReviewItem")}</h3>
			</div>
			<div class="px-5 py-5">
				<label class="block text-sm font-sans font-medium text-text-primary" for="memory-review-statement">
					{$t("memoryProfile.statement")}
				</label>
				<textarea
					bind:this={reviewEditTextarea}
					id="memory-review-statement"
					class="mt-2 min-h-32 w-full resize-y rounded-[0.75rem] border border-border bg-surface-page px-3 py-3 text-sm font-sans text-text-primary outline-none transition focus:border-primary"
					bind:value={reviewStatement}
				></textarea>
				{#if actionError}
					<div class="mt-3 rounded-[0.75rem] border border-danger bg-surface-page px-3 py-2 text-sm font-sans text-danger" role="alert">
						{actionError}
					</div>
				{/if}
				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						class="btn-icon-bare h-11 w-11 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
						onclick={closeReviewEditor}
						aria-label={$t("memoryProfile.cancelReviewEdit")}
						title={$t("memoryProfile.cancel")}
					>
						<X size={18} strokeWidth={2.1} aria-hidden="true" />
					</button>
					<button
						type="button"
						class="btn-icon h-11 w-11 cursor-pointer rounded-full bg-accent text-white disabled:cursor-not-allowed disabled:opacity-50"
						onclick={submitReviewEdit}
						disabled={reviewStatement.trim().length === 0}
						aria-label={$t("memoryProfile.saveReviewItem")}
						title={$t("memoryProfile.save")}
					>
						<Check size={18} strokeWidth={2.1} aria-hidden="true" />
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
