<script lang="ts">
import { onDestroy, tick, untrack } from "svelte";
import { fade } from "svelte/transition";
import { goto } from "$app/navigation";
import { browser } from "$app/environment";
import { t, type I18nKey } from "$lib/i18n";
import { conversationDisplayTitle } from "$lib/shared/conversation-title";
import {
	matchRanges,
	SEARCH_MIN_QUERY_CHARS,
	searchTerms,
} from "$lib/shared/workspace-search-text";
import { getFocusableElements } from "$lib/utils/focus-trap";
import { formatAgo } from "$lib/utils/time";
import { isTouchDevice } from "$lib/utils/viewport.svelte";
import { chordsAreDrawn } from "$lib/components/artifacts/document/keyboard-shortcuts";
import { videoDurationLabel } from "$lib/components/artifacts/video/video-card-view";
import { reducedMotionAware } from "$lib/utils/motion";
import {
	AppWindow,
	BookOpen,
	Brain,
	ChevronRight,
	ExternalLink,
	FileText,
	FileUp,
	Film,
	Folder,
	Image,
	LayoutDashboard,
	MessageSquare,
	NotebookPen,
	Play,
	Presentation,
	Search,
	SquarePen,
	TextSearch,
	X,
} from "@lucide/svelte";
import Spinner from "../ui/Spinner.svelte";
import {
	buildChatSourceMessageHref,
	buildKnowledgeWorkspaceHref,
} from "$lib/client/document-workspace-navigation";
import { fetchWorkspaceSearch } from "$lib/client/api/workspace-search";
import {
	buildSearchScopeChips,
	formatScopeCount,
	resolveActiveScope,
	rowMatchesScope,
	type SearchScopeId,
	summariseTotals,
} from "./search-scopes";
import {
	currentConversationId,
	sidebarOpen,
	SIDEBAR_DESKTOP_BREAKPOINT,
} from "$lib/stores/ui";
import type {
	WorkspaceSearchBadge,
	WorkspaceSearchConversationResult,
	WorkspaceSearchDocumentResult,
	WorkspaceSearchKind,
	WorkspaceSearchMemoryResult,
	WorkspaceSearchResponse,
} from "$lib/server/services/workspace-search/types";

// prefers-reduced-motion: the CSS reset in app.css cannot reach this
// JS-driven transition (see motion.ts), so wrap it explicitly.
const backdropFade = reducedMotionAware(fade);

type SearchRow =
	| {
			id: string;
			kind: "conversation";
			conversation: WorkspaceSearchConversationResult;
	  }
	| {
			id: string;
			kind: "memory";
			memory: WorkspaceSearchMemoryResult;
	  }
	| {
			id: string;
			kind: "document";
			document: WorkspaceSearchDocumentResult;
	  };

type SearchSection = {
	kind: WorkspaceSearchKind;
	titleKey: I18nKey;
	rows: SearchRow[];
	/** The kind's true count when "Show all" would show more than this section does. */
	showAllTotal: number | null;
	/** Another page of this kind can be loaded. */
	canLoadMore: boolean;
};

const SCOPE_LABEL_KEYS: Record<SearchScopeId, I18nKey> = {
	all: "searchModal.scopeAll",
	chats: "searchModal.scopeConversations",
	memory: "searchModal.scopeMemory",
	documents: "searchModal.scopeDocuments",
	media: "searchModal.scopeMedia",
	apps: "searchModal.scopeApps",
};

// "Show all 12 chats": the link names what it opens, for a screen reader too.
const SHOW_ALL_KEYS: Record<WorkspaceSearchKind, I18nKey> = {
	chats: "searchModal.showAllChats",
	memory: "searchModal.showAllMemory",
	documents: "searchModal.showAllDocuments",
	media: "searchModal.showAllMedia",
	apps: "searchModal.showAllApps",
};

