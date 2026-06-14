import type {
	DepthAppliedProfile,
	DepthMetadata,
	ReasoningDepth,
} from "$lib/types";

export function resolveBaselineDepthProfile(
	reasoningDepth: ReasoningDepth,
): DepthAppliedProfile {
	if (reasoningDepth === "off") return "off";
	if (reasoningDepth === "max") return "maximum";
	return "standard";
}

export function buildBaselineDepthMetadata(params: {
	reasoningDepth?: ReasoningDepth;
	modelId?: string | null;
	modelDisplayName?: string | null;
	providerDisplayName?: string | null;
}): DepthMetadata {
	const requested = params.reasoningDepth ?? "auto";
	const metadata: DepthMetadata = {
		requested,
		appliedProfile: resolveBaselineDepthProfile(requested),
		fallback: false,
	};
	if (params.modelId) metadata.modelId = params.modelId;
	if (params.modelDisplayName)
		metadata.modelDisplayName = params.modelDisplayName;
	if (params.providerDisplayName) {
		metadata.providerDisplayName = params.providerDisplayName;
	}
	return metadata;
}

export function withDepthMetadataModelInfo(
	metadata: DepthMetadata,
	params: {
		modelId?: string | null;
		modelDisplayName?: string | null;
		providerDisplayName?: string | null;
	},
): DepthMetadata {
	const next: DepthMetadata = { ...metadata };
	const modelId = params.modelId ?? metadata.modelId;
	const modelDisplayName = params.modelDisplayName ?? metadata.modelDisplayName;
	const providerDisplayName =
		params.providerDisplayName ?? metadata.providerDisplayName;
	if (modelId) next.modelId = modelId;
	if (modelDisplayName) next.modelDisplayName = modelDisplayName;
	if (providerDisplayName) next.providerDisplayName = providerDisplayName;
	return next;
}
