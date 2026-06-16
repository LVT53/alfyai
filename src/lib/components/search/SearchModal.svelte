<script lang="ts">
import { onDestroy, tick } from "svelte";
import { fade } from "svelte/transition";
import { goto } from "$app/navigation";
import { browser } from "$app/environment";
import { t, type I18nKey } from "$lib/i18n";
import {
	ChevronRight,
	ExternalLink,
	FileText,
	FileUp,
	Folder,
	Library,
	Loader,
	MessageSquare,
	NotebookText,
	Search,
	Sparkles,
	TextSearch,
	X,
} from "@lucide/svelte";
import {
	buildChatSourceMessageHref,
	buildKnowledgeWorkspaceHref,
} from "$lib/client/document-workspace-navigation";
import { fetchWorkspaceSearch } from "$lib/client/api/workspace-search";
import {
	currentConversationId,
	sidebarOpen,
	SIDEBAR_DESKTOP_BREAKPOINT,
} from "$lib/stores/ui";
import type {
	WorkspaceSearchConversationResult,
	WorkspaceSearchDocumentResult,
	WorkspaceSearchResponse,
} from "$lib/types";

type SearchRow =
	| {
			id: string;
			kind: "conversation";
			conversation: WorkspaceSearchConversationResult;
	  }
	| {
			id: string;
			kind: "document";
			document: WorkspaceSearchDocumentResult;
	  }
	| {
			id: string;
			kind: "knowledge-overflow";
	  };

type SearchSection = {
	id: "conversations" | "documents";
	titleKey: I18nKey;
	rows: SearchRow[];
};

type HighlightPart = {
	text: string;
	highlight: boolean;
};

let {
	isOpen = false,
	onClose = () => {},
}: {
	isOpen?: boolean;
	onClose?: () => void;
} = $props();

let searchQuery = $state("");
let searchResponse = $state<WorkspaceSearchResponse | null>(null);
let searchLoading = $state(false);
let searchError = $state(false);
let activeRowId = $state<string | null>(null);
let modalRef = $state<HTMLDivElement | undefined>(undefined);
let searchInputRef = $state<HTMLInputElement | undefined>(undefined);
let previousFocus: HTMLElement | null = null;
let wasOpen = false;
let latestRequestId = 0;
let lastStartedQuery: string | null = null;

const SEARCH_DEBOUNCE_MS = 180;
const focusableSelector =
	'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const trimmedSearchQuery = $derived(searchQuery.trim());
const requestedSearchQuery = $derived(
	trimmedSearchQuery.length >= 2 ? trimmedSearchQuery : "",
);
const isQueryMode = $derived((searchResponse?.mode ?? "default") === "query");
const conversationRows = $derived(
	(searchResponse?.conversations ?? []).map(
		(conversation): SearchRow => ({
			id: `conversation:${conversation.id}:${conversation.match.messageId ?? ""}`,
			kind: "conversation",
			conversation,
		}),
	),
);
const documentRows = $derived([
	...(searchResponse?.documents ?? []).map(
		(document): SearchRow => ({
			id: `document:${document.displayArtifactId}`,
			kind: "document",
			document,
		}),
	),
	...(searchResponse?.documentOverflow
		? [{ id: "knowledge-overflow", kind: "knowledge-overflow" } as SearchRow]
		: []),
]);
const searchSections = $derived(
	[
		conversationRows.length
			? {
					id: "conversations",
					titleKey: isQueryMode
						? "searchModal.conversations"
						: "searchModal.recentConversations",
					rows: conversationRows,
				}
			: null,
		documentRows.length
			? {
					id: "documents",
					titleKey: isQueryMode
						? "searchModal.documents"
						: "searchModal.recentDocuments",
					rows: documentRows,
				}
			: null,
	].filter((section): section is SearchSection => section !== null),
);
const visibleRows = $derived(searchSections.flatMap((section) => section.rows));
const hasResults = $derived(visibleRows.length > 0);
const highlightTerms = $derived(
	Array.from(
		new Set(
			(searchResponse?.query ?? "")
				.trim()
				.split(/\s+/)
				.map((term) => term.trim().toLowerCase())
				.filter(Boolean),
		),
	).sort((a, b) => b.length - a.length),
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

function isMobilePointer() {
	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
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
		if (!isMobilePointer()) {
			searchInputRef?.focus();
		}
	});

	wasOpen = true;
});

