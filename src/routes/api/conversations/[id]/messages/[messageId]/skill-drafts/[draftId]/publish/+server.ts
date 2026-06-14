import { json } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	isAssistantMessageForkCopy,
} from "$lib/server/services/messages";
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

function inheritedCopyResponse() {
	return json(
		{
			error:
				"Inherited Skill Drafts on copied fork messages cannot be changed.",
			errorKey: "skillDrafts.inheritedCopyBlocked",
		},
		{ status: 409 },
	);
}

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	const user = event.locals.user;
	const conversation = await getConversation(user.id, event.params.id);
	if (!conversation) {
		return json({ error: "Conversation not found." }, { status: 404 });
	}

	if (
		await isAssistantMessageForkCopy({
			conversationId: event.params.id,
			messageId: event.params.messageId,
		})
	) {
		return inheritedCopyResponse();
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
			error: "Publishing chat Skill Drafts as admin-wide Skills is disabled.",
			errorKey: "skillDrafts.publishDisabled",
			draft,
		},
		{ status: 409 },
	);
};
