<script lang="ts">
import { goto, invalidateAll } from "$app/navigation";
import { onMount } from "svelte";
import { logout } from "$lib/client/api/auth";
import { clearClientAccountState } from "$lib/client/session-boundary";
import { t } from "$lib/i18n";
import { BookOpen, Menu, User, Plus, LogOut } from "@lucide/svelte";
import { markPreviousConversationId } from "$lib/client/conversation-session";
import {
	portal,
	setMenuBaseBackground,
	updateMenuPosition,
	setupMenuSync,
} from "$lib/utils/popup-menu";
import {
	sidebarOpen,
	sidebarCollapsed,
	currentConversationId,
	SIDEBAR_DESKTOP_BREAKPOINT,
} from "$lib/stores/ui";
import ConversationTitleText from "$lib/components/chat/ConversationTitleText.svelte";

let {
	conversationTitle = null,
}: {
	conversationTitle?: string | null;
} = $props();

let mobileMenuOpen = $state(false);
let menuRef = $state<HTMLDivElement | undefined>(undefined);
let triggerRef = $state<HTMLButtonElement | undefined>(undefined);
let menuPositionStyle = $state("");
let menuBaseBackground = $state("var(--surface-elevated)");

async function handleLogout() {
	try {
		await logout();
		clearClientAccountState();
		mobileMenuOpen = false;
		await goto("/login", { invalidateAll: true });
		await invalidateAll();
	} catch (error) {
		console.error("Logout failed:", error);
	}
}

function toggleSidebar() {
	if (
		typeof window !== "undefined" &&
		window.innerWidth >= SIDEBAR_DESKTOP_BREAKPOINT
	) {
		sidebarCollapsed.update((collapsed) => !collapsed);
		return;
	}

	sidebarOpen.update((open) => !open);
}

async function handleNewConversation() {
	try {
		markPreviousConversationId($currentConversationId);
		currentConversationId.set(null);
		mobileMenuOpen = false;
		if (
			typeof window !== "undefined" &&
			window.innerWidth < SIDEBAR_DESKTOP_BREAKPOINT
		) {
			sidebarOpen.set(false);
		}
		await goto("/");
	} catch (error) {
		console.error("Failed to create new conversation:", error);
		alert("Failed to create new conversation. Please try again.");
	}
}

async function handleOpenKnowledge() {
	mobileMenuOpen = false;
	await goto("/knowledge");
}

function doUpdatePosition() {
	if (!triggerRef) return;
	menuBaseBackground = setMenuBaseBackground() || "var(--surface-elevated)";
	updateMenuPosition(
		triggerRef,
		(style) => {
			menuPositionStyle = style;
		},
		188,
	);
}

function toggleMobileMenu(event: MouseEvent) {
	event.stopPropagation();
	if (!mobileMenuOpen) {
		doUpdatePosition();
	}
	mobileMenuOpen = !mobileMenuOpen;
}

function closeMobileMenu() {
	mobileMenuOpen = false;
}

function handleOutsideClick(event: MouseEvent) {
	const target = event.target as Node;
	if (
		mobileMenuOpen &&
		menuRef &&
		triggerRef &&
		!menuRef.contains(target) &&
		!triggerRef.contains(target)
	) {
		closeMobileMenu();
	}
}

onMount(() => {
	return setupMenuSync(() => mobileMenuOpen, doUpdatePosition);
});
</script>

<svelte:window onclick={handleOutsideClick} />

<header
	class="z-10 box-border grid h-[52px] w-full max-w-full flex-none grid-cols-[44px_minmax(0,1fr)_44px] items-center border-b border-border bg-surface-page pl-4 pr-4 pt-[max(0.35rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden"
