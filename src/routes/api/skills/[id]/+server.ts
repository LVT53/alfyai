import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	deleteUserSkillDefinition,
	deleteUserSkillVariantDefinition,
	getUserSkillDefinition,
	getUserSkillVariantDefinition,
	type UpdateUserSkillDefinitionInput,
	type UpdateUserSkillVariantDefinitionInput,
	UserSkillValidationError,
	updateUserSkillDefinition,
	updateUserSkillVariantDefinition,
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

function ensureEnabled() {
	return getConfig().composerCommandRegistryEnabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readUpdateInput(body: unknown): UpdateUserSkillDefinitionInput {
	const record = isRecord(body) ? body : {};
	const input: UpdateUserSkillDefinitionInput = {};
	if (typeof record.displayName === "string")
		input.displayName = record.displayName;
	if (typeof record.description === "string")
		input.description = record.description;
	if (typeof record.instructions === "string")
		input.instructions = record.instructions;
	if (Array.isArray(record.activationExamples)) {
		input.activationExamples = record.activationExamples.filter(
			(item): item is string => typeof item === "string",
		);
	}
	if (typeof record.enabled === "boolean") input.enabled = record.enabled;
	if (typeof record.durationPolicy === "string") {
		input.durationPolicy =
			record.durationPolicy as UpdateUserSkillDefinitionInput["durationPolicy"];
	}
	if (typeof record.questionPolicy === "string") {
		input.questionPolicy =
			record.questionPolicy as UpdateUserSkillDefinitionInput["questionPolicy"];
	}
	if (typeof record.notesPolicy === "string") {
		input.notesPolicy =
			record.notesPolicy as UpdateUserSkillDefinitionInput["notesPolicy"];
	}
	if (typeof record.sourceScope === "string") {
		input.sourceScope =
			record.sourceScope as UpdateUserSkillDefinitionInput["sourceScope"];
	}
	if (typeof record.creationSource === "string") {
		input.creationSource =
			record.creationSource as UpdateUserSkillDefinitionInput["creationSource"];
	}
	return input;
}

function readVariantUpdateInput(
	body: unknown,
): UpdateUserSkillVariantDefinitionInput {
	const record = isRecord(body) ? body : {};
	const input: UpdateUserSkillVariantDefinitionInput = {};
	if (typeof record.displayName === "string")
		input.displayName = record.displayName;
	if (typeof record.description === "string")
		input.description = record.description;
	if (typeof record.instructions === "string")
		input.instructions = record.instructions;
	if (Array.isArray(record.activationExamples)) {
		input.activationExamples = record.activationExamples.filter(
			(item): item is string => typeof item === "string",
		);
	}
	if (typeof record.enabled === "boolean") input.enabled = record.enabled;
	if (typeof record.creationSource === "string") {
		input.creationSource =
			record.creationSource as UpdateUserSkillVariantDefinitionInput["creationSource"];
	}
	return input;
}

function validationResponse(error: UserSkillValidationError) {
	return json(
		{ error: error.message, errorKey: error.code },
		{ status: error.status },
	);
}

export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	if (!ensureEnabled()) {
		return disabledResponse();
	}

	const user = event.locals.user;
	const skill = await getUserSkillDefinition(user.id, event.params.id);
	if (!skill) {
		const variant = await getUserSkillVariantDefinition(
			user.id,
			event.params.id,
		);
		if (!variant) {
			return json(
				{ error: "Skill not found.", errorKey: "skills.notFound" },
				{ status: 404 },
			);
		}
		return json({ variant });
	}
	return json({ skill });
};

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);

	if (!ensureEnabled()) {
		return disabledResponse();
	}

	const user = event.locals.user;
	const body = await event.request.json().catch(() => ({}));
	try {
		if (isRecord(body) && body.skillKind === "skill_variant") {
			const variant = await updateUserSkillVariantDefinition(
				user.id,
				event.params.id,
				readVariantUpdateInput(body),
			);
			if (!variant) {
				return json(
					{ error: "Skill not found.", errorKey: "skills.notFound" },
					{ status: 404 },
				);
			}
			return json({ variant });
		}
		const skill = await updateUserSkillDefinition(
			user.id,
			event.params.id,
			readUpdateInput(body),
		);
		if (!skill) {
			return json(
				{ error: "Skill not found.", errorKey: "skills.notFound" },
				{ status: 404 },
			);
		}
		return json({ skill });
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		throw error;
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);

	if (!ensureEnabled()) {
		return disabledResponse();
	}

	const user = event.locals.user;
	const deleted = await deleteUserSkillDefinition(user.id, event.params.id);
	if (
		!deleted &&
		!(await deleteUserSkillVariantDefinition(user.id, event.params.id))
	) {
		return json(
			{ error: "Skill not found.", errorKey: "skills.notFound" },
			{ status: 404 },
		);
	}
	return json({ success: true });
};
