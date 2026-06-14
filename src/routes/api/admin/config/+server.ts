import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
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
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	const rows = await db.select().from(adminConfig);
	const overrides: Record<string, string> = Object.fromEntries(
		rows.map((r) => [r.key, r.value]),
	);
	const envDefaults = getEnvDefaults();
	const currentValues = getResolvedAdminConfigValues();

	return json({
		keys: ADMIN_CONFIG_KEYS,
		currentValues,
		overrides,
		envDefaults,
	});
};

export const PUT: RequestHandler = async (event) => {
	requireAdmin(event);
	const userId = event.locals.user?.id;

	let body: Record<string, unknown>;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: "Invalid JSON" }, { status: 400 });
	}

	const now = new Date();

	for (const key of ADMIN_CONFIG_KEYS) {
		if (body[key] !== undefined) {
			const rawValue = String(body[key]);
			const value =
				key === "MODEL_1_SYSTEM_PROMPT" || key === "MODEL_2_SYSTEM_PROMPT"
					? (normalizeSystemPromptReference(rawValue) ?? "")
					: rawValue;
			if (value.trim() === "") {
				// Empty value = revert to env default (delete DB override)
				await db.delete(adminConfig).where(eq(adminConfig.key, key));
			} else {
				await db
					.insert(adminConfig)
					.values({
						key: key as AdminConfigKey,
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
	}

	await refreshConfig();

	return json({ success: true });
};
