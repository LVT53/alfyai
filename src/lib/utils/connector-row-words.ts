// What an account row says, in plain words: one phrase per action each of the nine
// account tools offers, what each counts, and the person's own words for the
// English stand-ins the tools give a thing that has no name.
//
// The server's tools are written for the model: an action is `list_events`, an
// event with no title is "(untitled event)". A person reads "Looked at your
// events" and "Untitled event", in their own language. Each action of each tool has
// a phrase here (the test reads the actions from the model's tool catalogue, so an
// action added there fails it until its phrase is written), and the keys are listed
// out so a missing one does not compile.

import type { I18nKey } from "$lib/i18n";
import {
	CONNECTOR_PLACEHOLDER_TITLES,
	type CONNECTOR_TOOL_NAMES,
	LOCATION_AT_PREFIX,
} from "$lib/shared/tool-reasons";
import type { ToolCallIconType } from "$lib/utils/tool-calls";

export type ConnectorTool = (typeof CONNECTOR_TOOL_NAMES)[number];

type ConnectorPhrases = {
	/** One phrase per value of the tool's `action` enum (`normal-chat-tools/index.ts`). */
	actions: Readonly<Record<string, I18nKey>>;
	/** For an action this list does not know (an older call, a newer tool). */
	other: I18nKey;
};

export const CONNECTOR_PHRASES: Readonly<
	Record<ConnectorTool, ConnectorPhrases>
> = {
	calendar: {
		actions: {
			list_events: "toolRows.connector.calendar.list_events",
			list_calendars: "toolRows.connector.calendar.list_calendars",
			check_availability: "toolRows.connector.calendar.check_availability",
			create_event: "toolRows.connector.calendar.create_event",
			update_event: "toolRows.connector.calendar.update_event",
			delete_event: "toolRows.connector.calendar.delete_event",
		},
		other: "toolRows.connector.calendar.other",
	},
	contacts: {
		actions: {
			lookup: "toolRows.connector.contacts.lookup",
			group: "toolRows.connector.contacts.group",
		},
		other: "toolRows.connector.contacts.other",
	},
	email: {
		actions: {
			recent: "toolRows.connector.email.recent",
			search: "toolRows.connector.email.search",
			count: "toolRows.connector.email.count",
			read: "toolRows.connector.email.read",
			list_folders: "toolRows.connector.email.list_folders",
			send: "toolRows.connector.email.send",
			trash: "toolRows.connector.email.trash",
			flag: "toolRows.connector.email.flag",
		},
		other: "toolRows.connector.email.other",
	},
	files: {
		actions: {
			list: "toolRows.connector.files.list",
			search: "toolRows.connector.files.search",
			read: "toolRows.connector.files.read",
			save: "toolRows.connector.files.save",
			move: "toolRows.connector.files.move",
			delete: "toolRows.connector.files.delete",
			create_folder: "toolRows.connector.files.create_folder",
			share_link: "toolRows.connector.files.share_link",
		},
		other: "toolRows.connector.files.other",
	},
	location: {
		actions: {
			last: "toolRows.connector.location.last",
			history: "toolRows.connector.location.history",
			places: "toolRows.connector.location.places",
			distance: "toolRows.connector.location.distance",
		},
		other: "toolRows.connector.location.other",
	},
	media: {
		actions: {
			watch_history: "toolRows.connector.media.watch_history",
			libraries: "toolRows.connector.media.libraries",
			continue_watching: "toolRows.connector.media.continue_watching",
			library_search: "toolRows.connector.media.library_search",
		},
		other: "toolRows.connector.media.other",
	},
	photos: {
		actions: {
			search: "toolRows.connector.photos.search",
			search_by_date: "toolRows.connector.photos.search_by_date",
			list_albums: "toolRows.connector.photos.list_albums",
			album: "toolRows.connector.photos.album",
			list_people: "toolRows.connector.photos.list_people",
			add_to_album: "toolRows.connector.photos.add_to_album",
		},
		other: "toolRows.connector.photos.other",
	},
	repos: {
		actions: {
			list_repos: "toolRows.connector.repos.list_repos",
			read_file: "toolRows.connector.repos.read_file",
			list_issues: "toolRows.connector.repos.list_issues",
			list_prs: "toolRows.connector.repos.list_prs",
			list_commits: "toolRows.connector.repos.list_commits",
			ci_status: "toolRows.connector.repos.ci_status",
			search_code: "toolRows.connector.repos.search_code",
		},
		other: "toolRows.connector.repos.other",
	},
	tasks: {
		actions: {
			list_tasks: "toolRows.connector.tasks.list_tasks",
			search_tasks: "toolRows.connector.tasks.search_tasks",
		},
		other: "toolRows.connector.tasks.other",
	},
};

function isConnectorTool(name: string): name is ConnectorTool {
	return Object.hasOwn(CONNECTOR_PHRASES, name);
}

/** The phrase for one call of an account tool: its action's own, else the tool's general one. */
export function connectorPhraseKey(
	tool: string,
	action: unknown,
): I18nKey | null {
	if (!isConnectorTool(tool)) return null;
	const phrases = CONNECTOR_PHRASES[tool];
	return typeof action === "string" && Object.hasOwn(phrases.actions, action)
		? phrases.actions[action]
		: phrases.other;
}

