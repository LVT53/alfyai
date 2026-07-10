import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getAvailableModelsWithProviders,
	getConfig,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	modelPreferenceStorageForExplicitChoice,
	modelPreferenceStorageForSystemDefault,
} from "$lib/server/services/model-preferences";
import type { ModelId } from "$lib/types";
import type { RequestHandler } from "./$types";

const VALID_THEMES = ["system", "light", "dark"];
const VALID_TITLE_LANGUAGES = ["auto", "en", "hu"];
const VALID_UI_LANGUAGES = ["en", "hu"];

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user?.id;

	let body: {
		preferredModel?: unknown;
		theme?: unknown;
		titleLanguage?: unknown;
		uiLanguage?: unknown;
		preferredPersonalityId?: unknown;
		sidebarProjectsExpanded?: unknown;
		sidebarChatsExpanded?: unknown;
		memoryEnabled?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };

	if (body.preferredModel !== undefined) {
		if (body.preferredModel === null) {
			Object.assign(
				updates,
				await modelPreferenceStorageForSystemDefault(getConfig()),
			);
		} else {
			const validModels = new Set(
				(await getAvailableModelsWithProviders()).map((model) => model.id),
			);
			if (!validModels.has(body.preferredModel as ModelId)) {
				return json({ error: "Invalid preferredModel" }, { status: 400 });
			}
			Object.assign(
				updates,
				await modelPreferenceStorageForExplicitChoice(
					body.preferredModel as ModelId,
					getConfig(),
				),
			);
		}
	}

	if (body.theme !== undefined) {
		if (!VALID_THEMES.includes(body.theme as string)) {
			return json({ error: "Invalid theme" }, { status: 400 });
		}
		updates.theme = body.theme;
	}

	if (body.titleLanguage !== undefined) {
		if (!VALID_TITLE_LANGUAGES.includes(body.titleLanguage as string)) {
			return json({ error: "Invalid titleLanguage" }, { status: 400 });
		}
		updates.titleLanguage = body.titleLanguage;
	}

	if (body.uiLanguage !== undefined) {
		if (!VALID_UI_LANGUAGES.includes(body.uiLanguage as string)) {
			return json({ error: "Invalid uiLanguage" }, { status: 400 });
		}
		updates.uiLanguage = body.uiLanguage;
	}

	if (body.preferredPersonalityId !== undefined) {
		updates.preferredPersonalityId =
			body.preferredPersonalityId === null
				? null
				: String(body.preferredPersonalityId);
	}

	if (body.sidebarProjectsExpanded !== undefined) {
		updates.sidebarProjectsExpanded = Boolean(body.sidebarProjectsExpanded);
	}

	if (body.sidebarChatsExpanded !== undefined) {
		updates.sidebarChatsExpanded = Boolean(body.sidebarChatsExpanded);
	}

	if (body.memoryEnabled !== undefined) {
		updates.memoryEnabled = Boolean(body.memoryEnabled);
	}

	await db.update(users).set(updates).where(eq(users.id, userId));

	return json({ success: true });
};
