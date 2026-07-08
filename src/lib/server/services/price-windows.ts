import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { providerModelPriceWindows, providerModels } from "../db/schema";

type PriceWindowRow = typeof providerModelPriceWindows.$inferSelect;

// A price window as returned to the admin surface: all fields including the
// disabled ones (the resolver-facing loader in analytics.ts filters to enabled).
export interface PriceWindow {
	id: string;
	providerModelId: string;
	label: string;
	daysOfWeek: string;
	startMinute: number;
	endMinute: number;
	inputUsdMicrosPer1m: number | null;
	cachedInputUsdMicrosPer1m: number | null;
	cacheHitUsdMicrosPer1m: number | null;
	cacheMissUsdMicrosPer1m: number | null;
	outputUsdMicrosPer1m: number | null;
	enabled: boolean;
	createdAt: Date;
	updatedAt: Date;
}

// A validated, normalized window ready to persist (no id/timestamps yet).
export interface PriceWindowInput {
	label: string;
	daysOfWeek: string;
	startMinute: number;
	endMinute: number;
	inputUsdMicrosPer1m: number | null;
	cachedInputUsdMicrosPer1m: number | null;
	cacheHitUsdMicrosPer1m: number | null;
	cacheMissUsdMicrosPer1m: number | null;
	outputUsdMicrosPer1m: number | null;
	enabled: boolean;
}

export class PriceWindowValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PriceWindowValidationError";
	}
}

const MIN_MINUTE = 0;
const START_MINUTE_MAX = 1439; // start is inclusive
const END_MINUTE_MAX = 1440; // end is exclusive
const VALID_DAYS = new Set(["0", "1", "2", "3", "4", "5", "6"]);
const NULLABLE_RATE_FIELDS = [
	"inputUsdMicrosPer1m",
	"cachedInputUsdMicrosPer1m",
	"cacheHitUsdMicrosPer1m",
	"cacheMissUsdMicrosPer1m",
	"outputUsdMicrosPer1m",
] as const;

function objectBody(payload: unknown): Record<string, unknown> {
	return payload !== null &&
		typeof payload === "object" &&
		!Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: {};
}

function normalizeDaysOfWeek(value: unknown): string {
	if (value === undefined || value === null) return "0123456";
	if (typeof value !== "string") {
		throw new PriceWindowValidationError("daysOfWeek must be a string");
	}
	const seen = new Set<string>();
	for (const char of value.trim()) {
		if (!VALID_DAYS.has(char)) {
			throw new PriceWindowValidationError(
				"daysOfWeek must contain only digits 0-6 (0=Sunday)",
			);
		}
		seen.add(char);
	}
	if (seen.size === 0) {
		throw new PriceWindowValidationError(
			"daysOfWeek must include at least one day",
		);
	}
	// Canonical ascending order so "0123456" is stable regardless of input order.
	return [...seen].sort().join("");
}

function readMinute(
	body: Record<string, unknown>,
	key: string,
	max: number,
): number {
	const value = body[key];
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < MIN_MINUTE ||
		value > max
	) {
		throw new PriceWindowValidationError(
			`${key} must be an integer between ${MIN_MINUTE} and ${max}`,
		);
	}
	return value;
}

function readNullableRate(
	body: Record<string, unknown>,
	key: string,
): number | null {
	const value = body[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new PriceWindowValidationError(
			`${key} must be a non-negative integer or null`,
		);
	}
	return value;
}

// Validate + normalize an untrusted window payload. Throws
// PriceWindowValidationError on any invalid field.
export function parsePriceWindowPayload(payload: unknown): PriceWindowInput {
	const body = objectBody(payload);
	const label = typeof body.label === "string" ? body.label.trim() : "";
	if (!label) {
		throw new PriceWindowValidationError("label is required");
	}

	const input: PriceWindowInput = {
		label,
		daysOfWeek: normalizeDaysOfWeek(body.daysOfWeek),
		startMinute: readMinute(body, "startMinute", START_MINUTE_MAX),
		endMinute: readMinute(body, "endMinute", END_MINUTE_MAX),
		inputUsdMicrosPer1m: null,
		cachedInputUsdMicrosPer1m: null,
		cacheHitUsdMicrosPer1m: null,
		cacheMissUsdMicrosPer1m: null,
		outputUsdMicrosPer1m: null,
		enabled: body.enabled === undefined ? true : body.enabled === true,
	};
	for (const key of NULLABLE_RATE_FIELDS) {
		input[key] = readNullableRate(body, key);
	}
	return input;
}

export function parsePriceWindowsPayload(payload: unknown): PriceWindowInput[] {
	const body = objectBody(payload);
	if (!Array.isArray(body.windows)) {
		throw new PriceWindowValidationError("windows must be an array");
	}
	return body.windows.map((entry) => parsePriceWindowPayload(entry));
}

