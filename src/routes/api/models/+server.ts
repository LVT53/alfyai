import { json } from "@sveltejs/kit";
import { getConfig } from "$lib/server/config-store";
import { getAvailableModelProviderGroups } from "$lib/server/services/available-models";
import { legacyModelIdAliases } from "$lib/server/services/vision/model-vision";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const [providers, modelAliases] = await Promise.all([
		getAvailableModelProviderGroups(getConfig()),
		legacyModelIdAliases(),
	]);
	return json({ providers, modelAliases });
};
