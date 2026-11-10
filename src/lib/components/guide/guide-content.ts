import type { AppPlaceId, SpotlightId } from "$lib/app-places";
import type { I18nKey } from "$lib/i18n";

/**
 * What the Feature Guide lists: six sections and thirty entries, as data.
 *
 * Every word is a `guide.*` key in `src/lib/i18n/guide.ts`; this file holds
 * only the ids, the order and what each entry can do. A change that adds,
 * removes, renames or moves a user-facing feature updates its entry here and
 * its words there in the same change (root AGENTS.md).
 */

export const GUIDE_SECTION_IDS = [
	"ask",
	"make",
	"knowsYou",
	"yourThings",
	"organized",
	"account",
] as const;

export type GuideSectionId = (typeof GUIDE_SECTION_IDS)[number];

/**
 * What a row offers. Try it puts the entry's example in Home's message box,
 * unsent. Show me takes the person to a real control and rings it; a `place`
 * of `null` means "stay on this page", since the sidebar is on every page.
 * Show me exists only where its control is always there, so a control that
 * appears only in some state gets `none`.
 */
export type GuideAction =
	| { kind: "tryIt" }
	| { kind: "showMe"; place: AppPlaceId | null; spotlight: SpotlightId }
	| { kind: "none" };

export interface GuideEntry {
	id: string;
	section: GuideSectionId;
	/** The part of the section's drawing this row lights, or `null` for none. */
	drawingSpot: string | null;
	action: GuideAction;
	/** The day the feature reached the app, `YYYY-MM-DD`; NEW counts from it. */
	added: string;
}

/** NEW stays on an entry for this many days after its `added` date. */
export const GUIDE_NEW_FOR_DAYS = 30;

/**
 * The `added` date of every feature that already existed when the guide
 * shipped: long enough ago that it is never marked NEW.
 */
export const BEFORE_THE_GUIDE = "2026-09-01";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an entry still wears NEW: from its `added` day (read as UTC
 * midnight) up to, but not including, the same moment 30 days later. Everyone
 * sees the same thing, so no per-person record is kept.
 */
export function isGuideEntryNew(added: string, now: Date): boolean {
	const age = now.getTime() - Date.parse(`${added}T00:00:00Z`);
	return age >= 0 && age < GUIDE_NEW_FOR_DAYS * DAY_MS;
}

