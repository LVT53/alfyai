<script lang="ts">
import { onDestroy, tick } from "svelte";
import { get } from "svelte/store";
import { fade } from "svelte/transition";
import { goto } from "$app/navigation";
import { browser } from "$app/environment";
import { t } from "$lib/i18n";
import { conversations, loadConversations } from "$lib/stores/conversations";
import { projects } from "$lib/stores/projects";
import {
	currentConversationId,
	sidebarOpen,
	SIDEBAR_DESKTOP_BREAKPOINT,
} from "$lib/stores/ui";

let {
	isOpen = false,
	onClose = () => {},
}: {
	isOpen?: boolean;
	onClose?: () => void;
} = $props();

let searchQuery = $state("");
let conversationLoading = $state(false);
let modalRef = $state<HTMLDivElement | undefined>(undefined);
let searchInputRef = $state<HTMLInputElement | undefined>(undefined);
let previousFocus: HTMLElement | null = null;
let wasOpen = false;

const focusableSelector =
	'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const trimmedSearchQuery = $derived(searchQuery.trim());
const normalizedSearchQuery = $derived(trimmedSearchQuery.toLowerCase());
const searchableConversations = $derived($conversations);
const projectsMap = $derived(
	Object.fromEntries($projects.map((project) => [project.id, project.name])),
);
const conversationResults = $derived(
	normalizedSearchQuery
		? searchableConversations.filter((conversation) =>
				conversation.title.toLowerCase().includes(normalizedSearchQuery),
			)
		: searchableConversations.slice(0, 6),
);

function portal(node: HTMLElement) {
	document.body.appendChild(node);
	document.body.style.overflow = "hidden";

	return {
		destroy() {
			if (node.parentNode) {
				node.parentNode.removeChild(node);
			}
			document.body.style.overflow = "";
		},
	};
}

$effect(() => {
	if (!browser || !isOpen || wasOpen) {
		wasOpen = isOpen;
		return;
	}

	previousFocus =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;

	void tick().then(() => {
		const isMobile = window.matchMedia(
			"(hover: none) and (pointer: coarse)",
		).matches;
		if (!isMobile) {
			searchInputRef?.focus();
		}
	});

	if (get(conversations).length === 0) {
		conversationLoading = true;
		void loadConversations().finally(() => {
			conversationLoading = false;
		});
	}

	wasOpen = true;
});

function handleClose() {
	searchQuery = "";
	conversationLoading = false;
	onClose();
	previousFocus?.focus();
	previousFocus = null;
}

function handleBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) {
		handleClose();
	}
}

function handleKeydown(event: KeyboardEvent) {
	if (!isOpen) return;

	if (event.key === "Escape") {
		event.preventDefault();
		handleClose();
		return;
	}

	if (event.key === "Tab") {
		const focusableElements =
			modalRef?.querySelectorAll<HTMLElement>(focusableSelector);
		if (!focusableElements || focusableElements.length === 0) return;

		const firstElement = focusableElements[0];
		const lastElement = focusableElements[focusableElements.length - 1];

		if (event.shiftKey && document.activeElement === firstElement) {
			event.preventDefault();
			lastElement.focus();
		} else if (!event.shiftKey && document.activeElement === lastElement) {
			event.preventDefault();
			firstElement.focus();
		}
	}
}

async function handleSelection(id: string) {
	currentConversationId.set(id);
	handleClose();
	await goto(`/chat/${id}`);
	if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
		sidebarOpen.set(false);
	}
}

