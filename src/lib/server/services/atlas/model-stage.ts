import type { ModelId } from "$lib/types";
import type { AtlasPipelineStage, AtlasProfile } from "./types";

export interface AtlasModelStageUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface AtlasModelStageResult {
	text: string;
	usage: AtlasModelStageUsage;
	model: {
		modelId: string;
		providerId: string;
		displayName: string;
	};
}

export interface AtlasNormalChatModelBoundaryInput {
	modelSelection: ModelId;
	messages: Array<{ role: "user" | "system" | "assistant"; content: string }>;
	system: string;
	maxOutputTokens: number;
}

export interface AtlasNormalChatModelBoundaryResult {
	text: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
	model?: {
		modelId?: string;
		providerId?: string;
		displayName?: string;
	};
}

export interface RunAtlasModelStageInput {
	stage: Exclude<AtlasPipelineStage, "search" | "audit">;
	profile: AtlasProfile;
	modelSelection: ModelId;
	system: string;
	prompt: string;
	runModel?: (
		input: AtlasNormalChatModelBoundaryInput,
	) => Promise<AtlasNormalChatModelBoundaryResult>;
}

export interface RunAtlasAuditStageInput {
	profile: AtlasProfile;
	modelSelection: ModelId;
	prompt: string;
	runModel?: (
		input: AtlasNormalChatModelBoundaryInput,
	) => Promise<AtlasNormalChatModelBoundaryResult>;
}

function profileMaxOutputTokens(profile: AtlasProfile): number {
	switch (profile) {
		case "overview":
			return 1800;
		case "in-depth":
			return 3200;
		case "exhaustive":
			return 5000;
	}
}

async function runNormalChatModelBoundary(
	input: AtlasNormalChatModelBoundaryInput,
): Promise<AtlasNormalChatModelBoundaryResult> {
	const [{ getConfig, normalizeModelSelectionWithProviders }, model] =
		await Promise.all([
			import("$lib/server/config-store"),
			import("$lib/server/services/normal-chat-model"),
		]);
	const runtimeConfig = getConfig();
	const resolvedModelId = await normalizeModelSelectionWithProviders(
		input.modelSelection,
		runtimeConfig,
	);
	const provider = await model.resolveNormalChatModelRunProvider(
		resolvedModelId,
		{
			model1: runtimeConfig.model1,
			model2: runtimeConfig.model2,
		},
	);
	return model.runPlainNormalChatModelRun({
		provider,
		modelId: resolvedModelId,
		messages: input.messages,
		system: input.system,
		maxOutputTokens: input.maxOutputTokens,
	});
}

export async function runAtlasModelStage(
	input: RunAtlasModelStageInput,
): Promise<AtlasModelStageResult> {
	const runModel = input.runModel ?? runNormalChatModelBoundary;
	const result = await runModel({
		modelSelection: input.modelSelection,
		messages: [{ role: "user", content: input.prompt }],
		system: `${input.system}\n\nAtlas stage: ${input.stage}. Profile: ${input.profile}.`,
		maxOutputTokens: profileMaxOutputTokens(input.profile),
	});
	return {
		text: result.text,
		usage: {
			inputTokens: result.usage?.inputTokens ?? 0,
			outputTokens: result.usage?.outputTokens ?? 0,
			totalTokens: result.usage?.totalTokens ?? 0,
			costUsdMicros: 0,
		},
		model: {
			modelId: result.model?.modelId ?? String(input.modelSelection),
			providerId: result.model?.providerId ?? "unknown",
			displayName: result.model?.displayName ?? String(input.modelSelection),
		},
	};
}

export async function runAtlasAuditStage(
	input: RunAtlasAuditStageInput,
): Promise<AtlasModelStageResult> {
	const runModel = input.runModel ?? runNormalChatModelBoundary;
	const result = await runModel({
		modelSelection: input.modelSelection,
		messages: [{ role: "user", content: input.prompt }],
		system:
			"Audit the Atlas report against the provided sources. Return strict JSON only. Do not rewrite the report.",
		maxOutputTokens: 1600,
	});
	return {
		text: result.text,
		usage: {
			inputTokens: result.usage?.inputTokens ?? 0,
			outputTokens: result.usage?.outputTokens ?? 0,
			totalTokens: result.usage?.totalTokens ?? 0,
			costUsdMicros: 0,
		},
		model: {
			modelId: result.model?.modelId ?? String(input.modelSelection),
			providerId: result.model?.providerId ?? "unknown",
			displayName: result.model?.displayName ?? String(input.modelSelection),
		},
	};
}
