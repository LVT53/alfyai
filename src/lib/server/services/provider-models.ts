import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canUseProviderModelFallback } from "$lib/model-fallback-compatibility";
import { db } from "../db";
import { providerModels, providers } from "../db/schema";
import { resolveProviderModelPersistenceDefaults } from "./provider-model-runtime-defaults";

type ProviderModelRow = typeof providerModels.$inferSelect;

export interface ProviderModel {
	id: string;
	providerId: string;
	name: string;
	displayName: string;
	iconAssetId: string | null;
	guideNoteEn: string | null;
	guideNoteHu: string | null;
	guideBadge: "intelligent" | "fast" | null;
	fallbackProviderModelId: string | null;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxMessageLength: number | null;
	maxTokens: number | null;
	reasoningEffort: "low" | "medium" | "high" | "max" | "xhigh" | null;
	thinkingType: "enabled" | "disabled" | null;
	capabilitiesJson: string;
	inputUsdMicrosPer1m: number;
	cachedInputUsdMicrosPer1m: number;
	cacheHitUsdMicrosPer1m: number;
	cacheMissUsdMicrosPer1m: number;
	outputUsdMicrosPer1m: number;
	enabled: boolean;
	sortOrder: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface CreateProviderModelInput {
	providerId: string;
	name: string;
	displayName?: string;
	iconAssetId?: string | null;
	guideNoteEn?: string | null;
	guideNoteHu?: string | null;
	guideBadge?: "intelligent" | "fast" | null;
	fallbackProviderModelId?: string | null;
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
	reasoningEffort?: "low" | "medium" | "high" | "max" | "xhigh" | null;
	thinkingType?: "enabled" | "disabled" | null;
	capabilitiesJson?: string | null;
	inputUsdMicrosPer1m?: number;
	cachedInputUsdMicrosPer1m?: number;
	cacheHitUsdMicrosPer1m?: number;
	cacheMissUsdMicrosPer1m?: number;
	outputUsdMicrosPer1m?: number;
	enabled?: boolean;
	sortOrder?: number;
}

export interface UpdateProviderModelInput {
	displayName?: string;
	iconAssetId?: string | null;
	guideNoteEn?: string | null;
	guideNoteHu?: string | null;
	guideBadge?: "intelligent" | "fast" | null;
	fallbackProviderModelId?: string | null;
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
	reasoningEffort?: "low" | "medium" | "high" | "max" | "xhigh" | null;
	thinkingType?: "enabled" | "disabled" | null;
	capabilitiesJson?: string;
	inputUsdMicrosPer1m?: number;
	cachedInputUsdMicrosPer1m?: number;
	cacheHitUsdMicrosPer1m?: number;
	cacheMissUsdMicrosPer1m?: number;
	outputUsdMicrosPer1m?: number;
	enabled?: boolean;
	sortOrder?: number;
}

export class ProviderModelValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderModelValidationError";
	}
}

type ProviderModelBody = Record<string, unknown>;
type ReasoningEffort = NonNullable<CreateProviderModelInput["reasoningEffort"]>;
type ThinkingType = NonNullable<CreateProviderModelInput["thinkingType"]>;
type ModelGuideBadge = NonNullable<CreateProviderModelInput["guideBadge"]>;
type ProviderModelPayloadFields = Partial<{
	displayName: string;
	iconAssetId: string | null;
	guideNoteEn: string | null;
	guideNoteHu: string | null;
	guideBadge: ModelGuideBadge | null;
	fallbackProviderModelId: string | null;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxMessageLength: number | null;
	maxTokens: number | null;
	reasoningEffort: ReasoningEffort | null;
	thinkingType: ThinkingType | null;
	capabilitiesJson: string | null;
	inputUsdMicrosPer1m: number;
	cachedInputUsdMicrosPer1m: number;
	cacheHitUsdMicrosPer1m: number;
	cacheMissUsdMicrosPer1m: number;
	outputUsdMicrosPer1m: number;
	enabled: boolean;
	sortOrder: number;
}>;

const nullableNonNegativeNumberFields = [
	"maxModelContext",
	"compactionUiThreshold",
	"targetConstructedContext",
	"maxMessageLength",
	"maxTokens",
] as const;

