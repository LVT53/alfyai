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
	const userId = event.locals.user?.id;

	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) {
		return json({ error: "User not found" }, { status: 404 });
	}

	const resolvedModelPreference = await resolveUserModelPreference(
		user.preferredModel,
		user.modelPreferenceMode,
		getConfig(),
	);

	const settings: UserSettings = {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role as "user" | "admin",
		preferences: {
			preferredModel: resolvedModelPreference.preference,
			effectiveModel: resolvedModelPreference.effectiveModel,
			systemDefaultModel: resolvedModelPreference.systemDefaultModel,
			theme: (user.theme ?? "system") as "system" | "light" | "dark",
			titleLanguage: (user.titleLanguage ?? "auto") as "auto" | "en" | "hu",
			uiLanguage: (user.uiLanguage ?? "en") as "en" | "hu",
			avatarId: user.avatarId ?? null,
			preferredPersonalityId: user.preferredPersonalityId ?? null,
		},
		profilePicture: user.profilePicture ?? null,
	};

	return json(settings);
};
