<script lang="ts">
import type {
	MemoryProfileActionPayload,
	MemoryProfileCategory,
	MemoryProfilePublicItem,
	MemoryProfilePublicPayload,
	MemoryProfileReviewItem,
} from "$lib/types";
import { Check, Loader, Pencil, Trash2, X } from "@lucide/svelte";
import KnowledgeMemoryModal from "./KnowledgeMemoryModal.svelte";

type CategoryDefinition = {
	category: MemoryProfileCategory;
	label: string;
	empty: string;
};

const categoryDefinitions: CategoryDefinition[] = [
	{
		category: "about_you",
		label: "About You",
		empty: "No active memories about you yet.",
	},
	{
		category: "preferences",
		label: "Preferences",
		empty: "No preferences remembered yet.",
	},
	{
		category: "goals_ongoing_work",
		label: "Goals & Ongoing Work",
		empty: "No active goals or ongoing work remembered yet.",
	},
	{
		category: "constraints_boundaries",
		label: "Constraints & Boundaries",
		empty: "No constraints or boundaries remembered yet.",
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
	) => boolean | undefined | Promise<boolean | undefined>;
} = $props();

let selectedItem = $state<MemoryProfilePublicItem | null>(null);
let reviewOverflowOpen = $state(false);
let editingReviewItem = $state<MemoryProfileReviewItem | null>(null);
let reviewStatement = $state("");
let reviewOverflowDialog = $state<HTMLElement | null>(null);
let reviewEditDialog = $state<HTMLElement | null>(null);
let reviewEditTextarea = $state<HTMLTextAreaElement | null>(null);
let reviewOverflowPreviousFocus: HTMLElement | null = null;
let reviewEditPreviousFocus: HTMLElement | null = null;

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
	profile?.review.visibleItems ?? reviewItems.slice(0, 3),
);
let reviewOverflowCount = $derived(
	Math.max(
		profile?.review.overflowCount ?? 0,
		(profile?.review.openCount ?? 0) - visibleReviewItems.length,
		reviewItems.length - visibleReviewItems.length,
	),
);

function getCategoryItems(
	category: MemoryProfileCategory,
): MemoryProfilePublicItem[] {
	return (
		profile?.categories.find((group) => group.category === category)?.items ??
		[]
	);
}

function formatScope(scope: MemoryProfilePublicItem["scope"]): string | null {
	if (scope.type === "global") return null;
	if (scope.type === "project") return "Project";
	if (scope.type === "conversation") return "Conversation";
	return "Document";
}

function actionKey(
	itemId: string,
	action: MemoryProfileActionPayload["action"],
): string {
	return `${itemId}:${action}`;
}