const pricingFields = [
	"inputUsdMicrosPer1m",
	"cachedInputUsdMicrosPer1m",
	"cacheHitUsdMicrosPer1m",
	"cacheMissUsdMicrosPer1m",
	"outputUsdMicrosPer1m",
] as const;

const GUIDE_NOTE_MAX_LENGTH = 180;
const GUIDE_BADGES = new Set<ModelGuideBadge>(["intelligent", "fast"]);

function objectBody(payload: unknown): ProviderModelBody {
	return payload !== null &&
		typeof payload === "object" &&
		!Array.isArray(payload)
		? (payload as ProviderModelBody)
		: {};
}

function readNonNegativeNumber(
	body: ProviderModelBody,
	key: string,
	errorSuffix = "must be a non-negative number",
): number | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || value < 0) {
		throw new ProviderModelValidationError(`${key} ${errorSuffix}`);
	}
	return value;
}

function readOptionalString(
	body: ProviderModelBody,
	key: string,
): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ProviderModelValidationError(`${key} must be a string`);
	}
	return value.trim();
}

function readOptionalRuntimeString<T extends string>(
	body: ProviderModelBody,
	key: string,
): T | null | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new ProviderModelValidationError(`${key} must be a string`);
	}
	return (value || null) as T | null;
}

function readOptionalBoolean(
	body: ProviderModelBody,
	key: string,
): boolean | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new ProviderModelValidationError(`${key} must be a boolean`);
	}
	return value;
}

function readOptionalNumber(
	body: ProviderModelBody,
	key: string,
): number | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number") {
		throw new ProviderModelValidationError(`${key} must be a number`);
	}
	return value;
}

function readNullableNonNegativeNumber(
	body: ProviderModelBody,
	key: string,
): number | null | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "number" || value < 0) {
		throw new ProviderModelValidationError(
			`${key} must be a non-negative number or null`,
		);
	}
	return value;
}

function readNullableString(
	body: ProviderModelBody,
	key: string,
	errorSuffix = "must be a string or null",
): string | null | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new ProviderModelValidationError(`${key} ${errorSuffix}`);
	}
	return value.trim();
}

function readGuideNote(
	body: ProviderModelBody,
	key: "guideNoteEn" | "guideNoteHu",
): string | null | undefined {
	const value = readNullableString(body, key);
	if (value === undefined || value === null) return value;
	if (value.length > GUIDE_NOTE_MAX_LENGTH) {
		throw new ProviderModelValidationError(
			`${key} must be ${GUIDE_NOTE_MAX_LENGTH} characters or fewer`,
		);
	}
	return value.length > 0 ? value : null;
}

function readGuideBadge(
	body: ProviderModelBody,
): ModelGuideBadge | null | undefined {
	const value = body.guideBadge;
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	if (typeof value !== "string" || !GUIDE_BADGES.has(value as ModelGuideBadge)) {
		throw new ProviderModelValidationError(
			"guideBadge must be intelligent, fast, or null",
		);
	}
	return value as ModelGuideBadge;
}

function assignParsedValue<K extends keyof ProviderModelPayloadFields>(
	input: ProviderModelPayloadFields,
	key: K,
	value: ProviderModelPayloadFields[K] | undefined,
): void {
	if (value !== undefined) input[key] = value;
}

function applyNullableNonNegativeNumberField(
	input: ProviderModelPayloadFields,
	body: ProviderModelBody,
	key: (typeof nullableNonNegativeNumberFields)[number],
): void {
	assignParsedValue(input, key, readNullableNonNegativeNumber(body, key));
}

function applyNonNegativeNumberField(
	input: ProviderModelPayloadFields,
	body: ProviderModelBody,
	key: (typeof pricingFields)[number],
): void {
	assignParsedValue(input, key, readNonNegativeNumber(body, key));
}

