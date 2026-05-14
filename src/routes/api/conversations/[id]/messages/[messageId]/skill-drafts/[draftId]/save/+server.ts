import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import {
	createUserSkillDefinition,
	UserSkillValidationError,
} from "$lib/server/services/skills/user-skills";

function disabledResponse() {
	return json(
		{
			error: "Composer Command Registry is disabled.",
			errorKey: "composerCommandRegistry.disabled",
		},
		{ status: 404 },
	);
}

function validationResponse(error: UserSkillValidationError) {
	return json({ error: error.message, errorKey: error.code }, { status: error.status });
}

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

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
		return json({ error: "Skill draft not found.", errorKey: "skillDrafts.notFound" }, { status: 404 });
	}

	try {
		const skill = await createUserSkillDefinition(user.id, {
			displayName: draft.displayName,
			description: draft.description,
			instructions: draft.instructions,
			activationExamples: draft.activationExamples,
			enabled: false,
			durationPolicy: draft.durationPolicy,
			questionPolicy: draft.questionPolicy,
			notesPolicy: draft.notesPolicy,
			sourceScope: draft.sourceScope,
			creationSource: "ai_draft",
		});
		const updatedDraft = await updateAssistantMessageSkillDraftStatus({
			conversationId: event.params.id,
			messageId: event.params.messageId,
			draftId: event.params.draftId,
			status: "saved",
			savedSkillId: skill.id,
		});

		return json({ skill, draft: updatedDraft }, { status: 201 });
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		throw error;
	}
};