$effect(() => {
	if (!browser || !isOpen) return;

	const query = requestedSearchQuery;
	const delay = query ? SEARCH_DEBOUNCE_MS : 0;
	const timeout = window.setTimeout(() => {
		void runWorkspaceSearch(query);
	}, delay);

	return () => window.clearTimeout(timeout);
});

$effect(() => {
	if (!isOpen) return;
	if (!visibleRows.length) {
		activeRowId = null;
		return;
	}
	if (!activeRowId || !visibleRows.some((row) => row.id === activeRowId)) {
		activeRowId = visibleRows[0].id;
	}
});

async function runWorkspaceSearch(query: string) {
	if (query === lastStartedQuery && searchResponse) return;

	const requestId = ++latestRequestId;
	lastStartedQuery = query;
	searchLoading = true;
	searchError = false;

	try {
		const response = (await fetchWorkspaceSearch({
			query,
		})) as WorkspaceSearchResponse;
		if (requestId !== latestRequestId) return;
		searchResponse = {
			mode: response.mode,
			query: response.query,
			conversations: response.conversations ?? [],
			documents: response.documents ?? [],
			documentOverflow: response.documentOverflow,
			knowledgeHref: response.knowledgeHref,
		};
	} catch {
		if (requestId !== latestRequestId) return;
		searchError = true;
	} finally {
		if (requestId === latestRequestId) {
			searchLoading = false;
		}
	}
}

function handleClose() {
	searchQuery = "";
	searchLoading = false;
	searchError = false;
	activeRowId = null;
	lastStartedQuery = null;
	onClose();
	previousFocus?.focus();
	previousFocus = null;
}

function handleBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) {
		handleClose();
	}
}

function moveActiveRow(offset: number) {
	if (!visibleRows.length) return;
	const currentIndex = Math.max(
		0,
		visibleRows.findIndex((row) => row.id === activeRowId),
	);
	const nextIndex =
		(currentIndex + offset + visibleRows.length) % visibleRows.length;
	activeRowId = visibleRows[nextIndex].id;
}

function activeOrFirstRow() {
	return visibleRows.find((row) => row.id === activeRowId) ?? visibleRows[0];
}

function shouldLetFocusedButtonHandleEnter(event: KeyboardEvent) {
	return event.key === "Enter" && event.target instanceof HTMLButtonElement;
}

function handleKeydown(event: KeyboardEvent) {
	if (!isOpen) return;

	if (event.key === "Escape") {
		event.preventDefault();
		handleClose();
		return;
	}

	if (event.key === "ArrowDown") {
		event.preventDefault();
		moveActiveRow(1);
		return;
	}

	if (event.key === "ArrowUp") {
		event.preventDefault();
		moveActiveRow(-1);
		return;
	}

	if (event.key === "Enter" && !shouldLetFocusedButtonHandleEnter(event)) {
		const row = activeOrFirstRow();
		if (row) {
			event.preventDefault();
			void activateRow(row);
		}
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

async function activateRow(row: SearchRow) {
	if (row.kind === "conversation") {
		await openConversation(row.conversation);
		return;
	}
	if (row.kind === "document") {
		await openDocument(row.document);
		return;
	}
	await openKnowledge();
}

function conversationHref(conversation: WorkspaceSearchConversationResult) {
	if (conversation.match.type === "body" && conversation.match.messageId) {
		return buildChatSourceMessageHref({
			conversationId: conversation.id,
			assistantMessageId: conversation.match.messageId,
		});
	}
	return conversation.href || `/chat/${conversation.id}`;
}

async function openConversation(conversation: WorkspaceSearchConversationResult) {
	currentConversationId.set(conversation.id);
	handleClose();
	await goto(conversationHref(conversation));
	if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
		sidebarOpen.set(false);
	}
}

function documentFilename(document: WorkspaceSearchDocumentResult) {
	return document.name;
}

function documentTitle(document: WorkspaceSearchDocumentResult) {
	return document.documentLabel?.trim() || document.name;
}

async function openDocument(document: WorkspaceSearchDocumentResult) {
	handleClose();
	await goto(
		document.href ||
			buildKnowledgeWorkspaceHref({
				artifactId: document.displayArtifactId,
				filename: documentFilename(document),
				mimeType: document.mimeType,
			}),
	);
	if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
		sidebarOpen.set(false);
	}
}

function sourceConversationHref(document: WorkspaceSearchDocumentResult) {
	return document.sourceHref;
}

