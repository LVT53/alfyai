import { redirect } from '@sveltejs/kit';
import type { ServerLoad } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, adminConfig } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
  getAvailableModelsWithProviders,
  getEnvDefaults,
  ADMIN_CONFIG_KEYS,
  getResolvedAdminConfigValues,
  getConfig,
} from '$lib/server/config-store';
import type { UserSettings } from '$lib/types';
import { resolveUserModelPreference } from '$lib/server/services/model-preferences';

export const load: ServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login');

  const [userRow] = await db.select().from(users).where(eq(users.id, event.locals.user.id));
  if (!userRow) throw redirect(302, '/login');

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
    role: userRow.role as 'user' | 'admin',
    preferences: {
      preferredModel: resolvedModelPreference.preference,
      effectiveModel: resolvedModelPreference.effectiveModel,
      systemDefaultModel: resolvedModelPreference.systemDefaultModel,
      theme: (userRow.theme ?? 'system') as 'system' | 'light' | 'dark',
      titleLanguage: (userRow.titleLanguage ?? 'auto') as 'auto' | 'en' | 'hu',
      uiLanguage: (userRow.uiLanguage ?? 'en') as 'en' | 'hu',
      avatarId: userRow.avatarId ?? null,
      preferredPersonalityId: userRow.preferredPersonalityId ?? null,
    },
    profilePicture: userRow.profilePicture ?? null,
  };

  const isAdmin = userRow.role === 'admin';
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
      modelNames,
      availableModels,
      composerCommandRegistryEnabled: runtime.composerCommandRegistryEnabled,
    };
  }

  // Admin: load config data
  const configRows = await db.select().from(adminConfig);
  const configOverrides: Record<string, string> = Object.fromEntries(
    configRows.map((r) => [r.key, r.value])
  );

  const envDefaults = getEnvDefaults();
  const currentConfigValues = getResolvedAdminConfigValues(runtime);

  return {
    userSettings,
    adminConfigKeys: ADMIN_CONFIG_KEYS,
    currentConfigValues,
    configOverrides,
		envDefaults,
		modelNames,
		availableModels,
		composerCommandRegistryEnabled: runtime.composerCommandRegistryEnabled,
  };
};
