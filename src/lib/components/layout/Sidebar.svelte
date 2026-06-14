<script lang="ts">
import { onMount } from "svelte";
import { browser } from "$app/environment";
import { logout } from "$lib/client/api/auth";
import { clearClientAccountState } from "$lib/client/session-boundary";
import { t } from "$lib/i18n";
import {
	sidebarOpen,
	sidebarCollapsed,
	sidebarWidth,
	clampSidebarWidth,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_DESKTOP_BREAKPOINT,
	currentConversationId,
} from "$lib/stores/ui";
import { goto, invalidateAll } from "$app/navigation";
import { navigating } from "$app/stores";
import { fade } from "svelte/transition";
import { markPreviousConversationId } from "$lib/client/conversation-session";
import ConversationList from "../sidebar/ConversationList.svelte";
import SearchModal from "../search/SearchModal.svelte";
import AvatarCircle from "../ui/AvatarCircle.svelte";
import AppVersionBadge from "./AppVersionBadge.svelte";
import {
	ChevronRight,
	ChevronLeft,
	X,
	FilePen,
	Search,
	Loader,
	BookOpen,
	LogOut,
} from "@lucide/svelte";
import type { ConversationListItem, SessionUser, Project } from "$lib/types";
import { avatarState } from "$lib/stores/avatar";

let {
	open = false,
	conversationsData = [],
	projectsData = [],
	user = null,
	appVersion = null,
	onAppVersionClick = undefined,
}: {
	open?: boolean;
	conversationsData?: ConversationListItem[];
	projectsData?: Project[];
	user?: SessionUser | null;
	appVersion?: { compact: string; full: string } | null;
	onAppVersionClick?: (() => void) | undefined;
} = $props();

let isDesktop = $state(
	browser ? window.innerWidth >= SIDEBAR_DESKTOP_BREAKPOINT : false,
);
let showSearchModal = $state(false);
let transitionsEnabled = $state(false);
let resizing = $state(false);

const isCollapsed = $derived(isDesktop && $sidebarCollapsed);
const knowledgePending = $derived(
	$navigating?.to?.url.pathname === "/knowledge",
);

async function handleNewConversation() {
	markPreviousConversationId($currentConversationId);
	currentConversationId.set(null);
	if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
		sidebarOpen.set(false);
	}
	await goto("/");
}

function openSearchModal() {
	showSearchModal = true;
}

function closeSearchModal() {
	showSearchModal = false;
}

function toggleCollapse() {
	if (isDesktop) {
		sidebarCollapsed.update((v) => !v);
	}
}

function startResize(event: PointerEvent) {
	if (!isDesktop || isCollapsed) return;
	resizing = true;
	const startX = event.clientX;
	const startWidth = $sidebarWidth;
	const target = event.currentTarget as HTMLElement;
	target.setPointerCapture(event.pointerId);

	const handleMove = (moveEvent: PointerEvent) => {
		sidebarWidth.set(
			clampSidebarWidth(startWidth + moveEvent.clientX - startX),
		);
	};
	const handleUp = () => {
		resizing = false;
		window.removeEventListener("pointermove", handleMove);
		window.removeEventListener("pointerup", handleUp);
	};
	window.addEventListener("pointermove", handleMove);
	window.addEventListener("pointerup", handleUp, { once: true });
}

function handleResizeKeydown(event: KeyboardEvent) {
	if (!isDesktop || isCollapsed) return;
	if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
		event.preventDefault();
		const delta = event.key === "ArrowRight" ? 16 : -16;
		sidebarWidth.set(clampSidebarWidth($sidebarWidth + delta));
	}
	if (event.key === "Home") {
		event.preventDefault();
		sidebarWidth.set(SIDEBAR_DEFAULT_WIDTH);
	}
}

function navigateAndClose(path: string) {
	if (window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT) {
		sidebarOpen.set(false);
	}
	goto(path);
}

async function handleLogout() {
	try {
		await logout();
		clearClientAccountState();
		await goto("/login", { invalidateAll: true });
		await invalidateAll();
	} catch (error) {
		console.error("Logout failed:", error);
	}
}

