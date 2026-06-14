import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	discoverSkillSummaries,
	localizeSkillDiscoverySummary,
	seedBuiltInSystemSkillDefinitions,
} from "$lib/server/services/skills/user-skills";
import type { RequestHandler } from "./$types";

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
	const user = event.locals.user;
	await seedBuiltInSystemSkillDefinitions(user.id);
	const skills = await discoverSkillSummaries(user.id, query);
	return json({
		skills: skills.map((skill) =>
			localizeSkillDiscoverySummary(skill, user.uiLanguage),
		),
	});
};
