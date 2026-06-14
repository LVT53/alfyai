import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getComposerCommandRegistryShell } from "$lib/server/services/skills/composer-command-registry";
import type { RequestHandler } from "./$types";

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
