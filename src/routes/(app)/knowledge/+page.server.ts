import type { ServerLoad } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { isHonchoEnabled } from "$lib/server/services/honcho";
import { listKnowledgeArtifacts } from "$lib/server/services/knowledge";

export const load: ServerLoad = async (event) => {
	const user = event.locals.user;
	if (!user) {
		throw redirect(302, "/login");
	}
	const knowledge = await listKnowledgeArtifacts(user.id);

	return {
		documents: knowledge.documents,
		honchoEnabled: isHonchoEnabled(),
		userDisplayName: user.displayName,
	};
};
