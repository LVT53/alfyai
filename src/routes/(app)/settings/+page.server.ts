import type { ServerLoad } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import {
	ADMIN_CONFIG_KEYS,
	getAvailableModelsWithProviders,
	getConfig,
	getEnvDefaults,
	getResolvedAdminConfigValues,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { adminConfig, users } from "$lib/server/db/schema";
import type { UserSettings } from "$lib/server/services/auth-types";
import { resolveUserModelPreference } from "$lib/server/services/model-preferences";
import { getTwoStepStatus } from "$lib/server/services/two-step";

export const load: ServerLoad = async (event) => {
	if (!event.locals.user) throw redirect(302, "/login");

	const [userRow] = await db
		.select()
		.from(users)
		.where(eq(users.id, event.locals.user.id));
	if (!userRow) throw redirect(302, "/login");

	const runtime = getConfig();
	const resolvedModelPreference = await resolveUserModelPreference(
		userRow.preferredModel,
		userRow.modelPreferenceMode,
		runtime,
	);

	const userSettings: UserSettings = {
		id: userRow.id,
		email: userRow.email,
		name: userRow.name,
		role: userRow.role as "user" | "admin",
		preferences: {
			preferredModel: resolvedModelPreference.preference,
			effectiveModel: resolvedModelPreference.effectiveModel,
			systemDefaultModel: resolvedModelPreference.systemDefaultModel,
			theme: (userRow.theme ?? "system") as "system" | "light" | "dark",
			titleLanguage: (userRow.titleLanguage ?? "auto") as "auto" | "en" | "hu",
			uiLanguage: (userRow.uiLanguage ?? "en") as "en" | "hu",
			preferredPersonalityId: userRow.preferredPersonalityId ?? null,
			sidebarProjectsExpanded: userRow.sidebarProjectsExpanded ?? true,
			sidebarChatsExpanded: userRow.sidebarChatsExpanded ?? true,
			memoryEnabled: userRow.memoryEnabled ?? true,
			personalInstructions: userRow.personalInstructions ?? null,
		},
		profilePicture: userRow.profilePicture ?? null,
	};

	// The Account card's row (spec §3.2). A timestamp, not a formatted date:
	// the reader's own language formats it in the browser (R17).
	const twoStepStatus = await getTwoStepStatus(userRow.id);
	const twoStep = {
		enabled: twoStepStatus.enabled,
		since: twoStepStatus.since?.getTime() ?? null,
		backupCodesLeft: twoStepStatus.backupCodesLeft,
	};

	const isAdmin = userRow.role === "admin";
	const availableModels = await getAvailableModelsWithProviders();
	const modelNames: Record<string, string> = {
		model1: runtime.model1.displayName,
		model2: runtime.model2.displayName,
	};
	for (const m of availableModels) {
		modelNames[m.id] = m.displayName;
	}

	if (!isAdmin) {
		return {
			userSettings,
			twoStep,
			modelNames,
			availableModels,
			composerCommandRegistryEnabled: runtime.composerCommandRegistryEnabled,
		};
	}

	// Admin: load config data
	const configRows = await db.select().from(adminConfig);
	const configOverrides: Record<string, string> = Object.fromEntries(
		configRows.map((r) => [r.key, r.value]),
	);

	const envDefaults = getEnvDefaults();
	const currentConfigValues = getResolvedAdminConfigValues(runtime);

	return {
		userSettings,
		twoStep,
		adminConfigKeys: ADMIN_CONFIG_KEYS,
		currentConfigValues,
		configOverrides,
		envDefaults,
		modelNames,
		availableModels,
		composerCommandRegistryEnabled: runtime.composerCommandRegistryEnabled,
	};
};
