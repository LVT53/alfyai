import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getConfig } from "$lib/server/config-store";
import { requireAuth } from "$lib/server/auth/hooks";
import { getComposerCommandRegistryShell } from "$lib/server/services/skills/composer-command-registry";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return json(
			{
				error: "Composer Command Registry is disabled.",
				errorKey: "composerCommandRegistry.disabled",
			},
			{ status: 404 },
		);
	}

	return json({ registry: getComposerCommandRegistryShell() });
};
