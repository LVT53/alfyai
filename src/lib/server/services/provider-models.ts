import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { providerModels, providers } from "../db/schema";

type ProviderModelRow = typeof providerModels.$inferSelect;

export interface ProviderModel {
	id: string;
	providerId: string;
	name: string;
	displayName: string;
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

function mapRowToModel(row: ProviderModelRow): ProviderModel {
	return {
		id: row.id,
		providerId: row.providerId,
		name: row.name,
		displayName: row.displayName,
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

	const [model] = await db
		.insert(providerModels)
		.values({
			id: randomUUID(),
			providerId: input.providerId,
			name: input.name,
			displayName,
			maxModelContext: input.maxModelContext ?? null,
			compactionUiThreshold: input.compactionUiThreshold ?? null,
			targetConstructedContext: input.targetConstructedContext ?? null,
			maxMessageLength: input.maxMessageLength ?? null,
			maxTokens: input.maxTokens ?? null,
			reasoningEffort: input.reasoningEffort ?? null,
			thinkingType: input.thinkingType ?? null,
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

	const updates: Partial<typeof providerModels.$inferInsert> = {
		updatedAt: new Date(),
	};

	if (input.displayName !== undefined) updates.displayName = input.displayName;
	if (input.maxModelContext !== undefined) updates.maxModelContext = input.maxModelContext;
	if (input.compactionUiThreshold !== undefined) updates.compactionUiThreshold = input.compactionUiThreshold;
	if (input.targetConstructedContext !== undefined) updates.targetConstructedContext = input.targetConstructedContext;
	if (input.maxMessageLength !== undefined) updates.maxMessageLength = input.maxMessageLength;
	if (input.maxTokens !== undefined) updates.maxTokens = input.maxTokens;
	if (input.reasoningEffort !== undefined) updates.reasoningEffort = input.reasoningEffort;
	if (input.thinkingType !== undefined) updates.thinkingType = input.thinkingType;
	if (input.capabilitiesJson !== undefined) updates.capabilitiesJson = input.capabilitiesJson;
	if (input.inputUsdMicrosPer1m !== undefined) updates.inputUsdMicrosPer1m = input.inputUsdMicrosPer1m;
	if (input.cachedInputUsdMicrosPer1m !== undefined) updates.cachedInputUsdMicrosPer1m = input.cachedInputUsdMicrosPer1m;
	if (input.cacheHitUsdMicrosPer1m !== undefined) updates.cacheHitUsdMicrosPer1m = input.cacheHitUsdMicrosPer1m;
	if (input.cacheMissUsdMicrosPer1m !== undefined) updates.cacheMissUsdMicrosPer1m = input.cacheMissUsdMicrosPer1m;
	if (input.outputUsdMicrosPer1m !== undefined) updates.outputUsdMicrosPer1m = input.outputUsdMicrosPer1m;
	if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
	if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

	const [updated] = await db
		.update(providerModels)
		.set(updates)
		.where(eq(providerModels.id, id))
		.returning();

	return updated ? mapRowToModel(updated) : null;
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

		const [model] = await db
			.insert(providerModels)
			.values({
				id: randomUUID(),
				providerId,
				name: entry.name,
				displayName: entry.displayName ?? entry.name,
				maxModelContext: entry.contextLength ?? null,
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
