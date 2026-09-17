/**
 * The allow-list for a campaign slide's action button, shared by the server's
 * publish validation (`src/lib/server/services/announcement-campaigns.ts`) and
 * the admin checklist that mirrors it
 * (`src/routes/(app)/settings/_components/campaigns/campaign-checklist.ts`).
 *
 * Both sides used to keep their own copy and had drifted: the server listed
 * `internal:chatgpt-import` but rejected it before ever consulting the list,
 * and the client did not list it at all, so the shipped first-run template
 * could not be published. One list, one predicate, no drift.
 */

/** Destinations the action button navigates to, as same-origin paths. */
export const ALLOWED_ACTION_PATHS = [
	"/",
	"/chat",
	"/knowledge",
	"/settings",
	"/settings/profile",
	"/settings/admin",
] as const;

/**
 * Destinations handled inside the app instead of by navigation. The campaign
 * modal strips the `internal:` prefix and hands the rest to
 * `handleCampaignInternalAction` in `src/routes/(app)/+layout.svelte`, so every
 * value here needs a matching branch there — `internal:chatgpt-import` opens
 * `ImportChatGPTModal.svelte`.
 */
export const ALLOWED_INTERNAL_ACTIONS = ["internal:chatgpt-import"] as const;

/** Everything the admin destination select may offer, in display order. */
export const ALLOWED_ACTION_DESTINATIONS = [
	...ALLOWED_ACTION_PATHS,
	...ALLOWED_INTERNAL_ACTIONS,
] as const;

export const INTERNAL_ACTION_PREFIX = "internal:";

const allowedPaths = new Set<string>(ALLOWED_ACTION_PATHS);
const allowedInternalActions = new Set<string>(ALLOWED_INTERNAL_ACTIONS);

/**
 * True when a slide may ship with this action destination.
 *
 * An empty destination is allowed — it simply means the slide has no action
 * button. `internal:` values must match an entry exactly; paths must be
 * same-origin (a single leading slash, so protocol-relative `//host` is out)
 * and may carry a query string, which is not part of the match. Everything
 * else — other schemes such as `javascript:`, absolute URLs, unknown
 * `internal:` actions — is rejected.
 */
export function isAllowedActionDestination(
	value: string | null | undefined,
): boolean {
	if (!value) return true;
	if (value.startsWith(INTERNAL_ACTION_PREFIX)) {
		return allowedInternalActions.has(value);
	}
	if (!value.startsWith("/") || value.startsWith("//")) return false;
	return allowedPaths.has(value.split("?")[0]);
}