onDestroy(() => {
	if (browser && document.body.style.overflow === "hidden") {
		document.body.style.overflow = "";
	}
});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		use:portal
		class="search-portal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4"
		onclick={handleBackdropClick}
		transition:fade={{ duration: 150 }}
	>
		<div
			bind:this={modalRef}
			role="dialog"
			aria-modal="true"
			aria-labelledby="search-dialog-title"
			tabindex="-1"
			class="search-portal-modal w-full max-w-[640px] overflow-hidden rounded-lg border"
		>
			<div class="search-modal-header border-b px-4 py-3">
				<div class="flex items-center justify-between gap-3">
					<div class="flex items-center gap-2.5">
						<h2 id="search-dialog-title" class="text-[15px] font-sans font-semibold text-text-primary">
							{$t('searchModal.title')}
						</h2>
					</div>
					<button
						type="button"
						class="search-modal-icon-button btn-icon-bare h-8 w-8 rounded-md text-icon-muted hover:text-icon-primary"
						onclick={handleClose}
						aria-label={$t('searchModal.close')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" x2="6" y1="6" y2="18"></line>
							<line x1="6" x2="18" y1="6" y2="18"></line>
						</svg>
					</button>
				</div>
			</div>

			<div class="search-modal-input-band border-b px-4 py-3">
				<div class="search-input-wrapper flex items-center gap-2.5 rounded-lg border px-3 py-2">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-icon-muted">
						<circle cx="11" cy="11" r="7"></circle>
						<path d="m20 20-3.5-3.5"></path>
					</svg>
					<input
						bind:this={searchInputRef}
						bind:value={searchQuery}
						type="text"
						placeholder={$t('searchModal.placeholder')}
						class="h-8 w-full bg-transparent text-[14px] font-sans text-text-primary outline-none placeholder:text-text-muted"
					/>
					{#if searchQuery}
						<button
							type="button"
							class="search-modal-icon-button btn-icon-bare h-7 w-7 rounded-md text-icon-muted hover:text-icon-primary"
							onclick={() => (searchQuery = '')}
							aria-label={$t('searchModal.clear')}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
								<line x1="18" x2="6" y1="6" y2="18"></line>
								<line x1="6" x2="18" y1="6" y2="18"></line>
							</svg>
						</button>
					{/if}
				</div>
			</div>

			<div class="max-h-[380px] overflow-y-auto px-3 py-2.5">
				{#if conversationLoading}
					<div class="flex flex-col items-center justify-center px-4 py-12 text-center">
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-icon-muted">
								<circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12" stroke-linecap="round"></circle>
							</svg>
						</div>
						<h3 class="text-[13px] font-sans text-text-primary">{$t('searchModal.loading')}</h3>
					</div>
				{:else if conversationResults.length === 0}
					<div class="flex flex-col items-center justify-center px-4 py-12 text-center">
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-icon-muted">
								<circle cx="11" cy="11" r="7"></circle>
								<path d="m20 20-3.5-3.5"></path>
							</svg>
						</div>
						<h3 class="text-[13px] font-sans text-text-primary">{$t('searchModal.noMatches')}</h3>
						<p class="mt-1 text-[12px] font-sans text-text-muted">
							{$t('searchModal.noMatchesHint')}
						</p>
					</div>
				{:else}
					<div class="space-y-3">
						{#if conversationResults.length > 0}
							<section class="space-y-1.5">
								<div class="px-2 text-[10px] font-sans font-medium uppercase tracking-[0.12em] text-text-muted">
									{$t(trimmedSearchQuery ? 'searchModal.conversations' : 'searchModal.recentConversations')}
								</div>
								<div class="space-y-0.5">
									{#each conversationResults as conversation (conversation.id)}
										<button
											type="button"
											class="search-result-item flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-elevated"
											class:active={conversation.id === $currentConversationId}
											onclick={() => handleSelection(conversation.id)}
										>
											<div class="search-result-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
												<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="text-icon-muted">
													<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
												</svg>
											</div>
											<div class="min-w-0 flex-1">
												<div class="truncate text-[13px] font-sans font-medium text-text-primary">
													{conversation.title}
												</div>
												{#if conversation.id === $currentConversationId}
													<div class="mt-0.5 text-[11px] font-sans text-accent">{$t('searchModal.currentConversation')}</div>
												{:else if conversation.projectId && projectsMap[conversation.projectId]}
													<div class="mt-0.5 flex items-center gap-1 text-[11px] font-sans text-text-muted">
														<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">
															<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
														</svg>
														{projectsMap[conversation.projectId]}
													</div>
												{/if}
											</div>
											<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-icon-muted">
												<path d="m9 18 6-6-6-6"></path>
											</svg>
										</button>
									{/each}
								</div>
							</section>
						{/if}
					</div>
				{/if}
			</div>

		</div>
	</div>
{/if}

<style>
	.search-portal-backdrop {
		background: color-mix(in srgb, var(--surface-page) 80%, transparent 20%);
		backdrop-filter: blur(8px);
		/* Mobile: ensure proper centering when viewport changes (keyboard open, etc.) */
		align-items: center;
		justify-content: center;
	}

	/* Mobile-specific backdrop fixes for virtual keyboard scenarios */
	@media (max-width: 767px) {
		:global(.search-portal-backdrop) {
			padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
		}
	}

	:global(.dark) .search-portal-backdrop {
		background: color-mix(in srgb, var(--surface-page) 85%, transparent 15%);
	}

	.search-portal-modal {
		background: color-mix(in srgb, var(--surface-overlay) 92%, #0b0b0b 8%);
		border-color: color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		box-shadow:
			0 18px 40px rgba(0, 0, 0, 0.24),
			0 0 0 1px color-mix(in srgb, var(--border-default) 54%, transparent 46%);
		/* Mobile: prevent modal from exceeding viewport height and ensure centering */
		max-height: 90dvh;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	:global(.dark) .search-portal-modal {
		background: color-mix(in srgb, var(--surface-overlay) 80%, #050505 20%);
		border-color: color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		box-shadow:
			0 22px 44px rgba(0, 0, 0, 0.52),
			0 0 0 1px color-mix(in srgb, var(--border-default) 38%, transparent 62%);
	}

	.search-modal-header,
	.search-modal-input-band {
		border-color: color-mix(in srgb, var(--border-default) 72%, transparent 28%);
	}

	/* Mobile-specific centering fix: ensure modal stays centered when viewport changes */
	@media (max-width: 767px) {
		.search-portal-modal {
			max-height: 85dvh;
		}
	}

	.search-input-wrapper {
		background: color-mix(in srgb, var(--surface-page) 86%, var(--surface-elevated) 14%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		transition:
			border-color 150ms ease,
			background-color 150ms ease,
			box-shadow 150ms ease;
	}

	.search-input-wrapper:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent 85%);
	}

	:global(.dark) .search-input-wrapper {
		background: color-mix(in srgb, var(--surface-overlay) 78%, #050505 22%);
		border-color: color-mix(in srgb, var(--border-default) 76%, transparent 24%);
	}

	:global(.dark) .search-input-wrapper:focus-within {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent 80%);
	}

	.search-modal-icon-button {
		cursor: pointer;
		transition:
			background-color 150ms ease,
			color 150ms ease,
			transform 150ms ease;
	}

	.search-modal-icon-button:hover,
	.search-modal-icon-button:focus-visible {
		background: color-mix(in srgb, var(--surface-elevated) 72%, transparent 28%);
		transform: translateY(-1px);
		outline: none;
	}

	.search-result-item {
		border: 1px solid transparent;
		line-height: 1.15;
		transition:
			background-color 150ms ease,
			border-color 150ms ease,
			transform 150ms ease;
	}

	.search-result-icon {
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
	}

	.search-result-item:hover {
		border-color: var(--border-subtle);
		background: color-mix(in srgb, var(--surface-elevated) 70%, var(--surface-page) 30%);
		transform: translateY(-1px);
	}

	:global(.dark) .search-result-item:hover {
		background: color-mix(in srgb, var(--surface-overlay) 60%, var(--surface-elevated) 40%);
		border-color: color-mix(in srgb, var(--border-default) 60%, transparent 40%);
	}

	:global(.dark) .search-result-icon {
		background: color-mix(in srgb, var(--surface-overlay) 70%, #050505 30%);
	}

	.search-result-item.active {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated) 92%);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	:global(.dark) .search-result-item.active {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-overlay) 88%);
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-default) 60%);
	}

	/* Animation for backdrop */
	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	/* Reduced motion support */
	@media (prefers-reduced-motion: reduce) {
		:global(.search-portal-backdrop) {
			animation: none !important;
		}
	}
</style>