function submitAction(
	item: MemoryProfilePublicItem,
	action: "delete" | "suppress",
) {
	void onAction({
		target: "profile_item",
		action,
		itemId: item.id,
		expectedProjectionRevision: profile?.projectionRevision ?? 0,
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
			<div class="text-sm font-sans font-medium text-danger">Failed to load memory profile.</div>
			<p class="mt-2 text-sm font-sans leading-[1.6] text-text-secondary">{memoryLoadError}</p>
			<button
				type="button"
				class="mt-4 cursor-pointer rounded-full border border-border px-4 py-2 text-sm font-sans font-medium text-text-primary transition hover:bg-surface-elevated"
				onclick={onRetryLoadMemory}
			>
				Try again
			</button>
		</div>
	</section>
{:else}
	<section class="memory-profile-section space-y-4" aria-labelledby="memory-profile-title">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 id="memory-profile-title" class="text-2xl font-serif text-text-primary">
					Memory Profile
				</h2>
			</div>
			<span class="rounded-full border border-border bg-surface-elevated px-3 py-1 text-xs font-sans text-text-muted">
				{activeItemCount} active
			</span>
		</div>

		{#if profile && profile.review.openCount > 0}
			<div class="rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<h3 class="text-lg font-sans font-semibold text-text-primary">Needs Review</h3>
					{#if reviewOverflowCount > 0}
						<button
							type="button"
							class="cursor-pointer rounded-full border border-border px-3 py-1 text-xs font-sans text-text-secondary transition hover:bg-surface-page"
							onclick={() => (reviewOverflowOpen = true)}
						>
							+{reviewOverflowCount} more
						</button>
					{/if}
				</div>
				<div class="mt-3 grid gap-2">
					{#each visibleReviewItems as item (item.id)}
						<div class="flex items-start justify-between gap-3 rounded-[0.75rem] border border-border bg-surface-page px-3 py-3">
							<div class="min-w-0">
								<p class="break-words text-sm font-sans leading-[1.5] text-text-primary">{item.subject}</p>
								{#if item.reason}
									<div class="mt-2 inline-flex max-w-full rounded-full border border-border px-2 py-0.5 text-xs font-sans text-text-muted">
										<span class="truncate">{item.reason}</span>
									</div>
								{/if}
							</div>
							<div class="flex shrink-0 items-center gap-1">
								{#if item.canAccept}
									<button
										type="button"
										class="btn-icon-bare h-9 w-9 cursor-pointer rounded-full text-icon-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
										class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
										onclick={() => useReviewItem(item)}
										disabled={pendingActionKey === actionKey(item.id, "accept")}
										aria-label="Remember this item"
										title="Remember"
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
									class="btn-icon-bare h-9 w-9 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
									class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
									onclick={() => openReviewEditor(item)}
									aria-label="Edit review item"
									title="Edit"
								>
									<Pencil size={17} strokeWidth={2.1} aria-hidden="true" />
								</button>
								<button
									type="button"
									class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
									onclick={() =>
										onAction({
											target: "review_item",
											action: "suppress",
											itemId: item.id,
											expectedProjectionRevision: profile.projectionRevision,
										})}
									disabled={pendingActionKey === actionKey(item.id, "suppress")}
									aria-label="Do not remember review item"
									title="Do not remember"
								>
									<X size={17} strokeWidth={2.1} aria-hidden="true" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			{#each categoryDefinitions as definition (definition.category)}
				{@const items = getCategoryItems(definition.category)}
				<section class="rounded-[1rem] border border-border bg-surface-elevated px-4 py-4 shadow-sm" aria-labelledby={`memory-category-${definition.category}`}>
					<h3 id={`memory-category-${definition.category}`} class="text-lg font-sans font-semibold text-text-primary">
						{definition.label}
					</h3>
					{#if items.length === 0}
						<p class="mt-3 text-sm font-sans leading-[1.5] text-text-muted">{definition.empty}</p>
					{:else}
						<div class="mt-3 grid gap-2">
							{#each items as item (item.id)}
								{@const scopeLabel = formatScope(item.scope)}
								<div class="flex items-start justify-between gap-3 rounded-[0.75rem] border border-border bg-surface-page px-3 py-3">
									<div class="min-w-0">
										<p class="break-words text-sm font-sans leading-[1.55] text-text-primary">{item.statement}</p>
										{#if scopeLabel}
											<div class="mt-2 inline-flex rounded-full border border-border px-2 py-0.5 text-xs font-sans text-text-muted">
												{scopeLabel}
											</div>
										{/if}
									</div>
									<div class="flex shrink-0 items-center gap-1">
										{#if item.canEdit}
											<button
												type="button"
												class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
												onclick={() => (selectedItem = item)}
												aria-label="Edit memory item"
												title="Edit"
											>
												<Pencil size={17} strokeWidth={2.1} aria-hidden="true" />
											</button>
										{/if}
										{#if item.canSuppress}
											<button
												type="button"
												class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
												onclick={() => submitAction(item, "suppress")}
												disabled={pendingActionKey === actionKey(item.id, "suppress")}
												aria-label="Do not remember memory item"
												title="Do not remember"
											>
												<X size={17} strokeWidth={2.1} aria-hidden="true" />
											</button>
										{/if}
										{#if item.canDelete}
											<button
												type="button"
												class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
												onclick={() => submitAction(item, "delete")}
												disabled={pendingActionKey === actionKey(item.id, "delete")}
												aria-label="Delete memory item"
												title="Delete"
											>
												{#if pendingActionKey === actionKey(item.id, "delete")}
													<Loader size={17} strokeWidth={2.1} class="animate-spin" aria-hidden="true" />
												{:else}
													<Trash2 size={17} strokeWidth={2.1} aria-hidden="true" />
												{/if}
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
				<h3 id="memory-review-overflow-title" class="text-xl font-serif text-text-primary">Needs Review</h3>
				<button
					type="button"
					class="btn-icon-bare cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
					onclick={closeReviewOverflow}
					aria-label="Close needs review"
					title="Close"
				>
					<X size={18} strokeWidth={2.1} aria-hidden="true" />
				</button>
			</div>
			<div class="max-h-[calc(88vh-80px)] overflow-y-auto px-5 py-5">
				<div class="grid gap-2">
					{#each reviewItems as item (item.id)}
						<div class="flex items-start justify-between gap-3 rounded-[0.75rem] border border-border bg-surface-page px-3 py-3">
							<div class="min-w-0">
								<p class="break-words text-sm font-sans text-text-primary">{item.subject}</p>
								{#if item.question}
									<p class="mt-1 text-sm font-sans text-text-muted">{item.question}</p>
								{/if}
								{#if item.reason}
									<div class="mt-2 inline-flex max-w-full rounded-full border border-border px-2 py-0.5 text-xs font-sans text-text-muted">
										<span class="truncate">{item.reason}</span>
									</div>
								{/if}
							</div>
							<div class="flex shrink-0 items-center gap-1">
								{#if item.canAccept}
									<button
										type="button"
										class="btn-icon-bare h-9 w-9 cursor-pointer rounded-full text-icon-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
										class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
										onclick={() => useReviewItem(item)}
										disabled={pendingActionKey === actionKey(item.id, "accept")}
										aria-label="Remember this item"
										title="Remember"
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
									class="btn-icon-bare h-9 w-9 cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
									class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
									onclick={() => openReviewEditor(item)}
									aria-label="Edit review item"
									title="Edit"
								>
									<Pencil size={17} strokeWidth={2.1} aria-hidden="true" />
								</button>
								<button
									type="button"
									class="btn-icon-bare btn-icon-sm cursor-pointer rounded-full text-icon-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
									onclick={() =>
										onAction({
											target: "review_item",
											action: "suppress",
											itemId: item.id,
											expectedProjectionRevision: profile.projectionRevision,
										})}
									disabled={pendingActionKey === actionKey(item.id, "suppress")}
									aria-label="Do not remember review item"
									title="Do not remember"
								>
									<X size={17} strokeWidth={2.1} aria-hidden="true" />
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	</div>
{/if}

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
				<h3 id="memory-review-edit-title" class="text-xl font-serif text-text-primary">Edit review item</h3>
			</div>
			<div class="px-5 py-5">
				<label class="block text-sm font-sans font-medium text-text-primary" for="memory-review-statement">
					Statement
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
						class="btn-icon-bare cursor-pointer rounded-full text-icon-muted hover:text-text-primary"
						onclick={closeReviewEditor}
						aria-label="Cancel review edit"
						title="Cancel"
					>
						<X size={18} strokeWidth={2.1} aria-hidden="true" />
					</button>
					<button
						type="button"
						class="btn-icon cursor-pointer rounded-full bg-primary text-white disabled:cursor-not-allowed disabled:opacity-50"
						onclick={submitReviewEdit}
						disabled={reviewStatement.trim().length === 0}
						aria-label="Save review item"
						title="Save"
					>
						<Check size={18} strokeWidth={2.1} aria-hidden="true" />
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
