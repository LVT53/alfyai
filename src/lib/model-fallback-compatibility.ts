import {
	MODEL_CAPABILITY_KEYS,
	type ModelCapabilityKey,
} from "./model-capabilities";

export type ProviderModelFallbackCompatibilityInput = {
	capabilitiesJson: string;
	reasoningEffort: string | null;
	thinkingType: string | null;
};

export type ProviderModelFallbackCompatibilityResult =
	| { compatible: true }
	| { compatible: false; reason: string };

const REQUIRED_FALLBACK_CAPABILITIES: readonly ModelCapabilityKey[] = [
	"chat",
	"streaming",
];

const CONDITIONAL_FALLBACK_CAPABILITIES: readonly ModelCapabilityKey[] = [
	"tools",
	"structuredOutput",
	"fileMessageParts",
	"imageMessageParts",
];

function parseCapabilityState(value: unknown): boolean | null {
	if (value === true) return true;
	if (value === false) return false;
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		if (value === "detected") return true;
		if (value === "not_detected") return false;
		if (value === "unknown") return null;
		return null;
	}
	if (typeof value !== "object") return null;

	const entry = value as Record<string, unknown>;
	if (typeof entry.supported === "boolean") return entry.supported;
	if (entry.supported === null) return null;
	if (typeof entry.state === "string") {
		if (entry.state === "detected") return true;
		if (entry.state === "not_detected") return false;
		if (entry.state === "unknown") return null;
		if (entry.state === "manual_override") {
			if (typeof entry.supported === "boolean") return entry.supported;
			if (entry.supported === null) return null;
		}
	}

	return null;
}

function parseCapabilitySupportMap(
	json: string,
): Record<ModelCapabilityKey, boolean | null> {
	const empty = Object.fromEntries(
		MODEL_CAPABILITY_KEYS.map((key) => [key, null]),
	) as Record<ModelCapabilityKey, boolean | null>;

	if (!json || json === "{}") return empty;

	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) {
			return empty;
		}

		const record = parsed as Record<string, unknown>;
		for (const key of MODEL_CAPABILITY_KEYS) {
			if (!(key in record)) continue;
			empty[key] = parseCapabilityState(record[key]);
		}
		return empty;
	} catch {
		return empty;
	}
}

function isReasoningControlsEnabled(
	model: Pick<
		ProviderModelFallbackCompatibilityInput,
		"reasoningEffort" | "thinkingType"
	>,
): boolean {
	return model.reasoningEffort !== null || model.thinkingType !== null;
}

function formatCapabilityReason(
	role: "source" | "fallback",
	capability: ModelCapabilityKey,
): string {
	return `${role} model must explicitly support ${capability}`;
}

function formatUnknownSourceCapabilityReason(
	capability: ModelCapabilityKey,
): string {
	return `source model capability ${capability} is unknown; probe or override before choosing a fallback`;
}

export function canUseProviderModelFallback(
	source: ProviderModelFallbackCompatibilityInput,
	fallback: ProviderModelFallbackCompatibilityInput,
): ProviderModelFallbackCompatibilityResult {
	const sourceCapabilities = parseCapabilitySupportMap(source.capabilitiesJson);
	const fallbackCapabilities = parseCapabilitySupportMap(
		fallback.capabilitiesJson,
	);

	for (const capability of REQUIRED_FALLBACK_CAPABILITIES) {
		if (sourceCapabilities[capability] !== true) {
			return {
				compatible: false,
				reason: formatCapabilityReason("source", capability),
			};
		}

		if (fallbackCapabilities[capability] !== true) {
			return {
				compatible: false,
				reason: formatCapabilityReason("fallback", capability),
			};
		}
	}

	for (const capability of CONDITIONAL_FALLBACK_CAPABILITIES) {
		if (sourceCapabilities[capability] === null) {
			return {
				compatible: false,
				reason: formatUnknownSourceCapabilityReason(capability),
			};
		}

		if (sourceCapabilities[capability] === true && fallbackCapabilities[capability] !== true) {
			return {
				compatible: false,
				reason: formatCapabilityReason("fallback", capability),
			};
		}
	}

	if (isReasoningControlsEnabled(source) && fallbackCapabilities.reasoningControls !== true) {
		return {
			compatible: false,
			reason: formatCapabilityReason("fallback", "reasoningControls"),
		};
	}

	return { compatible: true };
}
