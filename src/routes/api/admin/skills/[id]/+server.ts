import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	getSystemSkillDefinition,
	updateSystemSkillDefinition,
	UserSkillValidationError,
	type UpdateSystemSkillDefinitionInput,
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

function readUpdateInput(body: unknown): UpdateSystemSkillDefinitionInput {
	const record = isRecord(body) ? body : {};
	const input: UpdateSystemSkillDefinitionInput = {};
	if (typeof record.displayName === "string") input.displayName = record.displayName;
	if (typeof record.description === "string") input.description = record.description;
	if (typeof record.instructions === "string") input.instructions = record.instructions;
	if (Array.isArray(record.activationExamples)) {
		input.activationExamples = record.activationExamples.filter(
			(item): item is string => typeof item === "string",
		);
	}
	if (typeof record.enabled === "boolean") input.enabled = record.enabled;
	if (typeof record.published === "boolean") input.published = record.published;
	if (typeof record.durationPolicy === "string") {
		input.durationPolicy = record.durationPolicy as UpdateSystemSkillDefinitionInput["durationPolicy"];
	}
	if (typeof record.questionPolicy === "string") {
		input.questionPolicy = record.questionPolicy as UpdateSystemSkillDefinitionInput["questionPolicy"];
	}
	if (typeof record.notesPolicy === "string") {
		input.notesPolicy = record.notesPolicy as UpdateSystemSkillDefinitionInput["notesPolicy"];
	}
	if (typeof record.sourceScope === "string") {
		input.sourceScope = record.sourceScope as UpdateSystemSkillDefinitionInput["sourceScope"];
	}
	if (typeof record.creationSource === "string") {
		input.creationSource = record.creationSource as UpdateSystemSkillDefinitionInput["creationSource"];
	}
	return input;
}

function validationResponse(error: UserSkillValidationError) {
	return json({ error: error.message, errorKey: error.code }, { status: error.status });
}

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	const skill = await getSystemSkillDefinition(event.params.id);
	if (!skill) {
		return json({ error: "Skill not found.", errorKey: "skills.notFound" }, { status: 404 });
	}
	return json({ skill });
};

export const PATCH: RequestHandler = async (event) => {
	requireAdmin(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	const body = await event.request.json().catch(() => ({}));
	try {
		const skill = await updateSystemSkillDefinition(event.params.id, readUpdateInput(body));
		if (!skill) {
			return json({ error: "Skill not found.", errorKey: "skills.notFound" }, { status: 404 });
		}
		return json({ skill });
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		throw error;
	}
};
