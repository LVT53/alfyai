<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { page, navigating, updated } from "$app/state";
import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import Header from "$lib/components/layout/Header.svelte";
import Sidebar from "$lib/components/layout/Sidebar.svelte";
import CampaignModal from "$lib/components/campaigns/CampaignModal.svelte";
import ServerUpdateNotice from "./_components/ServerUpdateNotice.svelte";
import type { Component } from "svelte";
import {
	currentConversationId,
	sidebarOpen,
	initUIListeners,
	sidebarProjectsExpanded,
	sidebarChatsExpanded,
} from "$lib/stores/ui";
import {
	loadConversations,
	reconcileConversationSnapshot,
} from "$lib/stores/conversations";
import {
	completeCampaign,
	fetchEligibleCampaign,
	fetchLatestCampaign,
	recordCampaignEvent,
	type Campaign,
	type CampaignEventType,
	type CampaignSlide,
} from "$lib/client/api/campaigns";
import { conversationExists } from "$lib/client/api/conversations";
import {
	shouldPersistCampaignCompletion,
	type CampaignDisplayMode,
} from "$lib/client/campaign-replay";
import { removeConversationFromPersistedWorkspaceDocumentState } from "$lib/client/document-workspace-state";
import { fetchPublicPersonalityProfiles } from "$lib/client/api/admin";
import {
	fetchUserSettings,
	updateUserPreferences,
} from "$lib/client/api/settings";
import { reconcileProjectSnapshot } from "$lib/stores/projects";
import {
	markServerUpdateRefreshRequested,
	readServerUpdateRefreshSuppressedUntil,
	SERVER_UPDATE_REFRESH_SUPPRESSION_MS,
} from "$lib/client/server-update-notice";
import {
	initSettings,
	setModelPreferenceAndSync,
	setSelectedModelAndSync,
	setUiLanguageAndSync,
	uiLanguage,
	type UiLanguage,
} from "$lib/stores/settings";
import { initTheme, setThemeAndSync, type Theme } from "$lib/stores/theme";
import { initAvatar } from "$lib/stores/avatar";
import type {
	ConversationListItem,
	ModelId,
	Project,
	UserModelPreference,
} from "$lib/types";
import type { LayoutProps } from "./$types";

let { data, children }: LayoutProps = $props();

type ImportChatGPTModalProps = {
	show: boolean;
	onClose?: () => void;
	projects?: Project[];
};

let ImportChatGPTModalComponent: Component<ImportChatGPTModalProps> | null =
	$state(null);

type AppVersionMetadata = { compact: string; full: string };
type LayoutAvailableModel = {
	id: ModelId;
	displayName: string;
	isThirdParty?: boolean;
	iconAssetId?: string | null;
	iconUrl?: string | null;
};

// Debounce state for conversation list refresh
let lastRefreshTime = $state(0);
const REFRESH_DEBOUNCE_MS = 2000; // 2 seconds minimum between refreshes
let previousConversationUserId: string | null = $state(null);
let serverUpdateAvailable = $state(false);
let serverUpdateSuppressedUntil = $state(
	browser ? readServerUpdateRefreshSuppressedUntil(window.sessionStorage) : 0,
);
let serverUpdateSuppressionTimeout: number | null = null;
let activeCampaign: Campaign | null = $state(null);
let campaignMode: CampaignDisplayMode = $state("auto");
let campaignSlideIndex = $state(0);
let campaignViewedSlideIds = new Set<string>();
let showChatGPTImportModal = $state(false);
let selectedCampaignModel: UserModelPreference = $state(null);
let effectiveCampaignModel: ModelId = $state("model1");
let campaignSystemDefaultModel: ModelId = $state("model1");
let layoutCampaignDefaultKey = $state("");
let selectedCampaignTheme: Theme = $state("system");
let selectedCampaignUiLanguage: UiLanguage = $state("en");
let selectedCampaignPersonalityId: string | null = $state(null);
let campaignPersonalityProfiles: Array<{
	id: string;
	name: string;
	description: string;
	isBuiltIn?: boolean | number | null;
}> = $state([]);
let shellConversations: ConversationListItem[] = $state([]);
let shellProjects: Project[] = $state([]);
let shellAppVersion: AppVersionMetadata | null = $state(null);
let shellAvailableModels: LayoutAvailableModel[] = $state([]);
let shellPayloadSequence = 0;
let routeProgressVisible = $state(false);
let routeProgressTimeout: number | null = null;
const ROUTE_PROGRESS_STUCK_TIMEOUT_MS = 12000;

