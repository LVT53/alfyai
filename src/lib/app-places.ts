/**
 * Every place in the app that something can send a person to, defined once.
 *
 * Two readers: the campaign allow-list (`src/lib/campaign-action-destinations.ts`)
 * offers the places marked `campaign`, and the feature guide takes a person to
 * a place by id with `appPlacePath`. Do not start a second list of paths.
 *
 * Server and browser code both import this file, so it stays free of browser
 * APIs and of `$app/*`.
 */

export type AppPlaceId =
	| "home"
	| "chat"
	| "knowledge"
	| "knowledgeMemory"
	| "settings"
	| "settingsProfile"
	| "settingsAdmin"
	| "guide";

/**
 * Each place's same-origin path. `campaign` says whether a campaign's action
 * button may point there; the places marked `campaign` are the ones published
 * campaigns already store, and their order is the admin menu's order, so
 * neither their values nor their order may change.
 */
export const APP_PLACES: Readonly<
	Record<AppPlaceId, { path: string; campaign: boolean }>
> = {
	home: { path: "/", campaign: true },
	chat: { path: "/chat", campaign: true },
	knowledge: { path: "/knowledge", campaign: true },
	knowledgeMemory: { path: "/knowledge?tab=memory", campaign: false },
	settings: { path: "/settings", campaign: true },
	// No route behind these two (Settings is one page); they stay because published campaign snapshots store these strings.
	settingsProfile: { path: "/settings/profile", campaign: true },
	settingsAdmin: { path: "/settings/admin", campaign: true },
	guide: { path: "/guide", campaign: false },
};

/** The same-origin path of a place. */
export function appPlacePath(id: AppPlaceId): string {
	return APP_PLACES[id].path;
}

/**
 * The paths a campaign's action button may point at: the places marked
 * `campaign`, in `APP_PLACES` order. `campaign-action-destinations.ts` builds
 * its allow-list from this.
 */
export const CAMPAIGN_ACTION_PATHS: readonly string[] = Object.values(
	APP_PLACES,
)
	.filter((place) => place.campaign)
	.map((place) => place.path);

/**
 * The real controls the guide's Show me can ring, each named `area.control`:
 * where the control lives, then which one it is.
 */
export const SPOTLIGHT_IDS = [
	"composer.thinking",
	"composer.attach",
	"composer.library",
	"composer.atlas",
	"home.incognito",
	"home.home",
	"sidebar.search",
	"sidebar.projects",
	"knowledge.library",
	"knowledge.memory",
	"settings.instructions",
	"settings.style",
	"settings.language",
	"settings.skills",
	"settings.twoStep",
	"settings.data",
	"settings.activity",
	"settings.connections",
] as const;

export type SpotlightId = (typeof SPOTLIGHT_IDS)[number];