/** The metadata field each account tool writes the number of things a call found to. */
const COUNT_FIELDS: Readonly<Record<ConnectorTool, string>> = {
	calendar: "eventCount",
	contacts: "contactCount",
	email: "messageCount",
	files: "resultCount",
	location: "resultCount",
	media: "resultCount",
	photos: "resultCount",
	repos: "repoCount",
	tasks: "taskCount",
};

/** What a call found: its count, or null when the call carries none (or is no account tool). */
export function connectorCountOf(
	tool: string,
	metadata: Record<string, string | number | boolean | null> | undefined,
): number | null {
	if (!isConnectorTool(tool)) return null;
	const count = metadata?.[COUNT_FIELDS[tool]];
	return typeof count === "number" && Number.isInteger(count) && count >= 0
		? count
		: null;
}

/**
 * The unit a row counts in: events and messages are told apart, and every other
 * account says only how many it found (a contacts row that said "2 contacts" would
 * repeat its own verb).
 */
const UNIT_KEYS: Readonly<Record<ConnectorTool, I18nKey>> = {
	calendar: "toolRows.unit.events",
	contacts: "toolRows.unit.found",
	email: "toolRows.unit.messages",
	files: "toolRows.unit.found",
	location: "toolRows.unit.found",
	media: "toolRows.unit.found",
	photos: "toolRows.unit.found",
	repos: "toolRows.unit.found",
	tasks: "toolRows.unit.found",
};

export function connectorUnitKey(tool: string): I18nKey {
	return isConnectorTool(tool) ? UNIT_KEYS[tool] : "toolRows.unit.found";
}

/**
 * Which accounts list what they found by name under a call, and the glyph before
 * each. Files and photos are left out on purpose: they keep their own strip under
 * the reply (file cards, photo thumbnails), and a list of names would repeat it.
 */
const THINGS_ICONS: Readonly<Partial<Record<ConnectorTool, ToolCallIconType>>> =
	{
		calendar: "calendar",
		contacts: "contacts",
		email: "email",
		location: "location",
		media: "media",
		repos: "repos",
		tasks: "tasks",
	};

export function connectorThingsIcon(tool: string): ToolCallIconType | null {
	return isConnectorTool(tool) ? (THINGS_ICONS[tool] ?? null) : null;
}

/**
 * The titles the account tools give a thing that has none, in English, for the
 * model. The first four are shared with the server (`$lib/shared/tool-reasons`);
 * the contacts and media tools wrote theirs in place, and still do.
 */
const UNNAMED_CONTACT_TITLE = "(unnamed contact)";
const WATCHED_ITEM_TITLE = "(watched item)";

/**
 * A thing's title as a person reads it: the server's English stand-in for "no name"
 * becomes the person's own word, and a place known only by when it was
 * ("Location at 2026-11-18T18:42:00Z") says when in the reader's own format.
 * Anything else is the thing's own name, as the account gave it.
 */
export function localizedThingTitle(
	title: string,
	translate: (key: I18nKey, params?: Record<string, string | number>) => string,
	formatTime: (iso: string) => string,
): string {
	switch (title) {
		case CONNECTOR_PLACEHOLDER_TITLES.untitledEvent:
			return translate("toolRows.placeholder.untitledEvent");
		case CONNECTOR_PLACEHOLDER_TITLES.noSubject:
			return translate("toolRows.placeholder.noSubject");
		case CONNECTOR_PLACEHOLDER_TITLES.photo:
			return translate("toolRows.placeholder.photo");
		case UNNAMED_CONTACT_TITLE:
			return translate("toolRows.placeholder.unnamedContact");
		case WATCHED_ITEM_TITLE:
			return translate("toolRows.placeholder.watchedItem");
	}
	if (title.startsWith(LOCATION_AT_PREFIX)) {
		const iso = title.slice(LOCATION_AT_PREFIX.length).trim();
		return translate("toolRows.placeholder.placeAt", { time: formatTime(iso) });
	}
	return title;
}

/**
 * The accounts whose Hungarian name is a plural: "Névjegyek nincsenek
 * csatlakoztatva", where "Naptár nincs csatlakoztatva" is singular. English has
 * no number to agree, and says the same words for both.
 */
const PLURAL_ACCOUNTS: ReadonlySet<ConnectorTool> = new Set([
	"contacts",
	"files",
	"photos",
	"repos",
	"tasks",
]);

/** What an account row says of a run whose every call found the account not connected, agreeing with the account's name. */
export function connectorNotConnectedKey(tool: string): I18nKey {
	return isConnectorTool(tool) && PLURAL_ACCOUNTS.has(tool)
		? "toolRows.object.notConnectedPlural"
		: "toolRows.object.notConnected";
}

/** Every word key this module can answer with, for the one test that asserts each resolves in both languages. */
export function connectorWordKeys(): I18nKey[] {
	const keys = new Set<I18nKey>([
		"toolRows.unit.events",
		"toolRows.unit.messages",
		"toolRows.unit.found",
		"toolRows.object.notConnected",
		"toolRows.object.notConnectedPlural",
		"toolRows.placeholder.untitledEvent",
		"toolRows.placeholder.noSubject",
		"toolRows.placeholder.photo",
		"toolRows.placeholder.placeAt",
		"toolRows.placeholder.unnamedContact",
		"toolRows.placeholder.watchedItem",
	]);
	for (const phrases of Object.values(CONNECTOR_PHRASES)) {
		for (const key of Object.values(phrases.actions)) keys.add(key);
		keys.add(phrases.other);
	}
	return [...keys];
}
