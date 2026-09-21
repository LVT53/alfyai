import { eq } from "drizzle-orm";
import type { ModelId } from "$lib/model-types";
import {
	getAvailableModelsWithProviders,
	getConfig,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import type { AppVersionMetadata } from "$lib/server/services/app-version";
import { getAppVersionMetadata } from "$lib/server/services/app-version";
import { getAtlasAvailability } from "$lib/server/services/atlas/availability";
import type { AtlasAvailability } from "$lib/server/services/atlas/public-types";
import type { SessionUser } from "$lib/server/services/auth-types";
import type { ConversationListItem } from "$lib/server/services/conversations";
import { listConversations } from "$lib/server/services/conversations";
import { getUploadFormatGate } from "$lib/server/services/knowledge/format-availability";
import { resolveUserModelPreference } from "$lib/server/services/model-preferences";
import type { Project } from "$lib/server/services/projects";
import { listProjects } from "$lib/server/services/projects";

type AvailableShellModel = Awaited<
	ReturnType<typeof getAvailableModelsWithProviders>
>[number];

function resolveUserTheme(
	theme: string | null | undefined,
): "system" | "light" | "dark" {
	if (theme === "system" || theme === "light" || theme === "dark") {
		return theme;
	}
	return "system";
}

export interface AppShellData {
	user: SessionUser;
	conversations: Promise<ConversationListItem[]>;
	projects: Promise<Project[]>;
	maxMessageLength: number;
	/**
	 * Seeds `$lib/stores/upload-limits` from `(app)/+layout.svelte`'s
	 * `onMount` — drag-and-drop partitioning happens before the first upload
	 * intent is sent. On the client only; see that store's header for why, and
	 * for what server-rendered HTML shows until hydration.
	 */
	maxFileUploadSize: number;
	/**
	 * Seeds `$lib/stores/upload-format-gate` the same way, and just as early:
	 * registry entry ids the configured backend currently refuses (phase5-6
	 * spec §3.5). Empty when the backend is healthy or has never answered — the
	 * gate fails open, so a stale or absent SSR payload can never shrink the
	 * picker more than it should.
	 */
	disabledFileTypeIds: string[];
	composerCommandRegistryEnabled: boolean;
	atlasAvailability: AtlasAvailability;
	userTheme: "system" | "light" | "dark";
	userModel: ModelId;
	systemDefaultModel: ModelId;
	userModelPreference: ModelId | null;
	userTitleLanguage: "auto" | "en" | "hu";
	userUiLanguage: "en" | "hu";
	userPersonality: string | null;
	userSidebarProjectsExpanded: boolean;
	userSidebarChatsExpanded: boolean;
	modelNames: Record<string, string>;
	availableModels: AvailableShellModel[];
	appVersion: Promise<AppVersionMetadata>;
}

function markStreamedPromiseHandled<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => undefined);
	return promise;
}

export async function getAuthenticatedAppShellData(
	user: SessionUser,
): Promise<AppShellData> {
	const conversations = markStreamedPromiseHandled(listConversations(user.id));
	const projects = markStreamedPromiseHandled(listProjects(user.id));
	const appVersion = markStreamedPromiseHandled(getAppVersionMetadata());
	const availableModels = getAvailableModelsWithProviders();
	// Never a network call: `getUploadFormatGate` fails open when the
	// capabilities cache is cold, exactly like every other upload-time read of
	// it. Page render must not wait on a MinerU probe.
	const uploadFormatGate = getUploadFormatGate();
	const [[userRow], availableModelsList, config, gate] = await Promise.all([
		db.select().from(users).where(eq(users.id, user.id)),
		availableModels,
		Promise.resolve(getConfig()),
		uploadFormatGate,
	]);
	const resolvedModelPreference = await resolveUserModelPreference(
		userRow?.preferredModel,
		userRow?.modelPreferenceMode,
		config,
	);
	const modelNames: Record<string, string> = {};
	for (const model of availableModelsList) {
		modelNames[model.id] = model.displayName;
	}

	return {
		user,
		conversations,
		projects,
		maxMessageLength: config.maxMessageLength,
		maxFileUploadSize: config.maxFileUploadSize,
		disabledFileTypeIds: [...gate.disabledEntryIds],
		composerCommandRegistryEnabled: config.composerCommandRegistryEnabled,
		atlasAvailability: getAtlasAvailability(config),
		userTheme: resolveUserTheme(userRow?.theme),
		userModel: resolvedModelPreference.effectiveModel,
		systemDefaultModel: resolvedModelPreference.systemDefaultModel,
		userModelPreference: resolvedModelPreference.preference,
		userTitleLanguage: (userRow?.titleLanguage ?? "auto") as
			| "auto"
			| "en"
			| "hu",
		userUiLanguage: (userRow?.uiLanguage ?? "en") as "en" | "hu",
		userPersonality: userRow?.preferredPersonalityId ?? null,
		userSidebarProjectsExpanded: userRow?.sidebarProjectsExpanded ?? true,
		userSidebarChatsExpanded: userRow?.sidebarChatsExpanded ?? true,
		modelNames,
		availableModels: availableModelsList,
		appVersion,
	};
}