async function openDocumentSource(
	event: MouseEvent,
	document: WorkspaceSearchDocumentResult,
) {
	event.stopPropagation();
	const href = sourceConversationHref(document);
	if (!href) return;
	handleClose();
	await goto(href);
}

async function openKnowledge() {
	handleClose();
	await goto(searchResponse?.knowledgeHref || "/knowledge");
	if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
		sidebarOpen.set(false);
	}
}

function conversationMeta(conversation: WorkspaceSearchConversationResult) {
	if (conversation.match.type === "body") {
		return $t("searchModal.messageMatch");
	}
	return conversation.projectName?.trim() || "";
}

function documentBadgeKey(document: WorkspaceSearchDocumentResult) {
	if (document.documentOrigin === "generated")
		return "searchModal.badgeGenerated";
	if (document.documentOrigin === "skill_note")
		return "searchModal.badgeSkillNote";
	return "searchModal.badgeUploaded";
}

function highlightParts(value: string | null | undefined): HighlightPart[] {
	const text = value ?? "";
	if (!text || highlightTerms.length === 0) {
		return [{ text, highlight: false }];
	}

	const lowerText = text.toLowerCase();
	const parts: HighlightPart[] = [];
	let index = 0;

	while (index < text.length) {
		let nextIndex = -1;
		let nextTerm = "";

		for (const term of highlightTerms) {
			const matchIndex = lowerText.indexOf(term, index);
			if (
				matchIndex !== -1 &&
				(nextIndex === -1 ||
					matchIndex < nextIndex ||
					(matchIndex === nextIndex && term.length > nextTerm.length))
			) {
				nextIndex = matchIndex;
				nextTerm = term;
			}
		}

		if (nextIndex === -1) {
			parts.push({ text: text.slice(index), highlight: false });
			break;
		}

		if (nextIndex > index) {
			parts.push({ text: text.slice(index, nextIndex), highlight: false });
		}

		const endIndex = nextIndex + nextTerm.length;
		parts.push({ text: text.slice(nextIndex, endIndex), highlight: true });
		index = endIndex;
	}

	return parts.length ? parts : [{ text, highlight: false }];
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
			class="search-portal-modal w-full max-w-[680px] overflow-hidden rounded-lg border"
		>
			<div class="search-modal-header border-b px-4 py-3">
				<div class="flex items-center justify-between gap-3">
					<h2 id="search-dialog-title" class="text-[15px] font-sans font-semibold text-text-primary">
						{$t('searchModal.title')}
					</h2>
					<button
						type="button"
						class="search-modal-icon-button btn-icon-bare h-8 w-8 rounded-md text-icon-muted hover:text-icon-primary"
						onclick={handleClose}
						aria-label={$t('searchModal.close')}
					>
						<X size={16} strokeWidth={2.1} aria-hidden="true" />
					</button>
				</div>
			</div>

			<div class="search-modal-input-band border-b px-4 py-3">
				<div class="search-input-wrapper flex items-center gap-2.5 rounded-lg border px-3 py-2">
					<Search size={16} strokeWidth={2.1} class="shrink-0 text-icon-muted" aria-hidden="true" />
					<input
						bind:this={searchInputRef}
						bind:value={searchQuery}
						type="text"
						aria-label={$t('searchModal.placeholder')}
						placeholder={$t('searchModal.placeholder')}
						class="h-8 w-full bg-transparent text-[14px] font-sans text-text-primary outline-none placeholder:text-text-muted"
					/>
					{#if searchLoading}
						<Loader class="animate-spin text-icon-muted" size={15} strokeWidth={2} aria-hidden="true" />
					{:else if searchQuery}
						<button
							type="button"
							class="search-modal-icon-button btn-icon-bare h-7 w-7 rounded-md text-icon-muted hover:text-icon-primary"
							onclick={() => (searchQuery = '')}
							aria-label={$t('searchModal.clear')}
						>
							<X size={14} strokeWidth={2.1} aria-hidden="true" />
						</button>
					{/if}
				</div>
			</div>

			<div class="max-h-[420px] overflow-y-auto px-3 py-2.5">
				{#if searchLoading && !hasResults}
					<div class="flex flex-col items-center justify-center px-4 py-12 text-center">
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<Loader class="animate-spin" size={17} strokeWidth={2} aria-hidden="true" />
						</div>
						<h3 class="text-[13px] font-sans text-text-primary">{$t('searchModal.loading')}</h3>
					</div>
				{:else if searchError && !hasResults}
					<div class="flex flex-col items-center justify-center px-4 py-12 text-center">
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<Search size={17} strokeWidth={2} class="text-icon-muted" aria-hidden="true" />
						</div>
						<h3 class="text-[13px] font-sans text-text-primary">{$t('searchModal.error')}</h3>
					</div>
				{:else if !hasResults}
					<div class="flex flex-col items-center justify-center px-4 py-12 text-center">
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<Search size={17} strokeWidth={2} class="text-icon-muted" aria-hidden="true" />
						</div>
						<h3 class="text-[13px] font-sans text-text-primary">{$t('searchModal.noMatches')}</h3>
						<p class="mt-1 text-[12px] font-sans text-text-muted">
							{$t('searchModal.noMatchesHint')}
						</p>
					</div>
				{:else}
					<div class="space-y-3">
						{#if searchError}
							<div class="search-status-row rounded-md px-2.5 py-2 text-[12px] font-sans text-text-muted">
								{$t('searchModal.error')}
							</div>
						{/if}

						{#each searchSections as section (section.id)}
							<section class="space-y-1.5">
								<div class="px-2 text-[10px] font-sans font-medium uppercase tracking-[0.12em] text-text-muted">
									{$t(section.titleKey)}
								</div>
								<div class="space-y-0.5">
									{#each section.rows as row (row.id)}
										{#if row.kind === 'conversation'}
											<div
												class="search-result-shell rounded-lg"
												class:active={row.id === activeRowId}
												onpointerenter={() => (activeRowId = row.id)}
											>
												<button
													type="button"
													class="search-result-item flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
													onclick={() => openConversation(row.conversation)}
												>
													<div class="search-result-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
														{#if row.conversation.match.type === 'body'}
															<TextSearch size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else}
															<MessageSquare size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{/if}
													</div>
													<div class="min-w-0 flex-1">
														<div class="flex min-w-0 items-center gap-2">
															<div class="truncate text-[13px] font-sans font-medium text-text-primary">
																{#each highlightParts(row.conversation.title) as part}
																	<span class:search-highlight={part.highlight}>{part.text}</span>
																{/each}
															</div>
															{#if row.conversation.id === $currentConversationId}
																<span class="search-badge search-badge-accent shrink-0">{$t('searchModal.badgeCurrent')}</span>
															{/if}
														</div>
														{#if conversationMeta(row.conversation)}
															<div class="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-sans text-text-muted">
																{#if row.conversation.match.type === 'project'}
																	<Folder size={11} strokeWidth={2} class="shrink-0" aria-hidden="true" />
																{/if}
																<span class="truncate">{conversationMeta(row.conversation)}</span>
															</div>
														{/if}
														{#if row.conversation.match.snippet}
															<p class="mt-1 line-clamp-2 text-[12px] font-sans leading-5 text-text-muted">
																{#each highlightParts(row.conversation.match.snippet) as part}
																	<span class:search-highlight={part.highlight}>{part.text}</span>
																{/each}
															</p>
														{/if}
													</div>
													<ChevronRight size={14} strokeWidth={2.1} class="shrink-0 text-icon-muted" aria-hidden="true" />
												</button>
											</div>
										{:else if row.kind === 'document'}
											<div
												class="search-result-shell search-result-document flex items-stretch rounded-lg"
												class:active={row.id === activeRowId}
												onpointerenter={() => (activeRowId = row.id)}
											>
												<button
													type="button"
													class="search-result-item flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
													onclick={() => openDocument(row.document)}
												>
													<div class="search-result-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
														{#if row.document.documentOrigin === 'generated'}
															<Sparkles size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.documentOrigin === 'skill_note'}
															<NotebookText size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.documentOrigin === 'uploaded'}
															<FileUp size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else}
															<FileText size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{/if}
													</div>
													<div class="min-w-0 flex-1">
														<div class="flex min-w-0 items-center gap-2">
															<div class="truncate text-[13px] font-sans font-medium text-text-primary">
																{#each highlightParts(documentTitle(row.document)) as part}
																	<span class:search-highlight={part.highlight}>{part.text}</span>
																{/each}
															</div>
															<span class="search-badge shrink-0">{$t(documentBadgeKey(row.document))}</span>
															{#if row.document.documentFamilyStatus === 'historical'}
																<span class="search-badge shrink-0">{$t('searchModal.badgeHistorical')}</span>
															{/if}
														</div>
														{#if row.document.name && row.document.name !== documentTitle(row.document)}
															<div class="mt-0.5 truncate text-[11px] font-sans text-text-muted">
																{#each highlightParts(row.document.name) as part}
																	<span class:search-highlight={part.highlight}>{part.text}</span>
																{/each}
															</div>
														{/if}
														{#if row.document.match.snippet}
															<p class="mt-1 line-clamp-2 text-[12px] font-sans leading-5 text-text-muted">
																{#each highlightParts(row.document.match.snippet) as part}
																	<span class:search-highlight={part.highlight}>{part.text}</span>
																{/each}
															</p>
														{/if}
													</div>
													<ChevronRight size={14} strokeWidth={2.1} class="shrink-0 text-icon-muted" aria-hidden="true" />
												</button>
												{#if sourceConversationHref(row.document)}
													<button
														type="button"
														class="search-source-button btn-icon-bare my-1.5 mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-icon-muted hover:text-icon-primary"
														onclick={(event) => openDocumentSource(event, row.document)}
														aria-label={$t('searchModal.openSourceChat')}
														title={$t('searchModal.openSourceChat')}
													>
														<ExternalLink size={14} strokeWidth={2.1} aria-hidden="true" />
													</button>
												{/if}
											</div>
										{:else}
											<div
												class="search-result-shell rounded-lg"
												class:active={row.id === activeRowId}
												onpointerenter={() => (activeRowId = row.id)}
											>
												<button
													type="button"
													class="search-result-item flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
													onclick={openKnowledge}
												>
													<div class="search-result-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
														<Library size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
													</div>
													<div class="min-w-0 flex-1 truncate text-[13px] font-sans font-medium text-text-primary">
														{$t('searchModal.viewAllDocuments')}
													</div>
													<ChevronRight size={14} strokeWidth={2.1} class="shrink-0 text-icon-muted" aria-hidden="true" />
												</button>
											</div>
										{/if}
									{/each}
								</div>
							</section>
						{/each}
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
		align-items: center;
		justify-content: center;
	}

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

	.search-modal-icon-button,
	.search-source-button {
		cursor: pointer;
		transition:
			background-color 150ms ease,
			color 150ms ease,
			transform 150ms ease;
	}

	.search-modal-icon-button:hover,
	.search-modal-icon-button:focus-visible,
	.search-source-button:hover,
	.search-source-button:focus-visible {
		background: color-mix(in srgb, var(--surface-elevated) 72%, transparent 28%);
		transform: translateY(-1px);
		outline: none;
	}

	.search-status-row {
		background: color-mix(in srgb, var(--surface-elevated) 64%, transparent 36%);
	}

	.search-result-shell {
		border: 1px solid transparent;
		transition:
			background-color 150ms ease,
			border-color 150ms ease,
			transform 150ms ease;
	}

	.search-result-item {
		line-height: 1.15;
	}

	.search-result-icon {
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
	}

	.search-result-shell:hover,
	.search-result-shell.active,
	.search-result-shell:focus-within {
		border-color: var(--border-subtle);
		background: color-mix(in srgb, var(--surface-elevated) 70%, var(--surface-page) 30%);
		transform: translateY(-1px);
	}

	.search-result-shell.active {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated) 92%);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	:global(.dark) .search-result-shell:hover,
	:global(.dark) .search-result-shell.active,
	:global(.dark) .search-result-shell:focus-within {
		background: color-mix(in srgb, var(--surface-overlay) 60%, var(--surface-elevated) 40%);
		border-color: color-mix(in srgb, var(--border-default) 60%, transparent 40%);
	}

	:global(.dark) .search-result-shell.active {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-overlay) 88%);
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-default) 60%);
	}

	:global(.dark) .search-result-icon {
		background: color-mix(in srgb, var(--surface-overlay) 70%, #050505 30%);
	}

	.search-badge {
		display: inline-flex;
		align-items: center;
		min-height: 18px;
		border-radius: 999px;
		padding: 0 7px;
		background: color-mix(in srgb, var(--surface-elevated) 78%, transparent 22%);
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 10px;
		font-weight: 600;
		line-height: 1;
	}

	.search-badge-accent {
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--accent);
	}

	.search-highlight {
		border-radius: 3px;
		background: color-mix(in srgb, var(--accent) 14%, transparent 86%);
		color: var(--text-primary);
		font-weight: 700;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.search-portal-backdrop),
		.search-result-shell,
		.search-modal-icon-button,
		.search-source-button {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
