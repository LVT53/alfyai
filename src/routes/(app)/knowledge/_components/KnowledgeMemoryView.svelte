<script lang="ts">
import type {
	MemoryProfileActionPayload,
	MemoryProfileCategory,
	MemoryProfilePublicItem,
	MemoryProfilePublicItemDetail,
	MemoryProfilePublicPayload,
	MemoryProfileReviewItem,
	MemoryTimelineReport,
} from "$lib/types";
import { t, type I18nKey } from "$lib/i18n";
import { fetchMemoryProfileItemDetail } from "$lib/client/api/knowledge";
import {
	Archive,
	Check,
	Eye,
	EyeOff,
	Loader,
	Pencil,
	Trash2,
	X,
} from "@lucide/svelte";
import KnowledgeMemoryModal from "./KnowledgeMemoryModal.svelte";
import MemoryTimeline from "./MemoryTimeline.svelte";
import PersonaSummaryCard from "./PersonaSummaryCard.svelte";

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
	processing?: { active: boolean; pendingCount: number } | null;
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

let activeItemCount = $derived.by(() =>
	(profile?.categories ?? []).reduce(
		(total, group) => total + group.items.length,
		0,
	),
);
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

function getCategoryItems(
	category: MemoryProfileCategory,
): MemoryProfilePublicItem[] {
	return (
		profile?.categories.find((group) => group.category === category)?.items ??
		[]
	);
}

function formatExpiryDate(expiresAt: string): string {
	const parsed = Date.parse(expiresAt);
	if (!Number.isFinite(parsed)) return expiresAt;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		parsed,
	);
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