$effect(() => {
	const sequence = ++shellPayloadSequence;
	Promise.resolve(data?.conversations ?? [])
		.then((items) => {
			if (sequence === shellPayloadSequence) {
				shellConversations = items;
			}
		})
		.catch((error) => {
			console.warn("Failed to resolve shell conversations:", error);
		});
	Promise.resolve(data?.projects ?? [])
		.then((items) => {
			if (sequence === shellPayloadSequence) {
				shellProjects = items;
			}
		})
		.catch((error) => {
			console.warn("Failed to resolve shell projects:", error);
		});
	Promise.resolve(data?.appVersion ?? null)
		.then((appVersion) => {
			if (sequence === shellPayloadSequence) {
				shellAppVersion = appVersion;
			}
		})
		.catch((error) => {
			console.warn("Failed to resolve shell app version:", error);
		});
	Promise.resolve(data?.availableModels ?? [])
		.then((models) => {
			if (sequence === shellPayloadSequence) {
				shellAvailableModels = models;
			}
		})
		.catch((error) => {
			console.warn("Failed to resolve shell available models:", error);
	});
});

$effect(() => {
	const isNavigating = Boolean(navigating.to);
	if (!browser) {
		routeProgressVisible = isNavigating;
		return;
	}
	if (!isNavigating) {
		routeProgressVisible = false;
		if (routeProgressTimeout !== null) {
			window.clearTimeout(routeProgressTimeout);
			routeProgressTimeout = null;
		}
		return;
	}
	routeProgressVisible = true;
	if (routeProgressTimeout !== null) {
		window.clearTimeout(routeProgressTimeout);
	}
	routeProgressTimeout = window.setTimeout(() => {
		routeProgressVisible = false;
		routeProgressTimeout = null;
	}, ROUTE_PROGRESS_STUCK_TIMEOUT_MS);
	return () => {
		if (routeProgressTimeout !== null) {
			window.clearTimeout(routeProgressTimeout);
			routeProgressTimeout = null;
		}
	};
});

$effect(() => {
	const nextUserId = data.user?.id ?? null;
	const resetLocalState =
		previousConversationUserId !== null &&
		previousConversationUserId !== nextUserId;
	reconcileConversationSnapshot(shellConversations, {
		resetLocalState,
		userId: nextUserId,
	});
	previousConversationUserId = nextUserId;
});

$effect(() => {
	reconcileProjectSnapshot(shellProjects, {
		userId: data.user?.id ?? null,
	});
});

// Reactive <html lang> attribute
$effect(() => {
	if (typeof document !== "undefined") {
		document.documentElement.lang = $uiLanguage;
	}
});

$effect(() => {
	if (!browser) return;
	const match = page.url.pathname.match(/^\/chat\/([^/]+)$/);
	currentConversationId.set(match?.[1] ?? null);
});

$effect(() => {
	if (updated.current && !isServerUpdateNoticeSuppressed()) {
		serverUpdateAvailable = true;
	}
});

$effect(() => {
	const nextDefault = data.systemDefaultModel ?? data.userModel;
	const nextKey = `${nextDefault}:${data.userModel}`;
	if (nextKey === layoutCampaignDefaultKey) return;
	layoutCampaignDefaultKey = nextKey;
	campaignSystemDefaultModel = nextDefault;
	if (selectedCampaignModel === null) {
		effectiveCampaignModel = campaignSystemDefaultModel;
	}
});

/**
 * Refresh conversation list with debounce protection.
 * Preserves existing list on failure and handles deleted conversation edge case.
 */
