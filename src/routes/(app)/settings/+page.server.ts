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
  normalizeModelSelectionWithProviders
} from '$lib/server/config-store';
import type { UserSettings } from '$lib/types';

export const load: ServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login');

  const [userRow] = await db.select().from(users).where(eq(users.id, event.locals.user.id));
  if (!userRow) throw redirect(302, '/login');

  const userSettings: UserSettings = {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role as 'user' | 'admin',
    preferences: {
      preferredModel: await normalizeModelSelectionWithProviders(userRow.preferredModel ?? 'model1'),
      theme: (userRow.theme ?? 'system') as 'system' | 'light' | 'dark',
      titleLanguage: (userRow.titleLanguage ?? 'auto') as 'auto' | 'en' | 'hu',
      uiLanguage: (userRow.uiLanguage ?? 'en') as 'en' | 'hu',
      avatarId: userRow.avatarId ?? null,
      preferredPersonalityId: userRow.preferredPersonalityId ?? null,
    },
    profilePicture: userRow.profilePicture ?? null,
  };

  const isAdmin = userRow.role === 'admin';
  const runtime = getConfig();

  if (!isAdmin) {
    return { userSettings, composerCommandRegistryEnabled: runtime.composerCommandRegistryEnabled };
  }

  // Admin: load config data
  const configRows = await db.select().from(adminConfig);
  const configOverrides: Record<string, string> = Object.fromEntries(
    configRows.map((r) => [r.key, r.value])
  );

  const envDefaults = getEnvDefaults();
  const currentConfigValues = getResolvedAdminConfigValues(runtime);

	const availableModels = await getAvailableModelsWithProviders();
	const modelNames: Record<string, string> = {
		model1: runtime.model1.displayName,
		model2: runtime.model2.displayName,
	};
	for (const m of availableModels) {
		modelNames[m.id] = m.displayName;
	}

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