function formatScope(scope: MemoryProfilePublicItem["scope"]): string | null {
	if (scope.type === "global") return null;
	if (scope.type === "project") return $t("memoryProfile.projectScope");
	if (scope.type === "conversation")
		return $t("memoryProfile.conversationScope");
	return $t("memoryProfile.documentScope");
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
	<section class="memory-profile-section space-y-4" aria-labelledby="memory-profile-title">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 id="memory-profile-title" class="text-2xl font-serif text-text-primary">
					{$t("memory.title")}
				</h2>
			</div>
			<span class="rounded-full border border-border bg-surface-elevated px-3 py-1 text-xs font-sans text-text-muted">
				{$t("memoryProfile.activeCount", { count: activeItemCount })}
			</span>
		</div>

		{#if processing?.active}
			<div
				class="memory-processing-notice flex items-center gap-2 rounded-[0.75rem] border px-3 py-2"
				role="status"
				aria-live="polite"
			>
				<Loader size={15} strokeWidth={2.1} class="shrink-0 animate-spin" aria-hidden="true" />
				<span class="text-xs font-sans leading-[1.4]">
					{processing.pendingCount > 1
						? $t("memoryProfile.processingNoticeCount", {
								count: processing.pendingCount,
							})
						: $t("memoryProfile.processingNotice")}
				</span>
			</div>
		{/if}

		<PersonaSummaryCard
			{summary}
			busy={summaryBusy}
			hasFacts={activeItemCount > 0}
			onEdit={(text) => onEditSummary?.(text)}
		/>

		<div class="grid gap-4 lg:grid-cols-2">
			{#each categoryDefinitions as definition (definition.category)}
				{@const items = getCategoryItems(definition.category)}
				<section class="memory-category-card rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm" aria-labelledby={`memory-category-${definition.category}`}>
					<h3 id={`memory-category-${definition.category}`} class="text-lg font-sans font-semibold text-text-primary">
						{$t(definition.label)}
					</h3>
					{#if items.length === 0}
						<p class="mt-3 text-sm font-sans leading-[1.5] text-text-muted">{$t(definition.empty)}</p>
						<p class="memory-empty-hint mt-2 text-xs font-sans leading-[1.5] text-text-muted">
							{$t("memoryProfile.emptyHint")}
							<a
								href="/settings?section=memory"
								class="memory-empty-hint-link text-accent underline underline-offset-2 hover:text-accent-hover"
							>
								{$t("memoryProfile.emptyHintLink")}
							</a>
						</p>
					{:else}
						<div class={`mt-3 grid gap-2 ${items.length > 4 ? "max-h-[356px] overflow-y-auto pr-1" : ""}`}>
							{#each items as item (item.id)}
								{@const scopeLabel = formatScope(item.scope)}
								<div class="memory-item-card flex items-start justify-between gap-3 rounded-[0.75rem] border border-border bg-surface-page px-3 py-3">
									<div class="min-w-0">
										<p class="break-words text-sm font-sans leading-[1.55] text-text-primary">
											{#if item.confidence}
												<span
													class={`memory-confidence-dot ${item.confidence === "stated" ? "memory-confidence-dot--stated" : "memory-confidence-dot--inferred"}`}
													role="img"
													aria-label={item.confidence === "stated"
														? $t("memoryProfile.confidenceStated")
														: $t("memoryProfile.confidenceInferred")}
													title={item.confidence === "stated"
														? $t("memoryProfile.confidenceStated")
														: $t("memoryProfile.confidenceInferred")}
												></span>
											{/if}
											{item.statement}
										</p>
										{#if scopeLabel || item.expiresAt}
											<div class="mt-2 flex flex-wrap items-center gap-1.5">
												{#if scopeLabel}
													<span class="inline-flex rounded-full border border-border px-2 py-0.5 text-xs font-sans text-text-muted">
														{scopeLabel}
													</span>
												{/if}
												{#if item.expiresAt}
													<span class="memory-expiry-chip inline-flex rounded-full px-2 py-0.5 text-xs font-sans">
														{$t("memoryProfile.expiresOn", {
															date: formatExpiryDate(item.expiresAt),
														})}
													</span>
												{/if}
											</div>
										{/if}
									</div>
									<div class="memory-card-actions flex shrink-0 items-center gap-1">
										<button
											type="button"
											class="btn-icon-bare btn-icon-sm h-11 w-11 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
											onclick={() => openMemoryItem(item)}
											aria-label={item.canEdit
												? $t("memoryProfile.editMemoryItem")
												: $t("memoryProfile.itemTitle")}
											title={item.canEdit
												? $t("memoryProfile.edit")
												: $t("memoryProfile.itemTitle")}
										>
											{#if item.canEdit}
												<Pencil size={17} strokeWidth={2.1} aria-hidden="true" />
											{:else}
												<Eye size={17} strokeWidth={2.1} aria-hidden="true" />
											{/if}
										</button>
										{#if item.canSuppress || item.canDelete}
											<button
												type="button"
												class="btn-icon-bare btn-icon-sm memory-remove h-11 w-11 cursor-pointer rounded-full text-danger disabled:cursor-not-allowed disabled:opacity-50"
												onclick={() => openRemoveForProfileItem(item)}
												disabled={pendingActionKey === actionKey(item.id, "suppress") || pendingActionKey === actionKey(item.id, "delete")}
												aria-label={$t("memoryProfile.removeThisMemory")}
												title={$t("memoryProfile.removeThisMemory")}
											>
												<Trash2 size={17} strokeWidth={2.1} aria-hidden="true" />
											</button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			{/each}
		</div>

		<MemoryTimeline
			reports={timelineReports}
			{pendingActionKey}
			onUndo={(reportId, actionIndex) =>
				void onUndoConsolidation?.(reportId, actionIndex)}
		/>

		{#if profile && profile.review.openCount > 0}
			<section class="memory-review-section" aria-labelledby="memory-review-title">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex items-center gap-2">
						<h3 id="memory-review-title" class="memory-review-title font-sans font-semibold">{$t("memoryProfile.needsReview")}</h3>
						<span class="memory-review-count rounded-full px-2 py-0.5 text-xs font-sans">
							{profile.review.openCount}
						</span>
					</div>
					{#if reviewOverflowCount > 0}
						<button
							type="button"
							class="memory-review-more cursor-pointer text-xs font-sans font-medium transition"
							onclick={() => (reviewOverflowOpen = true)}
						>
							{$t("memoryProfile.more", { count: reviewOverflowCount })}
						</button>
					{/if}
				</div>
				<div class="mt-3 grid gap-2">
					{#each visibleReviewItems as item (item.id)}
						<div class="memory-review-card flex items-start justify-between gap-3 rounded-[0.75rem] border border-border bg-surface-page px-3 py-3">
							<div class="min-w-0">
								{#if item.question}
									<p class="break-words text-sm font-sans leading-[1.55] text-text-primary">{item.question}</p>
								{/if}
								<p class="break-words text-xs font-sans leading-[1.45] text-text-muted">{item.subject}</p>
								{#if item.reason}
									<p class="memory-review-reason mt-1 break-words text-xs font-sans leading-[1.45] text-text-muted">{item.reason}</p>
								{/if}
								{#if item.expiresAt}
									<p class="mt-1 break-words text-xs font-sans leading-[1.45] text-text-muted">
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
										class="btn-icon-bare btn-icon-sm memory-review-accept h-11 w-11 cursor-pointer rounded-full disabled:cursor-not-allowed disabled:opacity-50"
										onclick={() => useReviewItem(item)}
										disabled={pendingActionKey === actionKey(item.id, "accept")}
										aria-label={$t("memoryProfile.rememberThisItem")}
										title={$t("memoryProfile.remember")}
									>
										{#if pendingActionKey === actionKey(item.id, "accept")}
											<Loader size={17} strokeWidth={2.1} class="animate-spin" aria-hidden="true" />
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
			</section>
		{/if}
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
											<Loader size={17} strokeWidth={2.1} class="animate-spin" aria-hidden="true" />
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
	.memory-processing-notice {
		border-color: color-mix(in srgb, var(--accent) 28%, var(--border-default) 72%);
		background: color-mix(in srgb, var(--accent) 6%, var(--surface-elevated) 94%);
		color: var(--accent);
	}

	.memory-review-title {
		color: var(--accent);
		font-size: var(--text-base);
		line-height: 1.35;
	}

	.memory-review-count {
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated) 92%);
		color: var(--accent);
	}

	.memory-review-more {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}

	.memory-review-more:hover {
		color: var(--accent-hover);
	}

	.memory-review-card {
		border-left: 3px solid var(--accent);
		border-radius: 0;
		background: color-mix(in srgb, var(--accent) 5%, var(--surface-page) 95%);
	}

	:global(.dark) .memory-review-card {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page) 92%);
	}

	.memory-review-reason {
		color: var(--text-muted);
	}

	.memory-remove-quote {
		background: color-mix(in srgb, var(--surface-page) 92%, var(--accent) 8%);
	}

	/* Confidence dot: filled = the user stated the fact directly, hollow =
	   AlfyAI inferred it from conversation. */
	.memory-confidence-dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		margin-right: 0.35rem;
		border-radius: 9999px;
		vertical-align: 0.08em;
	}

	.memory-confidence-dot--stated {
		background: var(--accent);
	}

	.memory-confidence-dot--inferred {
		background: transparent;
		border: 1.5px solid var(--accent);
	}

	.memory-expiry-chip {
		border: 1px solid
			color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 6%, transparent 94%);
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
		.memory-profile-section > :global(.grid) {
			grid-template-columns: minmax(0, 1fr);
		}

		.memory-review-section,
		.memory-category-card {
			width: 100%;
			min-width: 0;
			max-width: 100%;
			overflow-x: hidden;
		}

		.memory-review-card,
		.memory-item-card {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			gap: 0.75rem;
			width: 100%;
			min-width: 0;
			max-width: 100%;
			overflow-x: hidden;
		}

		.memory-review-card > div,
		.memory-item-card > div {
			min-width: 0;
			max-width: 100%;
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
						class="btn-icon h-11 w-11 cursor-pointer rounded-full bg-primary text-white disabled:cursor-not-allowed disabled:opacity-50"
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
