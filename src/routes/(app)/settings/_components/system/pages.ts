// Which page owns which config key.
//
// The navigator badge, the save bar's breakdown and the search index all need
// the same answer, and a key that belongs to no page would be a key whose
// pending edit the bar counts but no page can show.

import { ADVANCED_KEY_SPECS } from "$lib/config/admin-config-registry";
import type { I18nKey } from "$lib/i18n";

export const SYSTEM_PAGE_IDS = [
	"general",
	"models",
	"aiTasks",
	"integrations",
	"limits",
	"skills",
	"advanced",
	"diagnostics",
] as const;

export type SystemPageId = (typeof SYSTEM_PAGE_IDS)[number];

export const SYSTEM_PAGE_LABEL_KEY: Record<SystemPageId, I18nKey> = {
	general: "admin.system.pages.general",
	models: "admin.system.pages.models",
	aiTasks: "admin.system.pages.aiTasks",
	integrations: "admin.system.pages.integrations",
	limits: "admin.system.pages.limits",
	skills: "admin.system.pages.skills",
	advanced: "admin.system.pages.advanced",
	diagnostics: "admin.system.pages.diagnostics",
};

const NAMED_PAGE_KEYS: Partial<Record<SystemPageId, string[]>> = {
	general: ["COMPOSER_COMMAND_REGISTRY_ENABLED", "APP_VERSION_OVERRIDE"],
	models: [
		"MODEL_TIMEOUT_FAILOVER_ENABLED",
		"MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS",
		"MODEL_TIMEOUT_FAILOVER_TARGET_MODEL",
		"DEFAULT_NEW_USER_MODEL",
		"MODEL_1_ICON_ASSET_ID",
		"MODEL_2_ICON_ASSET_ID",
	],
	aiTasks: [
		// The pipeline selector lives next to the tasks it chooses between, so
		// the Advanced page's Atlas group leaves it out (see SYSTEM_PAGE_BY_KEY).
		"ATLAS_PIPELINE",
		"ATLAS_WORKER_ENABLED",
		"ATLAS_SYNTHESIS_MODEL",
		"ATLAS_AUDIT_MODEL",
		"ATLAS_GLOBAL_ACTIVE_LIMIT",
		"ATLAS_SEARCH_CONCURRENCY",
		"ATLAS_SEARCH_BATCH_DELAY_MS",
		"ATLAS_V3_ASK_MODEL",
		"ATLAS_V3_RESEARCHER_MODEL",
		"ATLAS_V3_OUTLINE_MODEL",
		"ATLAS_V3_WRITER_MODEL",
		"ATLAS_V3_CRITIC_MODEL",
		"ATLAS_V3_VERIFIER_MODEL",
		"ATLAS_V3_CRITIC_ROUNDS",
		"ATLAS_V3_RESEARCHER_CONCURRENCY",
		"ATLAS_V3_SEARCHES_PER_STEP",
		"ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW",
		"ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH",
		"ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE",
		"ATLAS_V3_LANGUAGE_STANDARD_HU",
		"MEMORY_JUDGE_MODEL",
		"MEMORY_CONSOLIDATION_MODEL",
		"TITLE_GEN_MODEL",
		"TITLE_GEN_SYSTEM_PROMPT_EN",
		"TITLE_GEN_SYSTEM_PROMPT_HU",
		"TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN",
		"TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU",
		"CONTEXT_SUMMARIZER_MODEL",
		"SYSTEM_PROMPT",
	],
	integrations: [
		"PARALLEL_API_KEY",
		"BRAVE_SEARCH_API_KEY",
		"MINERU_API_URL",
		"MINERU_TIMEOUT_MS",
		"WEB_PUSH_VAPID_PUBLIC_KEY",
		"WEB_PUSH_VAPID_PRIVATE_KEY",
		"WEB_PUSH_VAPID_SUBJECT",
	],
	limits: ["MAX_MESSAGE_LENGTH", "MAX_FILE_UPLOAD_SIZE", "REQUEST_TIMEOUT_MS"],
};

/**
 * Key → page. The Advanced page owns everything in the registry that a named
 * page has not already claimed, so a key can never be counted twice.
 */
export const SYSTEM_PAGE_BY_KEY: Readonly<Record<string, SystemPageId>> =
	(() => {
		const map: Record<string, SystemPageId> = {};
		for (const [page, keys] of Object.entries(NAMED_PAGE_KEYS)) {
			for (const key of keys ?? []) {
				map[key] = page as SystemPageId;
			}
		}
		for (const spec of ADVANCED_KEY_SPECS) {
			if (!map[spec.key]) map[spec.key] = "advanced";
		}
		return map;
	})();

export function pageForKey(key: string): SystemPageId | undefined {
	return SYSTEM_PAGE_BY_KEY[key];
}

/** How many keys a page actually renders — the navigator's plain count. */
export function keyCountForPage(page: SystemPageId): number {
	return Object.values(SYSTEM_PAGE_BY_KEY).filter((owner) => owner === page)
		.length;
}

/** One row in the screen-wide search: a setting, a key, or a provider. */
export interface SystemSearchItem {
	id: string;
	label: string;
	page: SystemPageId;
	/** Config key or provider id, shown in mono and searched. */
	sub?: string;
}
