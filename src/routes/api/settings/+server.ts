import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { resolveUserModelPreference } from "$lib/server/services/model-preferences";
import type { UserSettings } from "$lib/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const currentUser = event.locals.user;
	const userId = currentUser.id;

	const [userRow] = await db.select().from(users).where(eq(users.id, userId));
	if (!userRow) {
		return json({ error: "User not found" }, { status: 404 });
	}

	const resolvedModelPreference = await resolveUserModelPreference(
		userRow.preferredModel,
		userRow.modelPreferenceMode,
		getConfig(),
	);

	const settings: UserSettings = {
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
			avatarId: userRow.avatarId ?? null,
			preferredPersonalityId: userRow.preferredPersonalityId ?? null,
			sidebarProjectsExpanded: userRow.sidebarProjectsExpanded ?? true,
			sidebarChatsExpanded: userRow.sidebarChatsExpanded ?? true,
			memoryEnabled: userRow.memoryEnabled ?? true,
		},
		profilePicture: userRow.profilePicture ?? null,
	};

	return json(settings);
};