onMount(() => {
	const syncViewportState = () => {
		isDesktop = window.innerWidth >= SIDEBAR_DESKTOP_BREAKPOINT;
	};

	syncViewportState();
	requestAnimationFrame(() => {
		transitionsEnabled = true;
	});
	window.addEventListener("resize", syncViewportState);

	return () => window.removeEventListener("resize", syncViewportState);
});
</script>

<!-- Mobile Overlay -->
{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="mobile-overlay fixed inset-0 z-40 bg-surface-overlay/50 backdrop-blur-sm"
		transition:fade={{ duration: 250 }}
		onclick={() => sidebarOpen.set(false)}
	></div>
{/if}

<!-- Sidebar -->
<aside
	class="sidebar-panel fixed inset-y-0 left-0 z-50 flex h-[100dvh] max-w-[100vw] flex-col border-r border-border bg-surface-overlay shadow-lg"
	class:-translate-x-[105%]={!open}
	class:translate-x-0={open}
	class:opacity-0={!open && !isDesktop}
	class:opacity-100={open || isDesktop}
	class:pointer-events-none={!open && !isDesktop}
	class:sidebar-collapsed={isCollapsed}
	class:transitions-enabled={transitionsEnabled}
	class:sidebar-resizing={resizing}
	style:width={isDesktop && !isCollapsed ? `${$sidebarWidth}px` : undefined}
>
	<!-- Sidebar Header -->
	<div
		class="sidebar-header flex h-[64px] shrink-0 items-center border-b border-border"
		class:justify-between={!isCollapsed}
		class:justify-center={isCollapsed}
		class:px-3={!isCollapsed}
		class:px-0={isCollapsed}
	>
		{#if !isCollapsed}
			<div class="flex min-w-0 items-baseline gap-2">
				<div class="overflow-hidden whitespace-nowrap text-[20px] font-sans font-semibold tracking-[-0.03em] text-text-primary opacity-90 transition-opacity duration-150">
					AlfyAI
				</div>
				{#if appVersion}
					<AppVersionBadge
						compactVersion={appVersion.compact}
						fullVersion={appVersion.full}
						onClick={onAppVersionClick}
					/>
				{/if}
			</div>
		{/if}

		<!-- Desktop: Collapse/Expand toggle -->
		<button
			class="desktop-only btn-icon-bare compose-btn"
			class:ml-auto={!isCollapsed}
			onclick={toggleCollapse}
			aria-label={isCollapsed ? $t('sidebar.expandSidebar') : $t('sidebar.collapseSidebar')}
			title={isCollapsed ? $t('sidebar.expandSidebar') : $t('sidebar.collapseSidebar')}
		>
			{#if isCollapsed}
				<ChevronRight size={20} strokeWidth={2.2} aria-hidden="true" />
			{:else}
				<ChevronLeft size={20} strokeWidth={2.2} aria-hidden="true" />
			{/if}
		</button>

		<!-- Mobile: Close button -->
		<button
			class="mobile-only btn-icon-bare ml-auto"
			onclick={() => sidebarOpen.set(false)}
			aria-label={$t('sidebar.closeSidebar')}
		>
			<X size={24} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>

	<!-- Search + New Chat -->
	<div class="shrink-0 py-2" class:px-3={!isCollapsed} class:px-0={isCollapsed}>
		{#if isCollapsed}
			<!-- Icon-only when collapsed -->
			<div class="flex w-full flex-col items-center gap-2">
				<button
					data-testid="new-conversation"
					class="compose-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-accent transition-colors duration-150 hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={handleNewConversation}
					title={$t('sidebar.newChat')}
					aria-label={$t('sidebar.newChat')}
				>
				<FilePen size={19} strokeWidth={2.1} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="compose-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-icon-muted transition-colors duration-150 hover:text-icon-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={openSearchModal}
					title={$t('sidebar.search')}
					aria-label={$t('sidebar.searchConversations')}
				>
				<Search size={19} strokeWidth={2.1} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="compose-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-icon-muted transition-colors duration-150 hover:text-icon-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={() => navigateAndClose('/knowledge')}
					title={$t('sidebar.knowledgeBase')}
					aria-label={$t('sidebar.openKnowledgeBase')}
					aria-busy={knowledgePending}
				>
				{#if knowledgePending}
					<Loader class="animate-spin" size={18} strokeWidth={2.1} aria-hidden="true" />
					{:else}
					<BookOpen size={19} strokeWidth={2.1} aria-hidden="true" />
				{/if}
			</button>
		</div>
	{:else}
		<!-- Expanded: search pill + compose icon in a single row -->
		<div class="flex items-center gap-2">
			<!-- Search pill -->
			<button
				type="button"
				class="search-pill flex flex-1 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm text-text-muted transition-colors duration-150 hover:border-border-focus hover:bg-surface-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onclick={openSearchModal}
				aria-label={$t('sidebar.searchConversations')}
			>
				<Search size={15} strokeWidth={2.1} class="shrink-0 text-icon-muted" aria-hidden="true" />
					<span class="flex-1 truncate">{$t('sidebar.search')}</span>
				</button>
				<!-- New chat compose button -->
				<button
					data-testid="new-conversation"
					class="compose-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-accent transition-colors duration-150 hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={handleNewConversation}
					title={$t('sidebar.newChat')}
					aria-label={$t('sidebar.newChat')}
				>
			<FilePen size={18} strokeWidth={2.1} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="compose-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-icon-muted transition-colors duration-150 hover:text-icon-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={() => navigateAndClose('/knowledge')}
					title={$t('sidebar.knowledgeBase')}
					aria-label={$t('sidebar.openKnowledgeBase')}
					aria-busy={knowledgePending}
				>
			{#if knowledgePending}
					<Loader class="animate-spin" size={18} strokeWidth={2.1} aria-hidden="true" />
				{:else}
					<BookOpen size={18} strokeWidth={2.1} aria-hidden="true" />
				{/if}
				</button>
			</div>
		{/if}
	</div>

	<!-- Conversation list -->
	<div class="flex-1 overflow-y-auto py-sm" class:px-sm={!isCollapsed} class:px-1={isCollapsed} style="pointer-events: auto;">
		{#if !isCollapsed}
			<ConversationList
				initialConversations={conversationsData}
				initialProjects={projectsData}
			/>
		{/if}
	</div>

	<!-- Bottom: Profile + Logout -->
	<div class="shrink-0 border-t border-border py-sm" class:px-0={isCollapsed} class:px-3={!isCollapsed}>
		{#if isCollapsed}
			<!-- Collapsed: two stacked icons with doubled gap -->
			<div class="flex flex-col items-center gap-2">
				<button
					type="button"
					class="profile-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={() => navigateAndClose('/settings')}
					title={$t('sidebar.settings')}
					aria-label={$t('sidebar.openSettings')}
				>
					<AvatarCircle
						userId={user?.id ?? 'default'}
						name={user?.displayName ?? null}
						avatarId={user?.avatarId ?? null}
						profilePicture={$avatarState.profilePicture}
					cacheBuster={$avatarState.cacheBuster}
						size={22}
					/>
				</button>
		<button
				type="button"
				class="logout-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-icon-muted transition-colors duration-150 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onclick={handleLogout}
				title={$t('sidebar.logout')}
				aria-label={$t('sidebar.logout')}
			>
				<LogOut size={17} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
	{:else}
			<!-- Expanded: profile info (→ settings) + logout icon in one row -->
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="profile-btn flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-1.5 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
					onclick={() => navigateAndClose('/settings')}
					aria-label={$t('sidebar.openSettings')}
				>
					<AvatarCircle
						userId={user?.id ?? 'default'}
						name={user?.displayName ?? null}
						avatarId={user?.avatarId ?? null}
						profilePicture={$avatarState.profilePicture}
					cacheBuster={$avatarState.cacheBuster}
						size={28}
					/>
					<div class="min-w-0 flex-1 text-left">
						<div class="truncate text-sm font-medium text-text-primary">{user?.displayName ?? $t('sidebar.profile')}</div>
						<div class="truncate text-xs text-text-muted">{user?.email ?? ''}</div>
					</div>
				</button>
			<button
				type="button"
				class="logout-btn flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-icon-muted transition-colors duration-150 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onclick={handleLogout}
				title={$t('sidebar.logout')}
				aria-label={$t('sidebar.logout')}
			>
				<LogOut size={17} strokeWidth={2} aria-hidden="true" />
			</button>
			</div>
		{/if}
	</div>

	{#if isDesktop && !isCollapsed}
		<button
			type="button"
			class="sidebar-resize-handle"
			aria-label={$t('sidebar.resizeSidebar')}
			title={$t('sidebar.resizeSidebar')}
			onpointerdown={startResize}
			onkeydown={handleResizeKeydown}
			ondblclick={() => sidebarWidth.set(SIDEBAR_DEFAULT_WIDTH)}
		></button>
	{/if}
</aside>

<SearchModal isOpen={showSearchModal} onClose={closeSearchModal} />

<style>
	.sidebar-panel {
		max-width: 100vw;
		transition: none;
	}

	.sidebar-panel.transitions-enabled {
		transition:
			width 240ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 240ms cubic-bezier(0.22, 1, 0.36, 1),
			translate 240ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 180ms cubic-bezier(0.22, 1, 0.36, 1),
			background-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
			border-color 150ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	.sidebar-panel.sidebar-collapsed {
		width: 48px;
		overflow: hidden;
	}

	.sidebar-panel.sidebar-resizing {
		transition: none;
		user-select: none;
	}

	.sidebar-resize-handle {
		position: absolute;
		top: 0;
		right: -5px;
		z-index: 2;
		width: 10px;
		height: 100%;
		cursor: col-resize;
		background: transparent;
		border: 0;
		padding: 0;
	}

	.sidebar-resize-handle::after {
		content: '';
		position: absolute;
		top: 0;
		right: 4px;
		width: 2px;
		height: 100%;
		background: transparent;
	}

	.sidebar-resize-handle:hover::after,
	.sidebar-resize-handle:focus-visible::after {
		background: var(--accent);
	}

	.search-pill {
		background: color-mix(in srgb, var(--surface-elevated) 60%, var(--surface-overlay) 40%);
	}

	.search-pill:hover {
		background: var(--surface-page);
	}

	.compose-btn {
		border: 1px solid transparent;
	}

	.compose-btn:hover {
		background: color-mix(in srgb, var(--border-default) 18%, transparent 82%);
		border-color: var(--border-default);
	}

	.logout-btn {
		border: 1px solid transparent;
	}

	.logout-btn:hover {
		background: color-mix(in srgb, var(--border-default) 18%, transparent 82%);
		border-color: var(--border-default);
	}

	.profile-btn {
		border: 1px solid transparent;
		border-radius: 0.5rem;
	}

	.profile-btn:hover {
		background: color-mix(in srgb, var(--border-default) 18%, transparent 82%);
		border-color: var(--border-default);
	}

	@media (max-width: 1023px) {
		.sidebar-panel {
			width: 100vw;
		}
	}

	@media (min-width: 1024px) {
		.sidebar-panel {
			position: relative !important;
			inset: auto !important;
			flex: 0 0 auto;
			width: 300px;
			transform: translateX(0) !important;
			translate: 0 !important;
			opacity: 1 !important;
		}

		.sidebar-panel.sidebar-collapsed {
			width: 48px;
		}

		.mobile-overlay {
			display: none !important;
		}

		.mobile-only {
			display: none !important;
		}

		.desktop-only {
			display: inline-flex !important;
		}
	}

	@media (max-width: 1023px) {
		.desktop-only {
			display: none !important;
		}

		.mobile-only {
			display: inline-flex !important;
		}
	}
</style>