async function refreshConversations() {
	if (!browser) return;

	const now = Date.now();
	if (now - lastRefreshTime < REFRESH_DEBOUNCE_MS) {
		return; // Skip if within debounce window
	}

	lastRefreshTime = now;

	// Store current conversation state before refresh
	const currentId = $currentConversationId;
	const currentPath = page.url.pathname;

	try {
		await loadConversations({ force: true });

		// Edge case: if current conversation was deleted from another device,
		// redirect to landing page. Do not rely on the sidebar list:
		// brand-new bootstrap conversations can exist before the list chooses to show them,
		// while a stale optimistic local row cannot prove existence.
		if (currentId && currentPath === `/chat/${currentId}`) {
			const exists = await conversationExists(currentId);
			if (exists === false) {
				removeConversationFromPersistedWorkspaceDocumentState(
					window.sessionStorage,
					currentId,
				);
				goto("/");
			}
		}
	} catch (error) {
		// Silently ignore errors - preserve existing list (stale data is better than empty)
		console.warn("Failed to refresh conversation list:", error);
	}
}

async function checkForServerUpdate() {
	if (!browser || serverUpdateAvailable || isServerUpdateNoticeSuppressed())
		return;

	try {
		serverUpdateAvailable = await updated.check();
	} catch (error) {
		if (!isTransientRefreshError(error)) {
			console.warn("Failed to check for a server update:", error);
		}
	}
}

function isTransientRefreshError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return (
		error instanceof TypeError ||
		message.includes("failed to fetch") ||
		message.includes("networkerror") ||
		message.includes("network error") ||
		message.includes("timed out") ||
		message.includes("timeout")
	);
}

function refreshForServerUpdate() {
	if (!browser) return;
	markServerUpdateRefreshRequested(window.sessionStorage);
	serverUpdateAvailable = false;
	window.location.reload();
}

function isServerUpdateNoticeSuppressed() {
	return browser && serverUpdateSuppressedUntil > Date.now();
}

function initializeServerUpdateSuppression() {
	if (!browser) return;
	serverUpdateSuppressedUntil = readServerUpdateRefreshSuppressedUntil(
		window.sessionStorage,
	);
	if (!serverUpdateSuppressedUntil) return;
	if (serverUpdateSuppressionTimeout) {
		window.clearTimeout(serverUpdateSuppressionTimeout);
	}

	serverUpdateSuppressionTimeout = window.setTimeout(
		() => {
			serverUpdateSuppressedUntil = readServerUpdateRefreshSuppressedUntil(
				window.sessionStorage,
			);
			void checkForServerUpdate();
		},
		Math.min(
			SERVER_UPDATE_REFRESH_SUPPRESSION_MS,
			Math.max(0, serverUpdateSuppressedUntil - Date.now()),
		),
	);
}

async function recordActiveCampaignEvent(
	eventType: CampaignEventType,
	slideId?: string | null,
	metadata?: Record<string, unknown>,
) {
	if (!activeCampaign) return;
	try {
		await recordCampaignEvent(activeCampaign.id, {
			eventType,
			slideId,
			metadata,
		});
	} catch (error) {
		console.warn("Failed to record campaign event:", error);
	}
}

function openCampaign(campaign: Campaign, mode: CampaignDisplayMode) {
	activeCampaign = campaign;
	campaignMode = mode;
	campaignSlideIndex = 0;
	campaignViewedSlideIds = new Set();
	void recordCampaignEvent(campaign.id, {
		eventType: mode === "auto" ? "auto_shown" : "replay_opened",
	}).catch((error) => {
		console.warn("Failed to record campaign open event:", error);
	});
}

async function refreshCampaignSetupPreferences() {
	try {
		const settings = await fetchUserSettings();
		selectedCampaignModel = settings.preferences.preferredModel;
		effectiveCampaignModel = settings.preferences.effectiveModel;
		campaignSystemDefaultModel = settings.preferences.systemDefaultModel;
		selectedCampaignTheme = settings.preferences.theme;
		selectedCampaignUiLanguage = settings.preferences.uiLanguage;
		selectedCampaignPersonalityId = settings.preferences.preferredPersonalityId;
	} catch {
		const fallbackDefault = data.systemDefaultModel ?? data.userModel;
		campaignSystemDefaultModel = fallbackDefault;
		if (selectedCampaignModel === null) {
			effectiveCampaignModel = fallbackDefault;
		}
	}
}

async function checkEligibleCampaign() {
	if (!browser || activeCampaign) return;
	try {
		const campaign = await fetchEligibleCampaign();
		if (campaign && !activeCampaign) {
			await refreshCampaignSetupPreferences();
			openCampaign(campaign, "auto");
		}
	} catch (error) {
		console.warn("Failed to load eligible campaign:", error);
	}
}