function mapRowToPriceWindow(row: PriceWindowRow): PriceWindow {
	return {
		id: row.id,
		providerModelId: row.providerModelId,
		label: row.label,
		daysOfWeek: row.daysOfWeek,
		startMinute: row.startMinute,
		endMinute: row.endMinute,
		inputUsdMicrosPer1m: row.inputUsdMicrosPer1m ?? null,
		cachedInputUsdMicrosPer1m: row.cachedInputUsdMicrosPer1m ?? null,
		cacheHitUsdMicrosPer1m: row.cacheHitUsdMicrosPer1m ?? null,
		cacheMissUsdMicrosPer1m: row.cacheMissUsdMicrosPer1m ?? null,
		outputUsdMicrosPer1m: row.outputUsdMicrosPer1m ?? null,
		enabled: row.enabled === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function assertProviderModelExists(
	providerModelId: string,
): Promise<void> {
	const [row] = await db
		.select({ id: providerModels.id })
		.from(providerModels)
		.where(eq(providerModels.id, providerModelId));
	if (!row) {
		throw new PriceWindowValidationError(
			`provider model "${providerModelId}" does not exist`,
		);
	}
}

// List every window (enabled and disabled) for a model, ordered the same way the
// resolver breaks ties: start_minute then id.
export async function listPriceWindows(
	providerModelId: string,
): Promise<PriceWindow[]> {
	const rows = await db
		.select()
		.from(providerModelPriceWindows)
		.where(eq(providerModelPriceWindows.providerModelId, providerModelId))
		.orderBy(
			asc(providerModelPriceWindows.startMinute),
			asc(providerModelPriceWindows.id),
		);
	return rows.map(mapRowToPriceWindow);
}

export async function createPriceWindow(
	providerModelId: string,
	input: PriceWindowInput,
): Promise<PriceWindow> {
	await assertProviderModelExists(providerModelId);
	const now = new Date();
	const [row] = await db
		.insert(providerModelPriceWindows)
		.values({
			id: randomUUID(),
			providerModelId,
			label: input.label,
			daysOfWeek: input.daysOfWeek,
			startMinute: input.startMinute,
			endMinute: input.endMinute,
			inputUsdMicrosPer1m: input.inputUsdMicrosPer1m,
			cachedInputUsdMicrosPer1m: input.cachedInputUsdMicrosPer1m,
			cacheHitUsdMicrosPer1m: input.cacheHitUsdMicrosPer1m,
			cacheMissUsdMicrosPer1m: input.cacheMissUsdMicrosPer1m,
			outputUsdMicrosPer1m: input.outputUsdMicrosPer1m,
			enabled: input.enabled ? 1 : 0,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return mapRowToPriceWindow(row);
}

export async function updatePriceWindow(
	id: string,
	input: PriceWindowInput,
): Promise<PriceWindow | null> {
	const [row] = await db
		.update(providerModelPriceWindows)
		.set({
			label: input.label,
			daysOfWeek: input.daysOfWeek,
			startMinute: input.startMinute,
			endMinute: input.endMinute,
			inputUsdMicrosPer1m: input.inputUsdMicrosPer1m,
			cachedInputUsdMicrosPer1m: input.cachedInputUsdMicrosPer1m,
			cacheHitUsdMicrosPer1m: input.cacheHitUsdMicrosPer1m,
			cacheMissUsdMicrosPer1m: input.cacheMissUsdMicrosPer1m,
			outputUsdMicrosPer1m: input.outputUsdMicrosPer1m,
			enabled: input.enabled ? 1 : 0,
			updatedAt: new Date(),
		})
		.where(eq(providerModelPriceWindows.id, id))
		.returning();
	return row ? mapRowToPriceWindow(row) : null;
}

export async function deletePriceWindow(id: string): Promise<boolean> {
	const result = await db
		.delete(providerModelPriceWindows)
		.where(eq(providerModelPriceWindows.id, id));
	return result.changes > 0;
}

// Replace the entire window set for a model in one atomic step — the shape the
// admin form uses to save its edited list. Validates existence first.
export async function replacePriceWindowsForModel(
	providerModelId: string,
	inputs: PriceWindowInput[],
): Promise<PriceWindow[]> {
	await assertProviderModelExists(providerModelId);
	const now = new Date();
	return db.transaction((tx) => {
		tx.delete(providerModelPriceWindows)
			.where(eq(providerModelPriceWindows.providerModelId, providerModelId))
			.run();
		const created: PriceWindow[] = [];
		for (const input of inputs) {
			const row = tx
				.insert(providerModelPriceWindows)
				.values({
					id: randomUUID(),
					providerModelId,
					label: input.label,
					daysOfWeek: input.daysOfWeek,
					startMinute: input.startMinute,
					endMinute: input.endMinute,
					inputUsdMicrosPer1m: input.inputUsdMicrosPer1m,
					cachedInputUsdMicrosPer1m: input.cachedInputUsdMicrosPer1m,
					cacheHitUsdMicrosPer1m: input.cacheHitUsdMicrosPer1m,
					cacheMissUsdMicrosPer1m: input.cacheMissUsdMicrosPer1m,
					outputUsdMicrosPer1m: input.outputUsdMicrosPer1m,
					enabled: input.enabled ? 1 : 0,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
				.get();
			created.push(mapRowToPriceWindow(row));
		}
		return created;
	});
}

export function isPriceWindowValidationError(error: unknown): error is Error {
	return error instanceof Error && error.name === "PriceWindowValidationError";
}