// A picture, a video, a Document, Slides, a Canvas and an App say their kind in
// the app's own words (`artifacts.type.*`); only the file kinds have words here.
const BADGE_KEYS: Record<WorkspaceSearchBadge, I18nKey> = {
	document: "artifacts.type.document",
	slides: "artifacts.type.slides",
	canvas: "artifacts.type.canvas",
	app: "artifacts.type.app",
	image: "artifacts.type.image",
	video: "artifacts.type.video",
	uploaded: "searchModal.badgeUploaded",
	generated: "searchModal.badgeGenerated",
	report: "searchModal.badgeReport",
	skill_note: "searchModal.badgeSkillNote",
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
// The answer for the chosen scope, with every page loaded so far appended.
let searchResponse = $state<WorkspaceSearchResponse | null>(null);
let searchLoading = $state(false);
let loadingMore = $state(false);
let searchError = $state(false);
let activeRowId = $state<string | null>(null);
// The chip the user picked. What is actually applied is `activeScope` below,
// which falls back to All when the pick has nothing in it any more.
let requestedScope = $state<SearchScopeId>("all");
let modalRef = $state<HTMLDivElement | undefined>(undefined);
let searchInputRef = $state<HTMLInputElement | undefined>(undefined);
let previousFocus: HTMLElement | null = null;
let wasOpen = false;
let latestRequestId = 0;
let lastStartedKey: string | null = null;
// Rows whose thumbnail failed to load: they keep their kind's icon tile.
let failedPreviews = $state<Record<string, true>>({});
// The request of the query on screen; a query typed over cancels the one before.
let searchAbort: AbortController | null = null;

const SEARCH_DEBOUNCE_MS = 180;

const trimmedSearchQuery = $derived(searchQuery.trim());
const requestedSearchQuery = $derived(
	trimmedSearchQuery.length >= SEARCH_MIN_QUERY_CHARS ? trimmedSearchQuery : "",
);
const isQueryMode = $derived((searchResponse?.mode ?? "default") === "query");
const totals = $derived(
	searchResponse?.totals ?? {
		chats: 0,
		memory: 0,
		documents: 0,
		media: 0,
		apps: 0,
	},
);
const scopeChips = $derived(
	buildSearchScopeChips(totals, searchResponse?.memorySearchable ?? false),
);
const activeScope = $derived(resolveActiveScope(requestedScope, scopeChips));

const conversationRows = $derived(
	(searchResponse?.conversations ?? []).map(
		(conversation): SearchRow => ({
			id: `conversation:${conversation.id}:${conversation.match.messageId ?? ""}`,
			kind: "conversation",
			conversation,
		}),
	),
);
const memoryRows = $derived(
	(searchResponse?.memories ?? []).map(
		(memory): SearchRow => ({
			id: `memory:${memory.id}`,
			kind: "memory",
			memory,
		}),
	),
);
const documentRows = $derived(
	(searchResponse?.documents ?? []).map(
		(document): SearchRow => ({
			id: `document:${document.displayArtifactId}`,
			kind: "document",
			document,
		}),
	),
);

/** What the scope logic needs to know about a row, and nothing more. */
function toScopeableRow(row: SearchRow) {
	return {
		id: row.id,
		kind: row.kind,
		searchKind: row.kind === "document" ? row.document.searchKind : undefined,
	};
}

function rowsInScope(rows: SearchRow[]): SearchRow[] {
	return rows.filter((row) =>
		rowMatchesScope(toScopeableRow(row), activeScope),
	);
}

const searchSections = $derived.by<SearchSection[]>(() => {
	const response = searchResponse;
	if (!response) return [];
	const loadedForScope =
		activeScope !== "all" &&
		response.scope === activeScope &&
		response.nextCursor !== null;
	function buildSection(
		kind: WorkspaceSearchKind,
		titleKey: I18nKey,
		rows: SearchRow[],
	): SearchSection | null {
		const shown = rowsInScope(rows);
		if (!shown.length) return null;
		return {
			kind,
			titleKey,
			rows: shown,
			showAllTotal:
				isQueryMode && activeScope === "all" && totals[kind] > shown.length
					? totals[kind]
					: null,
			canLoadMore: loadedForScope && activeScope === kind,
		};
	}
	const ofKind = (kind: "documents" | "media" | "apps") =>
		documentRows.filter(
			(row) => row.kind === "document" && row.document.searchKind === kind,
		);
	if (!isQueryMode) {
		// Before anything is typed: the newest chats and the newest documents of any kind.
		return [
			buildSection(
				"chats",
				"searchModal.recentConversations",
				conversationRows,
			),
			activeScope === "all"
				? buildSection("documents", "searchModal.recentDocuments", documentRows)
				: null,
			...(activeScope === "all"
				? []
				: [
						buildSection(
							"documents",
							"searchModal.scopeDocuments",
							ofKind("documents"),
						),
						buildSection("media", "searchModal.scopeMedia", ofKind("media")),
						buildSection("apps", "searchModal.scopeApps", ofKind("apps")),
					]),
		].filter((entry): entry is SearchSection => entry !== null);
	}
	return [
		buildSection("chats", "searchModal.scopeConversations", conversationRows),
		buildSection("memory", "searchModal.scopeMemory", memoryRows),
		buildSection(
			"documents",
			"searchModal.scopeDocuments",
			ofKind("documents"),
		),
		buildSection("media", "searchModal.scopeMedia", ofKind("media")),
		buildSection("apps", "searchModal.scopeApps", ofKind("apps")),
	].filter((entry): entry is SearchSection => entry !== null);
});
const visibleRows = $derived(searchSections.flatMap((entry) => entry.rows));
const hasResults = $derived(visibleRows.length > 0);
const resultSummary = $derived(summariseTotals(totals));
const activeResultElementId = $derived(
	activeRowId ? searchResultElementId(activeRowId) : undefined,
);
// The words of the query, folded the way the server matched them, so a word typed
// without accents or in another order is lit in the text it found. The view
// before a query matched nothing, so it lights nothing.
const highlightTerms = $derived(
	isQueryMode ? searchTerms(searchResponse?.query ?? "") : [],
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
	return isTouchDevice();
}

function searchResultElementId(rowId: string) {
	return `workspace-search-result-${rowId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
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
			return;
		}
		modalRef?.focus();
	});

	wasOpen = true;
});

$effect(() => {
	if (!browser || !isOpen) return;

	const query = requestedSearchQuery;
	const delay = query ? SEARCH_DEBOUNCE_MS : 0;
	const timeout = window.setTimeout(() => {
		void runWorkspaceSearch(
			query,
			untrack(() => requestedScope),
		);
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

/**
 * The results pane scrolls, so arrowing past the fold has to bring the row
 * with it — otherwise ↓ moves a highlight the reader cannot see, and ↵ opens
 * something that was never on screen. `nearest` keeps the list still while
 * the active row is already visible.
 */
function scrollActiveRowIntoView() {
	if (!browser || !activeRowId) return;
	const row = document.getElementById(searchResultElementId(activeRowId));
	// jsdom (and any other host without a layout engine) has no
	// scrollIntoView; keeping a row on screen is never worth throwing over.
	if (typeof row?.scrollIntoView !== "function") return;
	row.scrollIntoView({ block: "nearest" });
}

/** The chip row scrolls sideways on a phone: the chosen chip is brought into view. */
function scrollChipIntoView(id: SearchScopeId) {
	if (!browser) return;
	const chip = modalRef?.querySelector<HTMLElement>(
		`[data-testid="search-scope-${id}"]`,
	);
	if (typeof chip?.scrollIntoView !== "function") return;
	chip.scrollIntoView({ inline: "nearest", block: "nearest" });
}

async function runWorkspaceSearch(query: string, scope: SearchScopeId) {
	// Before anything is typed there is one view; a chip only narrows it.
	const kind = query ? scope : "all";
	const key = `${query}|${kind}`;
	if (key === lastStartedKey && searchResponse) return;

	const requestId = ++latestRequestId;
	lastStartedKey = key;
	searchLoading = true;
	loadingMore = false;
	searchError = false;
	// The server's work for a query typed over is wasted: cancel its request.
	searchAbort?.abort();
	const controller = new AbortController();
	searchAbort = controller;

	try {
		const response = (await fetchWorkspaceSearch({
			query,
			...(kind === "all" ? {} : { scope: kind }),
			signal: controller.signal,
		})) as WorkspaceSearchResponse;
		if (requestId !== latestRequestId) return;
		searchResponse = {
			...response,
			conversations: response.conversations ?? [],
			memories: response.memories ?? [],
			documents: response.documents ?? [],
			totals: response.totals ?? totals,
			memorySearchable: response.memorySearchable ?? false,
			nextCursor: response.nextCursor ?? null,
		};
		// A kind with nothing for this query is no longer a chip worth being on.
		if (kind !== "all" && searchResponse.totals[kind] === 0) {
			requestedScope = "all";
			lastStartedKey = null;
			void runWorkspaceSearch(query, "all");
		}
	} catch {
		if (requestId !== latestRequestId) return;
		searchError = true;
	} finally {
		if (requestId === latestRequestId) {
			searchLoading = false;
		}
		if (searchAbort === controller) searchAbort = null;
	}
}

/** A later page's rows that are not shown yet: a row that moved between pages appears once. */
function appendNew<T>(
	shown: readonly T[],
	next: readonly T[],
	keyOf: (row: T) => string,
): T[] {
	const seen = new Set(shown.map(keyOf));
	return [...shown, ...next.filter((row) => !seen.has(keyOf(row)))];
}

/**
 * The next page of the chosen kind, appended after the ones already shown. It
 * asks with the shown answer's query, not the box's: a click inside the
 * debounce must not append a page of a query that is not on screen.
 */
async function loadMore() {
	const current = searchResponse;
	if (!current?.nextCursor || loadingMore || activeScope === "all") return;
	const requestId = latestRequestId;
	loadingMore = true;
	try {
		const page = (await fetchWorkspaceSearch({
			query: current.query,
			scope: activeScope,
			cursor: current.nextCursor,
		})) as WorkspaceSearchResponse;
		if (requestId !== latestRequestId) return;
		searchResponse = {
			...current,
			conversations: appendNew(
				current.conversations,
				page.conversations ?? [],
				(row) => row.id,
			),
			memories: appendNew(
				current.memories,
				page.memories ?? [],
				(row) => row.id,
			),
			documents: appendNew(
				current.documents,
				page.documents ?? [],
				(row) => row.displayArtifactId,
			),
			totals: page.totals ?? current.totals,
			nextCursor: page.nextCursor ?? null,
		};
	} catch {
		if (requestId === latestRequestId) searchError = true;
	} finally {
		if (requestId === latestRequestId) loadingMore = false;
		keepFocusInDialog();
	}
}

/**
 * Show all and the last Load more go away once used; the focus they held
 * would fall to the page. It goes back to the search box (or the dialog, on a
 * touch screen, where focusing the box would open the keyboard).
 */
function keepFocusInDialog() {
	void tick().then(() => {
		const active = document.activeElement;
		if (active && active !== document.body && modalRef?.contains(active)) {
			return;
		}
		if (isMobilePointer()) modalRef?.focus();
		else searchInputRef?.focus();
	});
}

function selectScope(id: SearchScopeId) {
	if (
		id !== "all" &&
		!scopeChips.some((chip) => chip.id === id && chip.count > 0)
	) {
		return;
	}
	requestedScope = id;
	void tick().then(() => scrollChipIntoView(id));
	// Before anything is typed the chip only narrows the recents; with a query it
	// asks the server for that kind's page.
	if (isQueryMode) void runWorkspaceSearch(requestedSearchQuery, id);
}

function handleClose() {
	latestRequestId += 1;
	searchAbort?.abort();
	searchAbort = null;
	// A thumbnail that failed on a network blip is tried again at the next open.
	failedPreviews = {};
	searchQuery = "";
	searchResponse = null;
	searchLoading = false;
	loadingMore = false;
	searchError = false;
	activeRowId = null;
	lastStartedKey = null;
	requestedScope = "all";
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
	void tick().then(scrollActiveRowIntoView);
}

function activeOrFirstRow() {
	return visibleRows.find((row) => row.id === activeRowId) ?? visibleRows[0];
}

// The legend of keys at the foot is not drawn where the primary pointer is a
// finger (FB-9): the modal opens on the reader's action, so the pointer is known.
const showsKeyLegend = chordsAreDrawn();

// ⌘ on a Mac, Ctrl everywhere else — the same detection the sidebar's ⌘K
// chip uses. Computed once; the platform does not change mid-session.
const newTabModifierLabel = (() => {
	if (!browser) return "Ctrl";
	const nav = navigator as Navigator & {
		userAgentData?: { platform?: string };
	};
	const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
	return /mac/i.test(platform) ? "⌘" : "Ctrl";
})();

// A focused button owns a plain Enter — that is how the close and clear
// buttons work. It does not own ⌘↵: the browser would fire the button's own
// click and navigate in THIS tab, which is the opposite of what was asked for.
function shouldLetFocusedButtonHandleEnter(event: KeyboardEvent) {
	if (event.metaKey || event.ctrlKey) return false;
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
			if (event.metaKey || event.ctrlKey) {
				openRowInNewTab(row);
			} else {
				void activateRow(row);
			}
		}
		return;
	}

	if (event.key === "Tab") {
		// The rendered-only filtering and canonical selector are shared with
		// every other migrated trap (src/lib/utils/focus-trap.ts); the wrap
		// decision below stays local because it differs from the shared
		// trapTabKey in one deliberate way — Tab/Shift+Tab starting from
		// OUTSIDE the modal goes to the element in the direction of travel
		// (Shift+Tab -> last, Tab -> first), not always to the first element.
		const focusableElements = getFocusableElements(modalRef);
		if (focusableElements.length === 0) return;

		const firstElement = focusableElements[0];
		const lastElement = focusableElements[focusableElements.length - 1];
		const activeElement = document.activeElement;

		if (
			activeElement instanceof HTMLElement &&
			modalRef &&
			!modalRef.contains(activeElement)
		) {
			event.preventDefault();
			(event.shiftKey ? lastElement : firstElement).focus();
			return;
		}

		if (event.shiftKey && activeElement === firstElement) {
			event.preventDefault();
			lastElement.focus();
		} else if (!event.shiftKey && activeElement === lastElement) {
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
	if (row.kind === "memory") {
		await openMemory(row.memory);
		return;
	}
	await openDocument(row.document);
}

/** Where a row goes — the same destination Enter would navigate to. */
function rowHref(row: SearchRow): string {
	if (row.kind === "conversation") return conversationHref(row.conversation);
	if (row.kind === "memory") return row.memory.href;
	return (
		row.document.href ||
		buildKnowledgeWorkspaceHref({
			artifactId: row.document.displayArtifactId,
			filename: documentFilename(row.document),
			mimeType: row.document.mimeType,
		})
	);
}

/**
 * ⌘↵ / Ctrl+↵ opens the active row in a new tab and LEAVES the palette open,
 * because opening several results in turn is the only reason to want a new
 * tab in the first place.
 */
function openRowInNewTab(row: SearchRow) {
	if (!browser) return;
	window.open(rowHref(row), "_blank", "noopener,noreferrer");
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

async function openConversation(
	conversation: WorkspaceSearchConversationResult,
) {
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

async function openMemory(memory: WorkspaceSearchMemoryResult) {
	handleClose();
	await goto(memory.href);
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

function conversationMeta(conversation: WorkspaceSearchConversationResult) {
	if (conversation.match.type === "body") {
		return $t("searchModal.messageMatch");
	}
	return conversation.projectName?.trim() || "";
}

/** A row's thumbnail, unless it failed to load. */
function shownPreview(row: SearchRow) {
	if (row.kind !== "document" || failedPreviews[row.id]) return null;
	return row.document.preview;
}

/** "Personal", or the project's name, then when it was last said (when it has a date). */
function memoryMeta(memory: WorkspaceSearchMemoryResult) {
	const scope =
		memory.scope.kind === "personal"
			? $t("memoryNew.personal")
			: memory.projectName?.trim() || $t("memoryNew.project");
	const ago = memory.lastSaidAt ? formatAgo(memory.lastSaidAt, { t: $t }) : "";
	return ago
		? { scope, said: $t("searchModal.memorySaid", { ago }) }
		: { scope, said: "" };
}

function highlightParts(value: string | null | undefined): HighlightPart[] {
	const text = value ?? "";
	const ranges = matchRanges(text, highlightTerms);
	if (!text || ranges.length === 0) {
		return [{ text, highlight: false }];
	}

	const parts: HighlightPart[] = [];
	let index = 0;
	for (const range of ranges) {
		if (range.start > index) {
			parts.push({ text: text.slice(index, range.start), highlight: false });
		}
		parts.push({ text: text.slice(range.start, range.end), highlight: true });
		index = range.end;
	}
	if (index < text.length) {
		parts.push({ text: text.slice(index), highlight: false });
	}
	return parts;
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
		transition:backdropFade={{ duration: 150 }}
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
						class="search-modal-icon-button btn-icon-bare btn-icon-sm rounded-md text-icon-muted hover:text-icon-primary"
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
						aria-label={$t('searchModal.inputLabel')}
						aria-activedescendant={activeResultElementId}
						aria-controls="workspace-search-results"
						placeholder={$t('searchModal.placeholder')}
						class="h-8 w-full bg-transparent text-[14px] font-sans text-text-primary outline-none placeholder:text-text-muted"
					/>
					{#if searchLoading}
						<Spinner class="text-icon-muted" size={15} />
					{:else if searchQuery}
						<button
							type="button"
							class="search-modal-icon-button btn-icon-bare btn-icon-sm rounded-md text-icon-muted hover:text-icon-primary"
							onclick={() => (searchQuery = '')}
							aria-label={$t('searchModal.clear')}
						>
							<X size={14} strokeWidth={2.1} aria-hidden="true" />
						</button>
					{/if}
				</div>
			</div>

			<div class="search-scope-band border-b px-4 py-2" role="group" aria-label={$t('searchModal.scopeLabel')}>
				<div class="search-scope-row">
					{#each scopeChips as chip (chip.id)}
						<!-- Counts only for a query: the view before one shows a few recents
							 of each kind, not a count, and a kind with nothing in it says so. -->
						<button
							type="button"
							class="search-scope-chip"
							class:active={activeScope === chip.id}
							aria-pressed={activeScope === chip.id}
							aria-disabled={chip.id !== 'all' && chip.count === 0 ? 'true' : undefined}
							aria-label={isQueryMode
								? $t('searchModal.scopeCountLabel', {
										name: $t(SCOPE_LABEL_KEYS[chip.id]),
										count: formatScopeCount(chip.count),
									})
								: $t(SCOPE_LABEL_KEYS[chip.id])}
							data-testid={`search-scope-${chip.id}`}
							onclick={() => selectScope(chip.id)}
						>
							<span>{$t(SCOPE_LABEL_KEYS[chip.id])}</span>
							{#if isQueryMode && (chip.id !== 'all' || chip.count > 0)}
								<span class="search-scope-count">{formatScopeCount(chip.count)}</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>

			<div id="workspace-search-results" class="max-h-[420px] overflow-y-auto px-3 py-2.5">
				{#if trimmedSearchQuery.length > 0 && trimmedSearchQuery.length < SEARCH_MIN_QUERY_CHARS}
					<div
						data-testid="search-keep-typing"
						class="flex flex-col items-center justify-center px-4 py-12 text-center"
					>
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<Search size={17} strokeWidth={2} class="text-icon-muted" aria-hidden="true" />
						</div>
						<h3 class="text-[13px] font-sans text-text-primary">{$t('searchModal.keepTyping')}</h3>
					</div>
				{:else if searchLoading && !hasResults}
					<div class="flex flex-col items-center justify-center px-4 py-12 text-center">
						<div class="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-elevated">
							<Spinner size={17} />
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

						{#each searchSections as section (section.kind)}
							<section class="space-y-1.5" data-testid={`search-section-${section.kind}`}>
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
													id={searchResultElementId(row.id)}
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
																{#each highlightParts(conversationDisplayTitle(row.conversation.title, $t('chat.untitledConversation'))) as part}
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
										{:else if row.kind === 'memory'}
											{@const meta = memoryMeta(row.memory)}
											<div
												class="search-result-shell search-result-memory rounded-lg"
												class:active={row.id === activeRowId}
												onpointerenter={() => (activeRowId = row.id)}
											>
												<button
													id={searchResultElementId(row.id)}
													type="button"
													class="search-result-item flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
													onclick={() => openMemory(row.memory)}
												>
													<div class="search-result-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
														<Brain size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
													</div>
													<div class="min-w-0 flex-1">
														<p class="line-clamp-2 text-[13px] font-sans font-medium leading-5 text-text-primary">
															{#each highlightParts(row.memory.text) as part}
																<span class:search-highlight={part.highlight}>{part.text}</span>
															{/each}
														</p>
														<div class="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-sans text-text-muted">
															<span class="truncate">{meta.scope}</span>
															{#if meta.said}
																<span aria-hidden="true">·</span>
																<span class="shrink-0">{meta.said}</span>
															{/if}
														</div>
													</div>
													<ChevronRight size={14} strokeWidth={2.1} class="shrink-0 text-icon-muted" aria-hidden="true" />
												</button>
											</div>
										{:else}
											<div
												class="search-result-shell search-result-document flex items-stretch rounded-lg"
												class:active={row.id === activeRowId}
												onpointerenter={() => (activeRowId = row.id)}
											>
												<button
													id={searchResultElementId(row.id)}
													type="button"
													class="search-result-item flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
													onclick={() => openDocument(row.document)}
												>
													<div
														class="search-result-icon flex shrink-0 items-center justify-center rounded-md"
														class:h-8={!shownPreview(row)}
														class:w-8={!shownPreview(row)}
														class:search-result-thumb={Boolean(shownPreview(row))}
													>
														{#if row.document.preview && shownPreview(row)}
															<img
																onerror={() => (failedPreviews = { ...failedPreviews, [row.id]: true })}
																src={row.document.preview.src}
																alt=""
																width={row.document.preview.width ?? undefined}
																height={row.document.preview.height ?? undefined}
																loading="lazy"
																decoding="async"
																class="search-thumb"
															/>
															{#if row.document.badge === 'video'}
																<Play size={16} strokeWidth={2.4} class="search-thumb-play" fill="currentColor" aria-hidden="true" />
																{#if row.document.durationMs}
																	<span class="search-thumb-duration">{videoDurationLabel(row.document.durationMs)}</span>
																{/if}
															{/if}
														{:else if row.document.badge === 'app'}
															<AppWindow size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'canvas'}
															<LayoutDashboard size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'image'}
															<Image size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'video'}
															<Film size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'slides'}
															<Presentation size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'document'}
															<SquarePen size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'report'}
															<BookOpen size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'skill_note'}
															<NotebookPen size={15} strokeWidth={2.1} class="text-icon-muted" aria-hidden="true" />
														{:else if row.document.badge === 'uploaded'}
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
															<span class="search-badge shrink-0">{$t(BADGE_KEYS[row.document.badge])}</span>
															{#if row.document.documentFamilyStatus === 'historical'}
																<span class="search-badge shrink-0">{$t('searchModal.badgeHistorical')}</span>
															{/if}
														</div>
														{#if row.document.originConversationTitle}
															<div class="mt-0.5 truncate text-[11px] font-sans text-text-muted">
																{$t('searchModal.madeIn', {
																	chat: conversationDisplayTitle(row.document.originConversationTitle, $t('chat.untitledConversation')),
																})}
															</div>
														{/if}
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
														class="search-source-button btn-icon-bare btn-icon-sm my-1.5 mr-1.5 flex shrink-0 items-center justify-center rounded-md text-icon-muted hover:text-icon-primary"
														onclick={(event) => openDocumentSource(event, row.document)}
														aria-label={$t('searchModal.openSourceChat')}
														title={$t('searchModal.openSourceChat')}
													>
														<ExternalLink size={14} strokeWidth={2.1} aria-hidden="true" />
													</button>
												{/if}
											</div>
										{/if}
									{/each}
								</div>
								{#if section.showAllTotal !== null}
									<button
										type="button"
										class="search-section-link"
										onclick={() => {
											selectScope(section.kind);
											keepFocusInDialog();
										}}
									>
										<span>{$t(SHOW_ALL_KEYS[section.kind], { count: formatScopeCount(section.showAllTotal) })}</span>
										<ChevronRight size={13} strokeWidth={2.2} aria-hidden="true" />
									</button>
								{/if}
								{#if section.canLoadMore}
									<button
										type="button"
										class="search-section-link"
										disabled={loadingMore}
										onclick={loadMore}
									>
										{#if loadingMore}<Spinner size={13} />{/if}
										<span>{$t('searchModal.loadMore')}</span>
									</button>
								{/if}
							</section>
						{/each}
					</div>
				{/if}
			</div>

			<!-- The legend of keys is not drawn on a touch screen (FB-9); the result count stays. -->
			{#if showsKeyLegend || (isQueryMode && hasResults)}
			<div class="search-modal-footer border-t px-4 py-2" aria-label={showsKeyLegend ? $t('searchModal.keyboardHelp') : undefined}>
				{#if showsKeyLegend}
				<span class="search-key-hint">
					<kbd class="search-kbd">&uarr;</kbd><kbd class="search-kbd">&darr;</kbd>
					{$t('searchModal.keyMove')}
				</span>
				<span class="search-key-hint">
					<kbd class="search-kbd">&crarr;</kbd>
					{$t('searchModal.keyOpen')}
				</span>
				{#if !(isQueryMode && hasResults)}
					<span class="search-key-hint">
						<kbd class="search-kbd">{newTabModifierLabel}</kbd><kbd class="search-kbd">&crarr;</kbd>
						{$t('searchModal.keyNewTab')}
					</span>
				{/if}
				<span class="search-key-hint">
					<kbd class="search-kbd">esc</kbd>
					{$t('searchModal.keyClose')}
				</span>
				{/if}
				{#if isQueryMode && hasResults}
					<!-- A kind counted to the cap makes the sum a floor: it reads 99+, as the chips do. -->
					<span class="search-result-count" data-testid="search-result-count">
						{resultSummary.results === 1
							? $t('searchModal.resultSummaryOne')
							: $t(
									resultSummary.kinds === 1
										? 'searchModal.resultSummaryOneKind'
										: 'searchModal.resultSummary',
									{
										results: resultSummary.capped
											? formatScopeCount(resultSummary.results)
											: resultSummary.results,
										kinds: resultSummary.kinds,
									},
								)}
					</span>
				{/if}
			</div>
			{/if}
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
	.search-modal-input-band,
	.search-scope-band,
	.search-modal-footer {
		border-color: color-mix(in srgb, var(--border-default) 72%, transparent 28%);
	}

	.search-scope-band {
		background: color-mix(in srgb, var(--surface-page) 30%, transparent 70%);
	}

	.search-scope-row {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.375rem;
		overflow-x: auto;
		scrollbar-width: none;
		-webkit-overflow-scrolling: touch;
	}

	.search-scope-row::-webkit-scrollbar {
		display: none;
	}

	.search-scope-chip {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		height: 1.6rem;
		padding: 0 0.55rem;
		border: 1px solid
			color-mix(in srgb, var(--border-default) 80%, transparent 20%);
		border-radius: 9999px;
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 11px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.search-scope-chip:hover,
	.search-scope-chip:focus-visible {
		border-color: var(--accent);
		color: var(--accent);
	}

	.search-scope-chip.active {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--border-default) 60%);
		background: color-mix(in srgb, var(--accent) 12%, transparent 88%);
		color: var(--accent);
	}

	.search-scope-count {
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
	}

	.search-modal-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		background: color-mix(in srgb, var(--surface-page) 30%, transparent 70%);
		font-family: var(--font-sans);
		font-size: 11px;
		color: var(--text-muted);
	}

	.search-key-hint {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.search-kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.15rem;
		height: 1.15rem;
		padding: 0 0.25rem;
		border: 1px solid
			color-mix(in srgb, var(--border-default) 80%, transparent 20%);
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--surface-elevated) 70%, transparent 30%);
		font-family: var(--font-sans);
		font-size: 10px;
		line-height: 1;
	}

	.search-result-count {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
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
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			box-shadow var(--duration-standard) var(--ease-out);
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
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
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
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
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

	/* A picture's or a video's thumbnail: 48 px, cropped to a square, with a
	   clip's play mark and length over it. */
	.search-result-thumb {
		position: relative;
		width: 3rem;
		height: 3rem;
		overflow: hidden;
	}

	.search-thumb {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	:global(.search-thumb-play) {
		position: absolute;
		inset: 0;
		margin: auto;
		color: #fff;
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55));
	}

	.search-thumb-duration {
		position: absolute;
		right: 3px;
		bottom: 3px;
		padding: 1px 4px;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.66);
		color: #fff;
		font-family: var(--font-sans);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}

	/* "Show all N" and "Load more" at the foot of a section. */
	.search-section-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: 2.5rem;
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		background: transparent;
		color: var(--accent);
		font-family: var(--font-sans);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.search-section-link:hover,
	.search-section-link:focus-visible {
		background: color-mix(in srgb, var(--accent) 10%, transparent 90%);
		outline: none;
	}

	.search-section-link:disabled {
		cursor: default;
		opacity: 0.6;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.search-portal-backdrop),
		.search-result-shell,
		.search-modal-icon-button,
		.search-source-button,
		.search-scope-chip,
		.search-section-link {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
