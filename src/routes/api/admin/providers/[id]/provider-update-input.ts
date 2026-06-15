import type { UpdateProviderInput } from "$lib/server/services/providers";

type ParsedProviderUpdateInput = {
	input: UpdateProviderInput;
	error?: string;
};

type ParsedField<T> = {
	value?: T;
	error?: string;
};

type StringField = "displayName" | "baseUrl" | "apiKey";
type NumberField = "rateLimitFallbackTimeoutMs" | "sortOrder";
type BooleanField = "rateLimitFallbackEnabled" | "enabled";

function parseOptionalStringField(
	body: Record<string, unknown>,
	field: StringField,
	errorMessage: string,
	options: { trim?: boolean } = {},
): ParsedField<string> {
	const value = body[field];
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "string") {
		return { error: errorMessage };
	}

	const parsedValue = options.trim ? value.trim() : value;
	return { value: parsedValue };
}

function parseOptionalNullableTrimmedStringField(
	body: Record<string, unknown>,
	field: keyof Pick<
		UpdateProviderInput,
		| "iconAssetId"
		| "processingRegionCode"
		| "privacyPolicyUrl"
		| "rateLimitFallbackBaseUrl"
		| "rateLimitFallbackModelName"
	>,
): ParsedField<string | null> {
	const value = body[field];
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "string") {
		return { value: null };
	}
	const trimmed = value.trim();
	return { value: trimmed.length > 0 ? trimmed : null };
}

function parseOptionalNullableStringField(
	body: Record<string, unknown>,
	field: keyof Pick<UpdateProviderInput, "rateLimitFallbackApiKey">,
): ParsedField<string | null> {
	const value = body[field];
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "string") {
		return { value: null };
	}
	return { value };
}

function parseOptionalBooleanField(
	body: Record<string, unknown>,
	field: BooleanField,
	errorMessage: string,
): ParsedField<boolean> {
	const value = body[field];
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "boolean") {
		return { error: errorMessage };
	}
	return { value };
}

function parseOptionalNonNegativeNumberField(
	body: Record<string, unknown>,
	field: NumberField,
	errorMessage: string,
): ParsedField<number> {
	const value = body[field];
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "number" || value < 0) {
		return { error: errorMessage };
	}
	return { value };
}

function parseOptionalNumberField(
	body: Record<string, unknown>,
	field: NumberField,
	errorMessage: string,
): ParsedField<number> {
	const value = body[field];
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "number") {
		return { error: errorMessage };
	}
	return { value };
}

function applyParsedField<T>(
	parsed: ParsedField<T>,
	assign: (value: T) => void,
): string | undefined {
	if (parsed.error) {
		return parsed.error;
	}
	if (parsed.value !== undefined) {
		assign(parsed.value);
	}
	return undefined;
}

export function buildProviderUpdateInput(
	body: Record<string, unknown>,
): ParsedProviderUpdateInput {
	const input: UpdateProviderInput = {};

	const parseSteps: Array<() => string | undefined> = [
		() =>
			applyParsedField(
				parseOptionalStringField(
					body,
					"displayName",
					"displayName must be a string",
					{ trim: true },
				),
				(value) => {
					input.displayName = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalStringField(body, "baseUrl", "baseUrl must be a string", {
					trim: true,
				}),
				(value) => {
					input.baseUrl = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalStringField(body, "apiKey", "apiKey must be a string"),
				(value) => {
					input.apiKey = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNullableTrimmedStringField(body, "iconAssetId"),
				(value) => {
					input.iconAssetId = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNullableTrimmedStringField(body, "processingRegionCode"),
				(value) => {
					input.processingRegionCode = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNullableTrimmedStringField(body, "privacyPolicyUrl"),
				(value) => {
					input.privacyPolicyUrl = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalBooleanField(
					body,
					"rateLimitFallbackEnabled",
					"rateLimitFallbackEnabled must be a boolean",
				),
				(value) => {
					input.rateLimitFallbackEnabled = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNullableTrimmedStringField(
					body,
					"rateLimitFallbackBaseUrl",
				),
				(value) => {
					input.rateLimitFallbackBaseUrl = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNullableStringField(body, "rateLimitFallbackApiKey"),
				(value) => {
					input.rateLimitFallbackApiKey = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNullableTrimmedStringField(
					body,
					"rateLimitFallbackModelName",
				),
				(value) => {
					input.rateLimitFallbackModelName = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNonNegativeNumberField(
					body,
					"rateLimitFallbackTimeoutMs",
					"rateLimitFallbackTimeoutMs must be a non-negative number",
				),
				(value) => {
					input.rateLimitFallbackTimeoutMs = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalNumberField(
					body,
					"sortOrder",
					"sortOrder must be a number",
				),
				(value) => {
					input.sortOrder = value;
				},
			),
		() =>
			applyParsedField(
				parseOptionalBooleanField(body, "enabled", "enabled must be a boolean"),
				(value) => {
					input.enabled = value;
				},
			),
	];

	for (const parseStep of parseSteps) {
		const error = parseStep();
		if (error) {
			return { input: {}, error };
		}
	}

	return { input };
}