function applyProviderModelPayloadFields(
	input: ProviderModelPayloadFields,
	body: ProviderModelBody,
	capabilitiesJsonFallback: string | null,
	allowIconAssetId: boolean,
): void {
	assignParsedValue(
		input,
		"displayName",
		readOptionalString(body, "displayName"),
	);
	if (allowIconAssetId) {
		assignParsedValue(
			input,
			"iconAssetId",
			readNullableString(body, "iconAssetId"),
		);
	}
	assignParsedValue(input, "guideNoteEn", readGuideNote(body, "guideNoteEn"));
	assignParsedValue(input, "guideNoteHu", readGuideNote(body, "guideNoteHu"));
	assignParsedValue(input, "guideBadge", readGuideBadge(body));
	const fallbackProviderModelId = readNullableString(
		body,
		"fallbackProviderModelId",
	);
	if (fallbackProviderModelId !== undefined) {
		input.fallbackProviderModelId = fallbackProviderModelId || null;
	}

	for (const key of nullableNonNegativeNumberFields) {
		applyNullableNonNegativeNumberField(input, body, key);
	}

	assignParsedValue(
		input,
		"reasoningEffort",
		readOptionalRuntimeString<ReasoningEffort>(body, "reasoningEffort"),
	);
	assignParsedValue(
		input,
		"thinkingType",
		readOptionalRuntimeString<ThinkingType>(body, "thinkingType"),
	);

	const capabilitiesJson = body.capabilitiesJson;
	if (capabilitiesJson !== undefined) {
		if (capabilitiesJson !== null && typeof capabilitiesJson !== "string") {
			throw new ProviderModelValidationError(
				"capabilitiesJson must be a string or null",
			);
		}
		input.capabilitiesJson = capabilitiesJson || capabilitiesJsonFallback;
	}

	for (const key of pricingFields) {
		applyNonNegativeNumberField(input, body, key);
	}

	assignParsedValue(input, "enabled", readOptionalBoolean(body, "enabled"));
	assignParsedValue(input, "sortOrder", readOptionalNumber(body, "sortOrder"));
}

export function parseCreateProviderModelPayload(
	providerId: string,
	payload: unknown,
): CreateProviderModelInput {
	const body = objectBody(payload);
	const name = typeof body.name === "string" ? body.name.trim() : "";

	if (!name) {
		throw new ProviderModelValidationError("name is required");
	}

	const input: CreateProviderModelInput = {
		providerId,
		name,
	};
	applyProviderModelPayloadFields(input, body, null, false);

	return input;
}

export function parseUpdateProviderModelPayload(
	payload: unknown,
): UpdateProviderModelInput {
	const body = objectBody(payload);
	const input: UpdateProviderModelInput = {};
	applyProviderModelPayloadFields(input, body, "{}", true);

	return input;
}

