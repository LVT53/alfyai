import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import {
	ADVANCED_KEY_SPEC_BY_KEY,
	isUnwiredAdminConfigKey,
	validateAdminConfigValue,
} from "$lib/config/admin-config-registry";
import { requireAdmin } from "$lib/server/auth/hooks";
import {
	ADMIN_CONFIG_KEYS,
	type AdminConfigKey,
	getEnvDefaults,
	getResolvedAdminConfigValues,
	refreshConfig,
} from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { adminConfig } from "$lib/server/db/schema";
import { normalizeSystemPromptReference } from "$lib/server/prompts";
import {
	isSecretConfigKey,
	SECRET_MASK,
} from "$lib/server/services/admin-effective-config";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	const rows = await db.select().from(adminConfig);
	// MASKED, like `currentValues` and `envDefaults` beside it.
	//
	// This field used to return the `admin_config` table verbatim, which handed
	// every stored credential — MINERU_API_KEY, MODEL_1_API_KEY, the OAuth
	// secrets — back in cleartext to anyone who could reach this route, and
	// quietly defeated the masking the other two fields do. Nothing in the
	// System screen reads the raw value: a secret row renders "Set · last
	// changed <date>" from `overrideMeta`, and an admin who wants to change one
	// types a new value rather than reading the old.
	const overrides: Record<string, string> = Object.fromEntries(
		rows.map((r) => [
			r.key,
			isSecretConfigKey(r.key) && r.value.trim() !== "" ? SECRET_MASK : r.value,
		]),
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
	// Keys nothing reads: DROPPED from the write, never stored, and named back
	// to the caller in `ignored`. Deliberately NOT folded into `invalid`: that
	// set fails the whole patch, and an unwired key riding along with a dozen
	// good ones — an admin tab loaded before this deploy, a provisioning
	// script posting a full config dump — would then be unable to save
	// anything at all. The value is not wrong, there is just nowhere for it to
	// go, so it is the only part of the patch that gets dropped. Silence is
	// what the disabled row exists to stop, so the response says which keys
	// went nowhere and why.
	const ignored: Record<string, { reason: string }> = {};

	for (const key of ADMIN_CONFIG_KEYS) {
		if (body[key] === undefined) continue;
		if (isUnwiredAdminConfigKey(key)) {
			ignored[key] = { reason: "unwired" };
			continue;
		}
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

	const ignoredKeys = Object.keys(ignored);

	if (Object.keys(invalid).length > 0) {
		// A malformed value still fails the whole patch — nothing is written,
		// so a rejected key never leaves half an edit behind. `ignored` rides
		// along on the failure too, so the caller learns about both problems
		// from one response instead of discovering the second on the retry.
		return json(
			{
				error: `Invalid value for ${Object.keys(invalid).join(", ")}`,
				invalid,
				...(ignoredKeys.length > 0 ? { ignored } : {}),
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

	// `success: true` is honest: every key that could be stored was stored.
	// `ignored` is what keeps it from being a half-truth — it names, per key,
	// the part of the patch that went nowhere, so a caller outside the UI is
	// told rather than left to infer it from a later GET.
	return json({
		success: true,
		...(ignoredKeys.length > 0 ? { ignored } : {}),
	});
};
