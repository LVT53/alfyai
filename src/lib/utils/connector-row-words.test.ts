import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import {
	CONNECTOR_PLACEHOLDER_TITLES,
	CONNECTOR_TOOL_NAMES,
	LOCATION_AT_PREFIX,
} from "$lib/shared/tool-reasons";
import { uiLanguage } from "$lib/stores/settings";
import {
	CONNECTOR_PHRASES,
	connectorCountOf,
	connectorPhraseKey,
	connectorThingsIcon,
	connectorUnitKey,
	connectorWordKeys,
	localizedThingTitle,
} from "./connector-row-words";
import { catalogueToolActions } from "./tool-catalogue.test-helpers";

describe("the words of an account row", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("every action of every account tool has a phrase in both languages, read from the model's catalogue", () => {
		for (const tool of CONNECTOR_TOOL_NAMES) {
			const actions = catalogueToolActions(tool);
			expect(
				actions.length,
				`${tool} has no actions in the catalogue`,
			).toBeGreaterThan(0);
			for (const action of actions) {
				const key = connectorPhraseKey(tool, action);
				expect(
					Object.hasOwn(CONNECTOR_PHRASES[tool].actions, action),
					`${tool} ${action} has no phrase of its own`,
				).toBe(true);
				for (const language of ["en", "hu"] as const) {
					uiLanguage.set(language);
					const phrase = get(t)(key as never);
					expect(phrase, `${language} ${tool} ${action}`).not.toBe(key);
					expect(phrase.trim(), `${language} ${tool} ${action}`).not.toBe("");
				}
			}
			// A phrase that is for no action of the catalogue is a leftover.
			expect(Object.keys(CONNECTOR_PHRASES[tool].actions).sort()).toEqual(
				[...actions].sort(),
			);
		}
	});

	it("every word key resolves in English and Hungarian, to different words", () => {
		const keys = connectorWordKeys();
		expect(keys.length).toBeGreaterThan(50);
		for (const key of keys) {
			uiLanguage.set("en");
			const en = get(t)(key, { count: 3, time: "x" });
			uiLanguage.set("hu");
			const hu = get(t)(key, { count: 3, time: "x" });
			expect(en, `${key} in English`).not.toBe(key);
			expect(hu, `${key} in Hungarian`).not.toBe(key);
			expect(hu, `${key} is untranslated`).not.toBe(en);
		}
	});

	it("says the examples the approved screens draw, in both languages", () => {
		uiLanguage.set("en");
		const en = get(t);
		expect(en(connectorPhraseKey("calendar", "list_events") as never)).toBe(
			"Looked at your events",
		);
		expect(
			en(connectorPhraseKey("calendar", "check_availability") as never),
		).toBe("Checked when you're free");
		expect(en(connectorPhraseKey("email", "recent") as never)).toBe(
			"Looked at your inbox",
		);
		uiLanguage.set("hu");
		const hu = get(t);
		expect(hu(connectorPhraseKey("calendar", "list_events") as never)).toBe(
			"Megnézte az eseményeidet",
		);
		expect(
			hu(connectorPhraseKey("calendar", "check_availability") as never),
		).toBe("Megnézte, mikor érsz rá");
		expect(hu(connectorPhraseKey("email", "recent") as never)).toBe(
			"Megnézte a beérkezett leveleidet",
		);
	});

	it("gives an action it does not know the tool's general phrase, and a tool that is no account none", () => {
		expect(connectorPhraseKey("calendar", "a_newer_action")).toBe(
			"toolRows.connector.calendar.other",
		);
		expect(connectorPhraseKey("calendar", undefined)).toBe(
			"toolRows.connector.calendar.other",
		);
		expect(connectorPhraseKey("research_web", "search")).toBeNull();
		expect(connectorPhraseKey("constructor", "list")).toBeNull();
	});

	it("reads the count each account writes, and nothing that is not a whole number", () => {
		expect(connectorCountOf("calendar", { eventCount: 3 })).toBe(3);
		expect(connectorCountOf("email", { messageCount: 5 })).toBe(5);
		expect(connectorCountOf("contacts", { contactCount: 0 })).toBe(0);
		expect(connectorCountOf("repos", { repoCount: 2 })).toBe(2);
		expect(connectorCountOf("tasks", { taskCount: 4 })).toBe(4);
		for (const tool of ["files", "photos", "media", "location"]) {
			expect(connectorCountOf(tool, { resultCount: 7 })).toBe(7);
		}
		// Each account reads its own field: a calendar's count is not a result count.
		expect(connectorCountOf("calendar", { resultCount: 7 })).toBeNull();
		for (const bad of [-1, 1.5, "3", null, true]) {
			expect(connectorCountOf("calendar", { eventCount: bad })).toBeNull();
		}
		expect(connectorCountOf("calendar", undefined)).toBeNull();
		expect(connectorCountOf("research_web", { eventCount: 3 })).toBeNull();
	});

	it("counts events and messages by name, and everything else as 'found'", () => {
		expect(connectorUnitKey("calendar")).toBe("toolRows.unit.events");
		expect(connectorUnitKey("email")).toBe("toolRows.unit.messages");
		for (const tool of [
			"contacts",
			"files",
			"location",
			"media",
			"photos",
			"repos",
			"tasks",
		]) {
			expect(connectorUnitKey(tool), tool).toBe("toolRows.unit.found");
		}
	});

	it("lists what it found by name for every account but files and photos, which keep their strip", () => {
		for (const tool of [
			"calendar",
			"contacts",
			"email",
			"location",
			"media",
			"repos",
			"tasks",
		]) {
			expect(connectorThingsIcon(tool), tool).toBe(tool);
		}
		expect(connectorThingsIcon("files")).toBeNull();
		expect(connectorThingsIcon("photos")).toBeNull();
		expect(connectorThingsIcon("research_web")).toBeNull();
	});

	describe("localizedThingTitle", () => {
		const clock = (iso: string) => `at ${iso}`;

		it("shows the server's English stand-ins as the person's own words", () => {
			uiLanguage.set("en");
			const en = get(t);
			const english: [string, string][] = [
				[CONNECTOR_PLACEHOLDER_TITLES.untitledEvent, "Untitled event"],
				[CONNECTOR_PLACEHOLDER_TITLES.noSubject, "No subject"],
				[CONNECTOR_PLACEHOLDER_TITLES.photo, "Photo"],
				["(unnamed contact)", "Unnamed contact"],
				["(watched item)", "A watched title"],
			];
			for (const [title, shown] of english) {
				expect(localizedThingTitle(title, en, clock), title).toBe(shown);
			}
			uiLanguage.set("hu");
			const hu = get(t);
			const hungarian: [string, string][] = [
				[CONNECTOR_PLACEHOLDER_TITLES.untitledEvent, "Névtelen esemény"],
				[CONNECTOR_PLACEHOLDER_TITLES.noSubject, "Nincs tárgy"],
				[CONNECTOR_PLACEHOLDER_TITLES.photo, "Fotó"],
				["(unnamed contact)", "Névtelen névjegy"],
				["(watched item)", "Megnézett cím"],
			];
			for (const [title, shown] of hungarian) {
				expect(localizedThingTitle(title, hu, clock), title).toBe(shown);
			}
		});

		it("says when a place known only by its time was, in the reader's own format", () => {
			uiLanguage.set("en");
			expect(
				localizedThingTitle(
					`${LOCATION_AT_PREFIX}2026-11-18T18:42:00Z`,
					get(t),
					clock,
				),
			).toBe("A place at at 2026-11-18T18:42:00Z");
			uiLanguage.set("hu");
			expect(
				localizedThingTitle(
					`${LOCATION_AT_PREFIX}2026-11-18T18:42:00Z`,
					get(t),
					clock,
				),
			).toBe("Egy hely, at 2026-11-18T18:42:00Z");
		});

		it("leaves a thing's own name as the account gave it", () => {
			for (const title of [
				"Dentist",
				"Severance — S2E4",
				"#12 Fix the login redirect",
				"Fő utca",
			]) {
				expect(localizedThingTitle(title, get(t), clock)).toBe(title);
			}
		});
	});
});