>
	<div class="flex min-w-0 items-center justify-start">
		<button
			class="btn-icon-bare mobile-sidebar-toggle"
			onclick={toggleSidebar}
			aria-label={$t('header.toggleSidebar')}
		>
			<Menu size={24} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>

	<div class="pointer-events-none flex min-w-0 items-center justify-center px-2">
		{#if conversationTitle}
			<div
				class="max-w-full truncate text-center text-[13px] font-medium leading-5 text-text-primary"
				title={conversationTitle}
				aria-live="polite"
			>
				<ConversationTitleText title={conversationTitle} />
			</div>
		{/if}
	</div>

	<div class="flex min-w-0 items-center justify-end">

		<div class="hide-on-desktop-lg">
			<button
				bind:this={triggerRef}
				class="btn-icon-bare mobile-user-trigger"
				onclick={toggleMobileMenu}
				aria-label={$t('header.openUserMenu')}
				title={$t('header.openUserMenu')}
				aria-expanded={mobileMenuOpen}
			>
				<span class="header-option-icon">
					<User size={20} strokeWidth={2} aria-hidden="true" />
				</span>
			</button>

			{#if mobileMenuOpen}
				<div
					bind:this={menuRef}
					use:portal
					class="header-menu z-[9999] overflow-hidden rounded-[0.75rem] border p-[5px]"
					style={`${menuPositionStyle} --header-menu-bg: ${menuBaseBackground};`}
				>
					<button
						class="header-option header-option-accent flex min-h-[38px] w-full items-center px-[3px] py-[3px] text-left text-sm font-sans text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						onclick={handleNewConversation}
					>
						<span class="header-option-icon header-option-icon-accent">
						<Plus size={18} strokeWidth={2.1} aria-hidden="true" />
					</span>
						<span>{$t('header.newChat')}</span>
					</button>
					<button
						class="header-option flex min-h-[38px] w-full items-center px-[3px] py-[3px] text-left text-sm font-sans text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						onclick={handleOpenKnowledge}
					>
						<span class="header-option-icon">
						<BookOpen size={18} strokeWidth={2.1} aria-hidden="true" />
					</span>
						<span>{$t('header.knowledgeBase')}</span>
					</button>
					<button
						class="header-option flex min-h-[38px] w-full items-center px-[3px] py-[3px] text-left text-sm font-sans text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						onclick={() => {
							mobileMenuOpen = false;
							goto('/settings');
						}}
					>
						<span class="header-option-icon">
						<User size={18} strokeWidth={2.1} aria-hidden="true" />
					</span>
						<span>{$t('header.profileAndSettings')}</span>
					</button>
					<button
						class="header-option header-option-danger flex min-h-[38px] w-full items-center px-[3px] py-[3px] text-left text-sm font-sans text-text-primary transition-colors duration-150 focus-visible:outline-none cursor-pointer"
						onclick={handleLogout}
					>
						<span class="header-option-icon header-option-icon-danger">
						<LogOut size={18} strokeWidth={2.1} aria-hidden="true" />
					</span>
						<span>{$t('header.logout')}</span>
					</button>
				</div>
			{/if}
		</div>
	</div>
</header>

<style>
	.mobile-user-trigger {
		color: var(--accent);
	}

	.mobile-user-trigger:hover,
	.mobile-user-trigger:focus-visible {
		color: var(--accent-hover);
	}

	.header-menu {
		background: var(--header-menu-bg, var(--surface-elevated));
		border-color: color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		isolation: isolate;
		pointer-events: auto;
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	:global(.dark) .header-menu {
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 16px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	.header-option {
		border: 0;
		border-radius: 0.75rem;
		background: var(--header-menu-bg);
		padding-inline: 0.65rem;
		gap: 0.8rem;
	}

	.header-option:hover,
	.header-option:focus-visible {
		background: rgba(194, 166, 106, 0.24) !important;
	}

	.header-option-accent:hover,
	.header-option-accent:focus-visible {
		background: rgba(194, 166, 106, 0.28) !important;
	}

	.header-option-danger:hover,
	.header-option-danger:focus-visible {
		background: rgba(186, 77, 77, 0.14) !important;
	}

	.header-option-icon {
		margin-right: 7px;
		color: color-mix(in srgb, var(--surface-overlay) 45%, var(--text-primary) 55%);
	}

	.header-option-icon-accent {
		color: var(--accent);
	}

	.header-option-icon-danger {
		color: color-mix(in srgb, var(--surface-overlay) 45%, var(--text-primary) 55%);
	}

	:global(.dark) .header-option:hover,
	:global(.dark) .header-option:focus-visible {
		background: rgba(194, 166, 106, 0.3) !important;
	}

	:global(.dark) .header-option-accent:hover,
	:global(.dark) .header-option-accent:focus-visible {
		background: rgba(194, 166, 106, 0.3) !important;
	}

	:global(.dark) .header-option-danger:hover,
	:global(.dark) .header-option-danger:focus-visible {
		background: rgba(186, 77, 77, 0.22) !important;
	}

	:global(.dark) .header-option-icon,
	:global(.dark) .header-option-icon-danger {
		color: color-mix(in srgb, var(--surface-overlay) 62%, var(--text-primary) 38%);
	}

	:global(.dark) .header-option-icon-accent {
		color: var(--accent);
	}

	@media (min-width: 1024px) {
		.mobile-sidebar-toggle {
			display: none !important;
		}
	}

	@media (min-width: 1024px) {
		.hide-on-desktop-lg {
			display: none !important;
		}
	}

</style>