async function handleAppVersionClick() {
	if (!browser) return;
	try {
		const campaign = await fetchLatestCampaign();
		if (campaign) {
			await refreshCampaignSetupPreferences();
			openCampaign(campaign, "replay");
		}
	} catch (error) {
		console.warn("Failed to load latest campaign:", error);
	}
}

function handleCampaignSlideView(slide: CampaignSlide, index: number) {
	if (!activeCampaign) return;
	const slideId = slide.id ?? `slide-${index}`;
	if (campaignViewedSlideIds.has(slideId)) return;
	campaignViewedSlideIds.add(slideId);
	void recordActiveCampaignEvent("slide_viewed", slide.id ?? null, {
		index,
		mode: campaignMode,
	});
}

async function handleCampaignInternalAction(action: string) {
	if (action === "chatgpt-import") {
		if (!ImportChatGPTModalComponent) {
			const mod = await import(
				"$lib/components/chat/ImportChatGPTModal.svelte"
			);
			ImportChatGPTModalComponent = mod.default;
		}
		showChatGPTImportModal = true;
	}
}

async function finishActiveCampaign(reason: "completed" | "skipped") {
	const campaign = activeCampaign;
	if (!campaign) return;
	const mode = campaignMode;
	activeCampaign = null;
	if (!shouldPersistCampaignCompletion(mode)) return;
	try {
		await completeCampaign(campaign.id, reason);
	} catch (error) {
		console.warn("Failed to complete campaign:", error);
	}
}

function recordSetupPreferenceChange(preference: string, value: string) {
	void recordActiveCampaignEvent("setup_preference_changed", null, {
		preference,
		value,
	});
}

async function changeCampaignUiLanguage(language: UiLanguage) {
	selectedCampaignUiLanguage = language;
	await setUiLanguageAndSync(language);
	recordSetupPreferenceChange("ui_language", language);
}

async function changeCampaignTheme(theme: Theme) {
	selectedCampaignTheme = theme;
	await setThemeAndSync(theme);
	recordSetupPreferenceChange("theme", theme);
}

async function changeCampaignModel(model: UserModelPreference) {
	selectedCampaignModel = model;
	if (model === null) {
		effectiveCampaignModel = campaignSystemDefaultModel;
		await setModelPreferenceAndSync(null, effectiveCampaignModel);
		recordSetupPreferenceChange("model_default", "system");
		return;
	}
	effectiveCampaignModel = model;
	await setSelectedModelAndSync(model);
	recordSetupPreferenceChange("model_default", model);
}

async function changeCampaignPersonality(id: string | null) {
	selectedCampaignPersonalityId = id;
	await updateUserPreferences({ preferredPersonalityId: id }).catch(() => {});
	recordSetupPreferenceChange("ai_style", id ?? "default");
}

/**
 * Handle visibilitychange event - refresh when tab becomes visible
 */
function handleVisibilityChange() {
	if (document.visibilityState === "visible") {
		refreshConversations();
		void checkForServerUpdate();
	}
}

/**
 * Handle focus event - fallback for mobile browsers
 */
function handleWindowFocus() {
	refreshConversations();
	void checkForServerUpdate();
}

onMount(() => {
	initTheme(data.userTheme as "system" | "light" | "dark");
	initSettings({
		model: data.userModel,
		titleLanguage: data.userTitleLanguage,
		uiLanguage: data.userUiLanguage,
	});
	initAvatar(data.user?.profilePicture ?? null);
	initializeServerUpdateSuppression();
	selectedCampaignModel = data.userModelPreference ?? null;
	effectiveCampaignModel = data.userModel;
	campaignSystemDefaultModel = data.systemDefaultModel ?? data.userModel;
	selectedCampaignTheme = data.userTheme as Theme;
	selectedCampaignUiLanguage = data.userUiLanguage;
	selectedCampaignPersonalityId = data.userPersonality ?? null;
	sidebarProjectsExpanded.set(data.userSidebarProjectsExpanded ?? true);
	sidebarChatsExpanded.set(data.userSidebarChatsExpanded ?? true);
	const cleanupUIListeners = initUIListeners();

	// Add event listeners for conversation list refresh
	document.addEventListener("visibilitychange", handleVisibilityChange);
	window.addEventListener("focus", handleWindowFocus);
	void checkForServerUpdate();
	void fetchPublicPersonalityProfiles()
		.then((profiles) => {
			campaignPersonalityProfiles = profiles;
			if (
				selectedCampaignPersonalityId &&
				!profiles.some(
					(profile) => profile.id === selectedCampaignPersonalityId,
				)
			) {
				selectedCampaignPersonalityId = null;
			}
		})
		.catch(() => {});
	void checkEligibleCampaign();

	return () => {
		cleanupUIListeners();
	};
});