/** The entries in the order the page lists them, section by section. */
export const GUIDE_ENTRIES: readonly GuideEntry[] = [
	// ── Ask ──────────────────────────────────────────────────────────────
	{
		id: "askAnything",
		section: "ask",
		drawingSpot: "thinking",
		action: { kind: "showMe", place: "home", spotlight: "composer.thinking" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "webAndLinks",
		section: "ask",
		drawingSpot: "sources",
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "pictureOrFile",
		section: "ask",
		drawingSpot: "attach",
		action: { kind: "showMe", place: "home", spotlight: "composer.attach" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "mapsAndTravel",
		section: "ask",
		drawingSpot: null,
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "atlasResearch",
		section: "ask",
		drawingSpot: "atlas",
		action: { kind: "showMe", place: "home", spotlight: "composer.atlas" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "steerAReply",
		section: "ask",
		drawingSpot: "replyActions",
		action: { kind: "none" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "asksFirst",
		section: "ask",
		drawingSpot: null,
		action: { kind: "tryIt" },
		added: "2026-11-05",
	},
	// ── Make ─────────────────────────────────────────────────────────────
	{
		id: "documents",
		section: "make",
		drawingSpot: "document",
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "apps",
		section: "make",
		drawingSpot: null,
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "canvases",
		section: "make",
		drawingSpot: null,
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "pictures",
		section: "make",
		drawingSpot: "picture",
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "files",
		section: "make",
		drawingSpot: "download",
		action: { kind: "tryIt" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "history",
		section: "make",
		drawingSpot: "history",
		action: { kind: "none" },
		added: BEFORE_THE_GUIDE,
	},
	// ── It knows you ─────────────────────────────────────────────────────
	{
		id: "memory",
		section: "knowsYou",
		drawingSpot: "memory",
		action: {
			kind: "showMe",
			place: "knowledgeMemory",
			spotlight: "knowledge.memory",
		},
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "instructions",
		section: "knowsYou",
		drawingSpot: "instructions",
		action: {
			kind: "showMe",
			place: "settings",
			spotlight: "settings.instructions",
		},
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "styleAndModel",
		section: "knowsYou",
		drawingSpot: "style",
		action: { kind: "showMe", place: "settings", spotlight: "settings.style" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "skills",
		section: "knowsYou",
		drawingSpot: "skills",
		action: { kind: "showMe", place: "settings", spotlight: "settings.skills" },
		added: BEFORE_THE_GUIDE,
	},
	// ── Your things ──────────────────────────────────────────────────────
	{
		id: "knowledgeBase",
		section: "yourThings",
		drawingSpot: "library",
		action: {
			kind: "showMe",
			place: "knowledge",
			spotlight: "knowledge.library",
		},
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "useADocument",
		section: "yourThings",
		drawingSpot: "fromLibrary",
		action: { kind: "showMe", place: "home", spotlight: "composer.library" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "connectedAccounts",
		section: "yourThings",
		drawingSpot: "connections",
		action: {
			kind: "showMe",
			place: "settings",
			spotlight: "settings.connections",
		},
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "yourOk",
		section: "yourThings",
		drawingSpot: "okCard",
		action: { kind: "none" },
		added: BEFORE_THE_GUIDE,
	},
	// ── Stay organized ───────────────────────────────────────────────────
	{
		id: "projects",
		section: "organized",
		drawingSpot: "projects",
		action: { kind: "showMe", place: null, spotlight: "sidebar.projects" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "search",
		section: "organized",
		drawingSpot: "search",
		action: { kind: "showMe", place: null, spotlight: "sidebar.search" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "tidySidebar",
		section: "organized",
		drawingSpot: "sidebarList",
		action: { kind: "none" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "incognito",
		section: "organized",
		drawingSpot: "incognito",
		action: { kind: "showMe", place: "home", spotlight: "home.incognito" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "home",
		section: "organized",
		drawingSpot: "home",
		action: { kind: "showMe", place: "home", spotlight: "home.home" },
		added: BEFORE_THE_GUIDE,
	},
	// ── Your account ─────────────────────────────────────────────────────
	{
		// Preferences also holds the local time zone; the existing language spotlight stays.
		id: "languageAndLook",
		section: "account",
		drawingSpot: "language",
		action: {
			kind: "showMe",
			place: "settings",
			spotlight: "settings.language",
		},
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "twoStep",
		section: "account",
		drawingSpot: "twoStep",
		action: {
			kind: "showMe",
			place: "settings",
			spotlight: "settings.twoStep",
		},
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "yourData",
		section: "account",
		drawingSpot: "data",
		action: { kind: "showMe", place: "settings", spotlight: "settings.data" },
		added: BEFORE_THE_GUIDE,
	},
	{
		id: "yourActivity",
		section: "account",
		drawingSpot: "activity",
		action: {
			kind: "showMe",
			place: "settings",
			spotlight: "settings.activity",
		},
		added: BEFORE_THE_GUIDE,
	},
];

/** One section's entries, in list order. */
export function guideEntriesFor(
	section: GuideSectionId,
): readonly GuideEntry[] {
	return GUIDE_ENTRIES.filter((entry) => entry.section === section);
}

/** The dictionary key of a section's name or intro. */
export function guideSectionKey(
	section: GuideSectionId,
	field: "name" | "intro",
): I18nKey {
	return `guide.section.${section}.${field}` as I18nKey;
}

/** The dictionary key of an entry's name, line or Try it example. */
export function guideEntryKey(
	id: string,
	field: "name" | "line" | "example",
): I18nKey {
	return `guide.entry.${id}.${field}` as I18nKey;
}
