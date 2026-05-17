import { redirect } from '@sveltejs/kit';
import type { ServerLoad } from '@sveltejs/kit';
import { listConversations } from '$lib/server/services/conversations';
import { listProjects } from '$lib/server/services/projects';
import {
	getAvailableModelsWithProviders,
	getConfig,
} from '$lib/server/config-store';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { resolveUserModelPreference } from '$lib/server/services/model-preferences';
import { getAppVersionMetadata } from '$lib/server/services/app-version';

export const load: ServerLoad = async (event) => {
	if (!event.locals.user) {
		throw redirect(302, '/login');
	}

	const [conversations, projectsList, [userRow]] = await Promise.all([
		listConversations(event.locals.user.id),
		listProjects(event.locals.user.id),
		db.select().from(users).where(eq(users.id, event.locals.user.id)),
	]);

	const config = getConfig();
	const resolvedModelPreference = await resolveUserModelPreference(
		userRow?.preferredModel,
		userRow?.modelPreferenceMode,
		config,
	);
	const availableModels = await getAvailableModelsWithProviders();
	const modelNames: Record<string, string> = {};
	for (const model of availableModels) {
		modelNames[model.id] = model.displayName;
	}

	return {
		user: event.locals.user,
		conversations,
		projects: projectsList,
		maxMessageLength: config.maxMessageLength,
		deepResearchEnabled: config.deepResearchEnabled,
		composerCommandRegistryEnabled: config.composerCommandRegistryEnabled,
		userTheme: userRow?.theme ?? 'system',
		userModel: resolvedModelPreference.effectiveModel,
		systemDefaultModel: resolvedModelPreference.systemDefaultModel,
		userModelPreference: resolvedModelPreference.preference,
		userTitleLanguage: (userRow?.titleLanguage ?? 'auto') as 'auto' | 'en' | 'hu',
		userUiLanguage: (userRow?.uiLanguage ?? 'en') as 'en' | 'hu',
		userPersonality: userRow?.preferredPersonalityId ?? null,
		userAvatarId: userRow?.avatarId ?? null,
		modelNames,
		availableModels,
		appVersion: getAppVersionMetadata(),
	};
};
