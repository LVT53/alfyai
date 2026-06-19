import { eq } from "drizzle-orm";
import {
	getAvailableModelsWithProviders,
	getConfig,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import type { AppVersionMetadata } from "$lib/server/services/app-version";
import { getAppVersionMetadata } from "$lib/server/services/app-version";
import { getAtlasAvailability } from "$lib/server/services/atlas/availability";
import { listConversations } from "$lib/server/services/conversations";
import { resolveUserModelPreference } from "$lib/server/services/model-preferences";
import { listProjects } from "$lib/server/services/projects";
import type {
	AtlasAvailability,
	ConversationListItem,
	ModelId,
	Project,
	SessionUser,
} from "$lib/types";

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
	composerCommandRegistryEnabled: boolean;
	atlasAvailability: AtlasAvailability;
	userTheme: "system" | "light" | "dark";
	userModel: ModelId;
	systemDefaultModel: ModelId;
	userModelPreference: ModelId | null;
	userTitleLanguage: "auto" | "en" | "hu";
	userUiLanguage: "en" | "hu";
	userPersonality: string | null;
	userAvatarId: number | null;
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
	const [[userRow], availableModelsList, config] = await Promise.all([
		db.select().from(users).where(eq(users.id, user.id)),
		availableModels,
		Promise.resolve(getConfig()),
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
		userAvatarId: userRow?.avatarId ?? null,
		userSidebarProjectsExpanded: userRow?.sidebarProjectsExpanded ?? true,
		userSidebarChatsExpanded: userRow?.sidebarChatsExpanded ?? true,
		modelNames,
		availableModels: availableModelsList,
		appVersion,
	};
}
