import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import {
	ADVANCED_KEY_SPEC_BY_KEY,
	validateAdminConfigValue,
} from "$lib/config/admin-config-registry";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	ADMIN_CONFIG_KEYS,
	type AdminConfigKey,
	getAtlasExhaustiveMaxOutputTokens,
	getAtlasInDepthMaxOutputTokens,
	getAtlasMaxWriterPromptChars,
	getAtlasOverviewMaxOutputTokens,
	getEnvDefaults,
	getResolvedAdminConfigValues,
	refreshConfig,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { adminConfig } from "$lib/server/db/schema";
import { normalizeSystemPromptReference } from "$lib/server/prompts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	const rows = await db.select().from(adminConfig);
	const overrides: Record<string, string> = Object.fromEntries(
		rows.map((r) => [r.key, r.value]),
	);
	// Additive: when each override was last written, and by whom. The redesigned
	// System screen shows it on secret rows ("Set · last changed <date>"), where
	// the value itself is masked and the date is the only evidence of a write.
	const overrideMeta: Record<string, { updatedAt: string; updatedBy: string }> =
		Object.fromEntries(
			rows.map((r) => [
				r.key,
				{
					updatedAt:
						r.updatedAt instanceof Date
							? r.updatedAt.toISOString()
							: new Date(r.updatedAt).toISOString(),
					updatedBy: r.updatedBy,
				},
			]),
		);
	const envDefaults = getEnvDefaults();
	const currentValues = getResolvedAdminConfigValues();

	return json({
		keys: ADMIN_CONFIG_KEYS,
		currentValues,
		overrides,
		overrideMeta,
		envDefaults,
		atlas: {
			overviewMaxOutputTokens: getAtlasOverviewMaxOutputTokens(),
			inDepthMaxOutputTokens: getAtlasInDepthMaxOutputTokens(),
			exhaustiveMaxOutputTokens: getAtlasExhaustiveMaxOutputTokens(),
			maxWriterPromptChars: getAtlasMaxWriterPromptChars(),
		},
	});
};

export const PUT: RequestHandler = async (event) => {
	requireAdmin(event);
	const userId = event.locals.user.id;

	let body: Record<string, unknown>;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const now = new Date();

	// Type and range are checked HERE, not only in the admin UI: this endpoint
	// is reachable with any body, and a value that survives the write would be
	// silently clamped (or dropped) by the override appliers, leaving the stored
	// row and the running config saying different things. Everything is checked
	// before anything is written, so a rejected key never leaves a half-applied
	// patch behind, and the rejection names each key that failed and why.
	const pending: Array<{ key: AdminConfigKey; value: string }> = [];
	const invalid: Record<string, { reason: string; limit?: number }> = {};

	for (const key of ADMIN_CONFIG_KEYS) {
		if (body[key] === undefined) continue;
		const rawValue = String(body[key]);
		const value =
			key === "MODEL_1_SYSTEM_PROMPT" || key === "MODEL_2_SYSTEM_PROMPT"
				? (normalizeSystemPromptReference(rawValue) ?? "")
				: rawValue;
		const spec = ADVANCED_KEY_SPEC_BY_KEY.get(key);
		if (!spec) {
			pending.push({ key: key as AdminConfigKey, value });
			continue;
		}
		const checked = validateAdminConfigValue(spec, value);
		if (!checked.ok) {
			invalid[key] = checked.limit
				? { reason: checked.reason, limit: checked.limit }
				: { reason: checked.reason };
			continue;
		}
		// The canonical form: "007" is stored as "7", a boolean as "true"/"false".
		pending.push({ key: key as AdminConfigKey, value: checked.value });
	}

	if (Object.keys(invalid).length > 0) {
		return json(
			{
				error: `Invalid value for ${Object.keys(invalid).join(", ")}`,
				invalid,
			},
			{ status: 400 },
		);
	}

	for (const { key, value } of pending) {
		if (value.trim() === "") {
			// Empty value = revert to env default (delete DB override)
			await db.delete(adminConfig).where(eq(adminConfig.key, key));
		} else {
			await db
				.insert(adminConfig)
				.values({
					key,
					value,
					updatedAt: now,
					updatedBy: userId,
				})
				.onConflictDoUpdate({
					target: adminConfig.key,
					set: { value, updatedAt: now, updatedBy: userId },
				});
		}
	}

	await refreshConfig();

	return json({ success: true });
};
