import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import { getAssistantMessageSkillDraft } from "$lib/server/services/messages";
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

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	const user = event.locals.user!;
	const conversation = await getConversation(user.id, event.params.id);
	if (!conversation) {
		return json({ error: "Conversation not found." }, { status: 404 });
	}

	const draft = await getAssistantMessageSkillDraft({
		conversationId: event.params.id,
		messageId: event.params.messageId,
		draftId: event.params.draftId,
	});
	if (!draft) {
		return json(
			{ error: "Skill draft not found.", errorKey: "skillDrafts.notFound" },
			{ status: 404 },
		);
	}

	return json(
		{
			error: "Publishing chat Skill Drafts as System Skills is disabled.",
			errorKey: "skillDrafts.publishDisabled",
			draft,
		},
		{ status: 409 },
	);
};
