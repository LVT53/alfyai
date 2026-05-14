import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import {
	createSystemSkillDefinition,
	updateSystemSkillDefinition,
	UserSkillValidationError,
	type CreateSystemSkillDefinitionInput,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validationResponse(error: UserSkillValidationError) {
	return json({ error: error.message, errorKey: error.code }, { status: error.status });
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
		return json({ error: "Skill draft not found.", errorKey: "skillDrafts.notFound" }, { status: 404 });
	}

	const body = await event.request.json().catch(() => ({}));
	const systemSkillId = isRecord(body) && typeof body.systemSkillId === "string"
		? body.systemSkillId.trim()
		: "";
	const input: CreateSystemSkillDefinitionInput = {
		displayName: draft.displayName,
		description: draft.description,
		instructions: draft.instructions,
		activationExamples: draft.activationExamples,
		enabled: true,
		published: true,
		durationPolicy: draft.durationPolicy,
		questionPolicy: draft.questionPolicy,
		notesPolicy: draft.notesPolicy,
		sourceScope: draft.sourceScope,
		creationSource: "ai_draft",
	};

	try {
		const systemSkill = systemSkillId
			? await updateSystemSkillDefinition(systemSkillId, input)
			: await createSystemSkillDefinition(user.id, input);
		if (!systemSkill) {
			return json({ error: "Skill not found.", errorKey: "skills.notFound" }, { status: 404 });
		}

		const updatedDraft = await updateAssistantMessageSkillDraftStatus({
			conversationId: event.params.id,
			messageId: event.params.messageId,
			draftId: event.params.draftId,
			status: "published",
			publishedSystemSkillId: systemSkill.id,
		});

		return json(
			{ systemSkill, draft: updatedDraft },
			{ status: systemSkillId ? 200 : 201 },
		);
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		throw error;
	}
};
