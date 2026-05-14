import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { discoverSkillSummaries } from "$lib/server/services/skills/user-skills";

function disabledResponse() {
	return json(
		{
			error: "Composer Command Registry is disabled.",
			errorKey: "composerCommandRegistry.disabled",
		},
		{ status: 404 },
	);
}

export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	const query = event.url.searchParams.get("q") ?? "";
	const skills = await discoverSkillSummaries(event.locals.user!.id, query);
	return json({ skills });
};
