import { writable } from "svelte/store";
import { browser } from "$app/environment";
import { updateUserPreferences } from "$lib/client/api/settings";
import { persist, read } from "./_local-storage";

/**
 * BREAKPOINT CONTRACT - Single Source of Truth
 * =============================================
 *
 * Breakpoints are Tailwind CSS defaults (mobile-first):
 * - sm: 640px
 * - md: 768px  (tablet)
 * - lg: 1024px (desktop)
 * - xl: 1280px
 *
 * SIDEBAR BEHAVIOR:
 * - Layout styling uses CSS media queries exclusively (no JS layout decisions)
 * - JS (this store) is used ONLY for temporary overlay open/close state
 * - At lg (1024px) and above: sidebar is always visible (CSS: position: static)
 * - Below lg: sidebar is an overlay that can be opened/closed via JS
 *
 * USAGE GUIDELINES:
 * - Use CSS media queries for all layout decisions
 * - Use JS window.innerWidth ONLY for temporary UI states (overlays, modals)
 * - Always reference Tailwind breakpoint values for consistency
 */

export const SIDEBAR_DESKTOP_BREAKPOINT = 1024;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MAX_WIDTH = 480;
const PROJECT_FOLDER_EXPANDED_KEY = "projectFolderExpanded";
const SIDEBAR_PROJECTS_EXPANDED_KEY = "sidebarProjectsExpanded";
const SIDEBAR_CHATS_EXPANDED_KEY = "sidebarChatsExpanded";

const isValidBool = (v: string): v is "true" | "false" =>
	v === "true" || v === "false";

const initialSidebarOpenValue = browser
	? read(
			"sidebarOpen",
			window.innerWidth >= SIDEBAR_DESKTOP_BREAKPOINT ? "true" : "false",
			isValidBool,
		)
	: "false";
export const sidebarOpen = writable<boolean>(
	initialSidebarOpenValue === "true",
);

/**
 * Register the window resize listener for sidebar auto-open/close.
 * Call this once from the app layout bootstrap (onMount).
 * Returns a cleanup function for teardown if needed.
 */
export function initUIListeners(): () => void {
	if (!browser) {
		return () => {};
	}

	let wasDesktop = window.innerWidth >= SIDEBAR_DESKTOP_BREAKPOINT;

	// Ensure the sidebar state is immediately synced to the viewport on mount
	if (wasDesktop) {
		sidebarOpen.set(true);
	} else {
		sidebarOpen.set(false);
	}

	const handler = () => {
		const isDesktop = window.innerWidth >= SIDEBAR_DESKTOP_BREAKPOINT;

		if (isDesktop) {
			sidebarOpen.set(true);
		} else if (wasDesktop) {
			sidebarOpen.set(false);
		}

		wasDesktop = isDesktop;
	};

	window.addEventListener("resize", handler);
	return () => window.removeEventListener("resize", handler);
}

// Tracks the currently active conversation
export const currentConversationId = writable<string | null>(null);

// Tracks whether the desktop sidebar is collapsed to icon-only mode
const initialSidebarCollapsedValue = browser
	? read("sidebarCollapsed", "true", isValidBool)
	: "true";
export const sidebarCollapsed = writable<boolean>(
	initialSidebarCollapsedValue === "true",
);

function readProjectFolderExpanded(): Record<string, boolean> {
	if (!browser) return {};

	try {
		const stored = localStorage.getItem(PROJECT_FOLDER_EXPANDED_KEY);
		if (!stored) return {};

		const parsed: unknown = JSON.parse(stored);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};

		return Object.fromEntries(
			Object.entries(parsed).filter(([, value]) => typeof value === "boolean"),
		);
	} catch {
		return {};
	}
}

export const projectFolderExpanded = writable<Record<string, boolean>>(
	readProjectFolderExpanded(),
);

export function setProjectFolderExpanded(id: string, expanded: boolean): void {
	projectFolderExpanded.update((state) => ({
		...state,
		[id]: expanded,
	}));
}

export function clearProjectFolderExpanded(id: string): void {
	projectFolderExpanded.update((state) => {
		const { [id]: _removed, ...rest } = state;
		return rest;
	});
}

function isValidSidebarWidth(value: string): value is string {
	const parsed = Number(value);
	return (
		Number.isFinite(parsed) &&
		parsed >= SIDEBAR_MIN_WIDTH &&
		parsed <= SIDEBAR_MAX_WIDTH
	);
}

const initialSidebarWidthValue = browser
	? Number(
			read("sidebarWidth", String(SIDEBAR_DEFAULT_WIDTH), isValidSidebarWidth),
		)
	: SIDEBAR_DEFAULT_WIDTH;
export const sidebarWidth = writable<number>(initialSidebarWidthValue);

export function clampSidebarWidth(width: number): number {
	return Math.min(
		SIDEBAR_MAX_WIDTH,
		Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
	);
}

sidebarOpen.subscribe((value) =>
	persist("sidebarOpen", value ? "true" : "false"),
);
sidebarCollapsed.subscribe((value) =>
	persist("sidebarCollapsed", value ? "true" : "false"),
);
sidebarWidth.subscribe((value) =>
	persist("sidebarWidth", String(clampSidebarWidth(value))),
);
projectFolderExpanded.subscribe((value) =>
	persist(PROJECT_FOLDER_EXPANDED_KEY, JSON.stringify(value)),
);

const initialSidebarProjectsExpandedValue = browser
	? read(SIDEBAR_PROJECTS_EXPANDED_KEY, "true", isValidBool)
	: "true";
export const sidebarProjectsExpanded = writable<boolean>(
	initialSidebarProjectsExpandedValue === "true",
);

const initialSidebarChatsExpandedValue = browser
	? read(SIDEBAR_CHATS_EXPANDED_KEY, "true", isValidBool)
	: "true";
export const sidebarChatsExpanded = writable<boolean>(
	initialSidebarChatsExpandedValue === "true",
);

sidebarProjectsExpanded.subscribe((value) =>
	persist(SIDEBAR_PROJECTS_EXPANDED_KEY, value ? "true" : "false"),
);
sidebarChatsExpanded.subscribe((value) =>
	persist(SIDEBAR_CHATS_EXPANDED_KEY, value ? "true" : "false"),
);

export async function setSidebarProjectsExpandedAndSync(
	expanded: boolean,
): Promise<void> {
	sidebarProjectsExpanded.set(expanded);
	try {
		await updateUserPreferences({ sidebarProjectsExpanded: expanded });
	} catch {
		// Non-fatal: local preference already applied
	}
}

export async function setSidebarChatsExpandedAndSync(
	expanded: boolean,
): Promise<void> {
	sidebarChatsExpanded.set(expanded);
	try {
		await updateUserPreferences({ sidebarChatsExpanded: expanded });
	} catch {
		// Non-fatal: local preference already applied
	}
}