onDestroy(() => {
	if (!browser) return;
	if (serverUpdateSuppressionTimeout) {
		window.clearTimeout(serverUpdateSuppressionTimeout);
		serverUpdateSuppressionTimeout = null;
	}
	if (routeProgressTimeout !== null) {
		window.clearTimeout(routeProgressTimeout);
		routeProgressTimeout = null;
	}
	document.removeEventListener("visibilitychange", handleVisibilityChange);
	window.removeEventListener("focus", handleWindowFocus);
});
</script>

<!-- 
  Scroll Ownership: App Root Container
  - h-screen + overflow-hidden locks the app to viewport
  - Scroll is delegated to child components (Sidebar list, MessageArea)
  - See SCROLL OWNERSHIP CONTRACT in src/app.css
-->
<div class="flex h-[100dvh] w-full flex-col overflow-hidden bg-primary text-text-primary">
	<Header />

	<div class="flex h-full flex-1 overflow-hidden">
		<Sidebar
			open={$sidebarOpen}
			conversationsData={shellConversations}
			projectsData={shellProjects}
			user={data?.user}
			appVersion={shellAppVersion}
			onAppVersionClick={handleAppVersionClick}
		/>

		<main class="relative flex h-full flex-1 flex-col overflow-clip min-w-0">
			{#if routeProgressVisible}
				<div class="pointer-events-none absolute inset-x-0 top-0 z-20 h-1 overflow-hidden">
					<div class="route-progress h-full w-1/3 rounded-full bg-accent/80"></div>
				</div>
			{/if}
			{@render children()}
		</main>
	</div>
	<ServerUpdateNotice visible={serverUpdateAvailable} onRefresh={refreshForServerUpdate} />
</div>

{#if activeCampaign}
	<CampaignModal
		campaign={activeCampaign}
		locale={$uiLanguage}
		slideIndex={campaignSlideIndex}
		onSlideChange={(index) => (campaignSlideIndex = index)}
		onSlideView={handleCampaignSlideView}
		onSkip={() => finishActiveCampaign('skipped')}
		onFinish={() => finishActiveCampaign('completed')}
		onInternalAction={handleCampaignInternalAction}
		setupPreferences={{
			availableModels: shellAvailableModels,
			effectiveModel: effectiveCampaignModel,
			systemDefaultModel: campaignSystemDefaultModel,
			selectedModel: selectedCampaignModel,
			selectedTheme: selectedCampaignTheme,
			selectedUiLanguage: selectedCampaignUiLanguage,
			personalityProfiles: campaignPersonalityProfiles,
			selectedPersonalityId: selectedCampaignPersonalityId,
			onChangeUiLanguage: changeCampaignUiLanguage,
			onChangeTheme: changeCampaignTheme,
			onChangeModel: changeCampaignModel,
			onChangePersonality: changeCampaignPersonality,
		}}
	/>
{/if}

{#if ImportChatGPTModalComponent}
	<ImportChatGPTModalComponent
		bind:show={showChatGPTImportModal}
		onClose={() => (showChatGPTImportModal = false)}
		projects={shellProjects}
	/>
{/if}

<style>
	@keyframes route-progress-slide {
		0% {
			transform: translateX(-120%) scaleX(0.7);
			opacity: 0.35;
		}
		50% {
			transform: translateX(60%) scaleX(1);
			opacity: 0.9;
		}
		100% {
			transform: translateX(280%) scaleX(0.8);
			opacity: 0.35;
		}
	}

	.route-progress {
		animation: route-progress-slide 1s ease-in-out infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.route-progress {
			width: 100%;
			animation: none;
			opacity: 0.85;
		}
	}
</style>
