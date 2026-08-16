// Identity/session/preferences contract shared by the auth service
// (auth.ts, hooks.ts), settings routes, and client components that render
// account state. Pure types — consumed type-only by client code even
// though this file lives under $lib/server. Relocated out of the former
// src/lib/types.ts god-module (architecture-deepening T1); this file
// carries no behavior change, only a new home.
//
// Note: src/lib/stores/theme.ts and src/lib/stores/settings.ts each
// already declare their own local `Theme`/`UiLanguage` types (pre-existing
// duplication, not introduced by this relocation and out of scope for it —
// see AGENTS.md T1 notes).
import type { ModelId, UserModelPreference } from "$lib/model-types";

export type UserRole = "user" | "admin";
export type Theme = "system" | "light" | "dark";
export type UiLanguage = "en" | "hu";

export interface UserPreferences {
	preferredModel: UserModelPreference;
	effectiveModel: ModelId;
	systemDefaultModel: ModelId;
	theme: Theme;
	titleLanguage: "auto" | "en" | "hu";
	uiLanguage: UiLanguage;
	preferredPersonalityId: string | null;
	sidebarProjectsExpanded: boolean;
	sidebarChatsExpanded: boolean;
	memoryEnabled: boolean;
}

export interface UserSettings {
	id: string;
	email: string;
	name: string | null;
	role: UserRole;
	preferences: UserPreferences;
	profilePicture: string | null;
}

// User interface: id, email, displayName
export interface User {
	id: string;
	email: string;
	displayName: string;
}

// SessionUser interface: id, email, displayName (for event.locals)
export interface SessionUser {
	id: string;
	email: string;
	displayName: string;
	role: UserRole;
	profilePicture: string | null;
	titleLanguage: "auto" | "en" | "hu";
	uiLanguage: UiLanguage;
}