function mapRowToModel(row: ProviderModelRow): ProviderModel {
	return {
		id: row.id,
		providerId: row.providerId,
		name: row.name,
		displayName: row.displayName,
		iconAssetId: row.iconAssetId ?? null,
		guideNoteEn: row.guideNoteEn ?? null,
		guideNoteHu: row.guideNoteHu ?? null,
		guideBadge: row.guideBadge ?? null,
		fallbackProviderModelId: row.fallbackProviderModelId ?? null,
		maxModelContext: row.maxModelContext ?? null,
		compactionUiThreshold: row.compactionUiThreshold ?? null,
		targetConstructedContext: row.targetConstructedContext ?? null,
		maxMessageLength: row.maxMessageLength ?? null,
		maxTokens: row.maxTokens ?? null,
		reasoningEffort: row.reasoningEffort ?? null,
		thinkingType: row.thinkingType ?? null,
		capabilitiesJson: row.capabilitiesJson ?? "{}",
		inputUsdMicrosPer1m: row.inputUsdMicrosPer1m,
		cachedInputUsdMicrosPer1m: row.cachedInputUsdMicrosPer1m,
		cacheHitUsdMicrosPer1m: row.cacheHitUsdMicrosPer1m,
		cacheMissUsdMicrosPer1m: row.cacheMissUsdMicrosPer1m,
		outputUsdMicrosPer1m: row.outputUsdMicrosPer1m,
		enabled: row.enabled === 1,
		sortOrder: row.sortOrder,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

type ProviderModelCompatibilityFields = Pick<
	ProviderModel,
	"capabilitiesJson" | "reasoningEffort" | "thinkingType"
>;

function buildFallbackCompatibilityInput(
	model: ProviderModelCompatibilityFields,
): {
	capabilitiesJson: string;
	reasoningEffort: string | null;
	thinkingType: string | null;
} {
	return {
		capabilitiesJson: model.capabilitiesJson || "{}",
		reasoningEffort: model.reasoningEffort,
		thinkingType: model.thinkingType,
	};
}

function assertFallbackCompatibility(
	source: ProviderModelCompatibilityFields,
	fallback: ProviderModelCompatibilityFields,
): void {
	const result = canUseProviderModelFallback(
		buildFallbackCompatibilityInput(source),
		buildFallbackCompatibilityInput(fallback),
	);

	if (!result.compatible) {
		throw new ProviderModelValidationError(result.reason);
	}
}

async function getProviderModelRowById(
	id: string,
): Promise<ProviderModelRow | null> {
	const [row] = await db
		.select()
		.from(providerModels)
		.where(eq(providerModels.id, id));
	return row ?? null;
}

async function getProviderModelRowsReferencingFallbackModel(
	id: string,
): Promise<ProviderModelRow[]> {
	return db
		.select()
		.from(providerModels)
		.where(eq(providerModels.fallbackProviderModelId, id));
}

async function validateModelFallbackConfiguration(params: {
	source: ProviderModelCompatibilityFields;
	fallbackProviderModelId: string | null | undefined;
	sourceId?: string;
	requireEnabledFallback?: boolean;
}): Promise<void> {
	const fallbackProviderModelId = params.fallbackProviderModelId ?? null;
	if (!fallbackProviderModelId) return;

	if (params.sourceId && fallbackProviderModelId === params.sourceId) {
		throw new ProviderModelValidationError(
			"fallbackProviderModelId cannot reference the model itself",
		);
	}

	const fallback = await getProviderModelRowById(fallbackProviderModelId);
	if (!fallback) {
		throw new ProviderModelValidationError(
			"fallbackProviderModelId must reference an existing provider model",
		);
	}

	if (params.requireEnabledFallback && !fallback.enabled) {
		throw new ProviderModelValidationError(
			"fallbackProviderModelId must reference an enabled provider model",
		);
	}

	assertFallbackCompatibility(params.source, fallback);
}

async function providerExists(providerId: string): Promise<boolean> {
	const [existing] = await db
		.select({ id: providers.id })
		.from(providers)
		.where(eq(providers.id, providerId));
	return existing !== undefined;
}

export async function createProviderModel(
	input: CreateProviderModelInput,
): Promise<ProviderModel> {
	if (!(await providerExists(input.providerId))) {
		throw new Error(`Provider with id "${input.providerId}" does not exist`);
	}

	const now = new Date();
	const displayName = input.displayName ?? input.name;
	const persistenceDefaults = resolveProviderModelPersistenceDefaults(input);
	await validateModelFallbackConfiguration({
		source: {
			capabilitiesJson: input.capabilitiesJson ?? "{}",
			reasoningEffort: persistenceDefaults.reasoningEffort ?? null,
			thinkingType: persistenceDefaults.thinkingType ?? null,
		},
		fallbackProviderModelId: input.fallbackProviderModelId ?? null,
		requireEnabledFallback: true,
	});

	const [model] = await db
		.insert(providerModels)
		.values({
			id: randomUUID(),
			providerId: input.providerId,
			name: input.name,
			displayName,
			iconAssetId: input.iconAssetId ?? null,
			guideNoteEn: input.guideNoteEn ?? null,
			guideNoteHu: input.guideNoteHu ?? null,
			guideBadge: input.guideBadge ?? null,
			fallbackProviderModelId: input.fallbackProviderModelId ?? null,
			maxModelContext: persistenceDefaults.maxModelContext,
			compactionUiThreshold: persistenceDefaults.compactionUiThreshold,
			targetConstructedContext: persistenceDefaults.targetConstructedContext,
			maxMessageLength: input.maxMessageLength ?? null,
			maxTokens: persistenceDefaults.maxTokens,
			reasoningEffort: persistenceDefaults.reasoningEffort,
			thinkingType: persistenceDefaults.thinkingType,
			capabilitiesJson: input.capabilitiesJson ?? "{}",
			inputUsdMicrosPer1m: input.inputUsdMicrosPer1m ?? 0,
			cachedInputUsdMicrosPer1m: input.cachedInputUsdMicrosPer1m ?? 0,
			cacheHitUsdMicrosPer1m: input.cacheHitUsdMicrosPer1m ?? 0,
			cacheMissUsdMicrosPer1m: input.cacheMissUsdMicrosPer1m ?? 0,
			outputUsdMicrosPer1m: input.outputUsdMicrosPer1m ?? 0,
			enabled: input.enabled === false ? 0 : 1,
			sortOrder: input.sortOrder ?? 0,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return mapRowToModel(model);
}

export async function createProviderModelFromPayload(
	providerId: string,
	payload: unknown,
): Promise<ProviderModel> {
	return createProviderModel(
		parseCreateProviderModelPayload(providerId, payload),
	);
}

export async function getProviderModel(
	id: string,
): Promise<ProviderModel | null> {
	const [row] = await db
		.select()
		.from(providerModels)
		.where(eq(providerModels.id, id));

	return row ? mapRowToModel(row) : null;
}

export async function getProviderModelByName(
	providerId: string,
	name: string,
): Promise<ProviderModel | null> {
	const [row] = await db
		.select()
		.from(providerModels)
		.where(
			and(
				eq(providerModels.providerId, providerId),
				eq(providerModels.name, name),
			),
		);

	return row ? mapRowToModel(row) : null;
}

export async function listProviderModels(
	providerId?: string,
): Promise<ProviderModel[]> {
	const rows = await db
		.select()
		.from(providerModels)
		.where(providerId ? eq(providerModels.providerId, providerId) : undefined)
		.orderBy(providerModels.sortOrder);

	return rows.map(mapRowToModel);
}

export async function listEnabledProviderModels(
	providerId?: string,
): Promise<ProviderModel[]> {
	const conditions = [eq(providerModels.enabled, 1)];
	if (providerId) {
		conditions.push(eq(providerModels.providerId, providerId));
	}

	const rows = await db
		.select()
		.from(providerModels)
		.where(and(...conditions))
		.orderBy(providerModels.sortOrder);

	return rows.map(mapRowToModel);
}

export async function updateProviderModel(
	id: string,
	input: UpdateProviderModelInput,
): Promise<ProviderModel | null> {
	const [existing] = await db
		.select()
		.from(providerModels)
		.where(eq(providerModels.id, id));

	if (!existing) return null;
	const nextEnabled =
		input.enabled !== undefined ? input.enabled : existing.enabled === 1;
	const fallbackProviderModelId =
		input.fallbackProviderModelId !== undefined
			? input.fallbackProviderModelId
			: (existing.fallbackProviderModelId ?? null);

	const sourceCompatibility: ProviderModelCompatibilityFields = {
		capabilitiesJson:
			input.capabilitiesJson !== undefined
				? input.capabilitiesJson
				: existing.capabilitiesJson,
		reasoningEffort:
			input.reasoningEffort !== undefined
				? (resolveProviderModelPersistenceDefaults({
						reasoningEffort: input.reasoningEffort,
					}).reasoningEffort ?? null)
				: (existing.reasoningEffort ?? null),
		thinkingType:
			input.thinkingType !== undefined
				? (resolveProviderModelPersistenceDefaults({
						thinkingType: input.thinkingType,
					}).thinkingType ?? null)
				: (existing.thinkingType ?? null),
	};

	if (nextEnabled || input.fallbackProviderModelId !== undefined) {
		await validateModelFallbackConfiguration({
			source: sourceCompatibility,
			fallbackProviderModelId,
			sourceId: id,
			requireEnabledFallback:
				nextEnabled || input.fallbackProviderModelId !== undefined,
		});
	}

	if (existing.enabled === 1 && input.enabled === false) {
		const dependentRows =
			await getProviderModelRowsReferencingFallbackModel(id);
		const enabledDependents = dependentRows.filter(
			(dependent) => dependent.enabled === 1,
		);

		if (enabledDependents.length > 0) {
			throw new ProviderModelValidationError(
				"cannot disable a provider model while enabled models reference it as fallback",
			);
		}
	}

	if (nextEnabled) {
		const dependentRows =
			await getProviderModelRowsReferencingFallbackModel(id);
		for (const dependent of dependentRows) {
			if (dependent.enabled !== 1) continue;

			assertFallbackCompatibility(
				{
					capabilitiesJson: dependent.capabilitiesJson ?? "{}",
					reasoningEffort: dependent.reasoningEffort ?? null,
					thinkingType: dependent.thinkingType ?? null,
				},
				sourceCompatibility,
			);
		}
	}

	const updates: Partial<typeof providerModels.$inferInsert> = {
		updatedAt: new Date(),
	};

	if (input.displayName !== undefined) updates.displayName = input.displayName;
	if (input.iconAssetId !== undefined) updates.iconAssetId = input.iconAssetId;
	if (input.guideNoteEn !== undefined) updates.guideNoteEn = input.guideNoteEn;
	if (input.guideNoteHu !== undefined) updates.guideNoteHu = input.guideNoteHu;
	if (input.guideBadge !== undefined) updates.guideBadge = input.guideBadge;
	if (input.fallbackProviderModelId !== undefined)
		updates.fallbackProviderModelId = input.fallbackProviderModelId;
	if (
		input.maxModelContext !== undefined ||
		input.compactionUiThreshold !== undefined ||
		input.targetConstructedContext !== undefined
	) {
		const persistenceDefaults = resolveProviderModelPersistenceDefaults({
			maxModelContext:
				input.maxModelContext !== undefined
					? input.maxModelContext
					: existing.maxModelContext,
			compactionUiThreshold: input.compactionUiThreshold,
			targetConstructedContext: input.targetConstructedContext,
		});
		if (input.maxModelContext !== undefined) {
			updates.maxModelContext = persistenceDefaults.maxModelContext;
		}
		if (
			input.compactionUiThreshold !== undefined ||
			input.maxModelContext !== undefined
		) {
			updates.compactionUiThreshold = persistenceDefaults.compactionUiThreshold;
		}
		if (
			input.targetConstructedContext !== undefined ||
			input.maxModelContext !== undefined
		) {
			updates.targetConstructedContext =
				persistenceDefaults.targetConstructedContext;
		}
	}
	if (input.maxMessageLength !== undefined)
		updates.maxMessageLength = input.maxMessageLength;
	if (input.maxTokens !== undefined) {
		updates.maxTokens = resolveProviderModelPersistenceDefaults({
			maxTokens: input.maxTokens,
		}).maxTokens;
	}
	if (input.reasoningEffort !== undefined) {
		updates.reasoningEffort = resolveProviderModelPersistenceDefaults({
			reasoningEffort: input.reasoningEffort,
		}).reasoningEffort;
	}
	if (input.thinkingType !== undefined) {
		updates.thinkingType = resolveProviderModelPersistenceDefaults({
			thinkingType: input.thinkingType,
		}).thinkingType;
	}
	if (input.capabilitiesJson !== undefined)
		updates.capabilitiesJson = input.capabilitiesJson;
	if (input.inputUsdMicrosPer1m !== undefined)
		updates.inputUsdMicrosPer1m = input.inputUsdMicrosPer1m;
	if (input.cachedInputUsdMicrosPer1m !== undefined)
		updates.cachedInputUsdMicrosPer1m = input.cachedInputUsdMicrosPer1m;
	if (input.cacheHitUsdMicrosPer1m !== undefined)
		updates.cacheHitUsdMicrosPer1m = input.cacheHitUsdMicrosPer1m;
	if (input.cacheMissUsdMicrosPer1m !== undefined)
		updates.cacheMissUsdMicrosPer1m = input.cacheMissUsdMicrosPer1m;
	if (input.outputUsdMicrosPer1m !== undefined)
		updates.outputUsdMicrosPer1m = input.outputUsdMicrosPer1m;
	if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
	if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

	const [updated] = await db
		.update(providerModels)
		.set(updates)
		.where(eq(providerModels.id, id))
		.returning();

	return updated ? mapRowToModel(updated) : null;
}

export async function updateProviderModelFromPayload(
	id: string,
	payload: unknown,
): Promise<ProviderModel | null> {
	return updateProviderModel(id, parseUpdateProviderModelPayload(payload));
}

export async function deleteProviderModel(id: string): Promise<boolean> {
	const result = await db
		.delete(providerModels)
		.where(eq(providerModels.id, id));

	return result.changes > 0;
}

export interface BatchModelEntry {
	name: string;
	displayName?: string;
	contextLength?: number;
	supportsChat?: boolean;
	supportsTools?: boolean;
}

export function parseBatchProviderModelsPayload(
	payload: unknown,
): BatchModelEntry[] {
	const body = objectBody(payload);
	if (!Array.isArray(body.models)) {
		throw new ProviderModelValidationError("models must be an array");
	}

	return body.models.map((rawEntry, i) => {
		const entry =
			rawEntry !== null &&
			typeof rawEntry === "object" &&
			!Array.isArray(rawEntry)
				? (rawEntry as ProviderModelBody)
				: {};
		if (typeof entry.name !== "string" || !entry.name.trim()) {
			throw new ProviderModelValidationError(
				`models[${i}].name is required and must be a non-empty string`,
			);
		}
		if (
			entry.displayName !== undefined &&
			typeof entry.displayName !== "string"
		) {
			throw new ProviderModelValidationError(
				`models[${i}].displayName must be a string`,
			);
		}
		if (
			entry.contextLength !== undefined &&
			typeof entry.contextLength !== "number"
		) {
			throw new ProviderModelValidationError(
				`models[${i}].contextLength must be a number`,
			);
		}
		if (
			entry.supportsChat !== undefined &&
			typeof entry.supportsChat !== "boolean"
		) {
			throw new ProviderModelValidationError(
				`models[${i}].supportsChat must be a boolean`,
			);
		}
		if (
			entry.supportsTools !== undefined &&
			typeof entry.supportsTools !== "boolean"
		) {
			throw new ProviderModelValidationError(
				`models[${i}].supportsTools must be a boolean`,
			);
		}

		return {
			name: entry.name.trim(),
			displayName:
				typeof entry.displayName === "string"
					? entry.displayName.trim()
					: undefined,
			contextLength:
				typeof entry.contextLength === "number"
					? entry.contextLength
					: undefined,
			supportsChat:
				typeof entry.supportsChat === "boolean"
					? entry.supportsChat
					: undefined,
			supportsTools:
				typeof entry.supportsTools === "boolean"
					? entry.supportsTools
					: undefined,
		};
	});
}

export async function batchCreateProviderModels(
	providerId: string,
	models: BatchModelEntry[],
): Promise<ProviderModel[]> {
	if (!(await providerExists(providerId))) {
		throw new Error(`Provider with id "${providerId}" does not exist`);
	}

	if (models.length === 0) return [];

	const now = new Date();
	const results: ProviderModel[] = [];

	for (const entry of models) {
		const existing = await getProviderModelByName(providerId, entry.name);
		if (existing) {
			results.push(existing);
			continue;
		}

		let capabilitiesJson = "{}";
		if (entry.supportsChat !== undefined || entry.supportsTools !== undefined) {
			const capabilities: Record<string, string> = {};
			if (entry.supportsChat) capabilities.chat = "detected";
			if (entry.supportsTools) capabilities.tools = "detected";
			capabilitiesJson = JSON.stringify(capabilities);
		}
		const persistenceDefaults = resolveProviderModelPersistenceDefaults({
			maxModelContext: entry.contextLength ?? null,
		});

		const [model] = await db
			.insert(providerModels)
			.values({
				id: randomUUID(),
				providerId,
				name: entry.name,
				displayName: entry.displayName ?? entry.name,
				maxModelContext: persistenceDefaults.maxModelContext,
				compactionUiThreshold: persistenceDefaults.compactionUiThreshold,
				targetConstructedContext: persistenceDefaults.targetConstructedContext,
				capabilitiesJson,
				enabled: 1,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		results.push(mapRowToModel(model));
	}

	return results;
}

export async function batchCreateProviderModelsFromPayload(
	providerId: string,
	payload: unknown,
): Promise<ProviderModel[]> {
	return batchCreateProviderModels(
		providerId,
		parseBatchProviderModelsPayload(payload),
	);
}
