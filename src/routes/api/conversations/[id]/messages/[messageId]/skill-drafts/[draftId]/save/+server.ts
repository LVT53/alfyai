import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	isAssistantMessageForkCopy,
	SkillDraftTransitionError,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import {
	createUserSkillDefinition,
	deleteUserSkillDefinition,
	getUserSkillDefinition,
	UserSkillValidationError,
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

function validationResponse(error: UserSkillValidationError) {
	return json(
		{ error: error.message, errorKey: error.code },
		{ status: error.status },
	);
}

function transitionConflictResponse(error: SkillDraftTransitionError) {
	return json(
		{ error: error.message, errorKey: error.code },
		{ status: error.status },
	);
}

function inheritedCopyResponse() {
	return json(
		{
			error: "Inherited Skill Drafts on copied fork messages cannot be changed.",
			errorKey: "skillDrafts.inheritedCopyBlocked",
		},
		{ status: 409 },
	);
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
	if (draft.status === "saved" && draft.savedSkillId) {
		return json({ skill: { id: draft.savedSkillId }, draft }, { status: 200 });
	}
	if (draft.status !== "proposed") {
		return transitionConflictResponse(
			new SkillDraftTransitionError(
				"skill_draft_transition_conflict",
				"Skill draft is already in a final state.",
				409,
			),
		);
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
		let updatedDraft: Awaited<
			ReturnType<typeof updateAssistantMessageSkillDraftStatus>
		>;
		try {
			updatedDraft = await updateAssistantMessageSkillDraftStatus({
				conversationId: event.params.id,
				messageId: event.params.messageId,
				draftId: event.params.draftId,
				status: "saved",
				savedSkillId: skill.id,
			});
		} catch (error) {
			if (error instanceof SkillDraftTransitionError) {
				await deleteUserSkillDefinition(user.id, skill.id).catch(() => undefined);
			}
			throw error;
		}

		if (
			updatedDraft?.status === "saved" &&
			updatedDraft.savedSkillId &&
			updatedDraft.savedSkillId !== skill.id
		) {
			await deleteUserSkillDefinition(user.id, skill.id).catch(() => undefined);
			const existingSkill = await getUserSkillDefinition(
				user.id,
				updatedDraft.savedSkillId,
			);
			return json(
				{ skill: existingSkill ?? { id: updatedDraft.savedSkillId }, draft: updatedDraft },
				{ status: 200 },
			);
		}
		if (!updatedDraft) {
			await deleteUserSkillDefinition(user.id, skill.id).catch(() => undefined);
			return json(
				{ error: "Skill draft not found.", errorKey: "skillDrafts.notFound" },
				{ status: 404 },
			);
		}

		return json({ skill, draft: updatedDraft }, { status: 201 });
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		if (error instanceof SkillDraftTransitionError) {
			return transitionConflictResponse(error);
		}
		throw error;
	}
};
