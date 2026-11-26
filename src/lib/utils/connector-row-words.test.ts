// @vitest-environment jsdom
import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import chatDict from "$lib/i18n/chat";
import toolRowsDict from "$lib/i18n/tool-rows";
import {
	CONNECTOR_PLACEHOLDER_TITLES,
	CONNECTOR_TOOL_NAMES,
	LOCATION_AT_PREFIX,
} from "$lib/shared/tool-reasons";
import { uiLanguage } from "$lib/stores/settings";
import {
	CONNECTOR_PHRASES,
	connectorCountOf,
	connectorNotConnectedKey,
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

	// One account is one noun, in the row's label and in every sentence about it:
	// the name Settings › Connections gives it. Hungarian rows used to say "Helyzet",
	// "Kód" and "Teendők" over sentences about "helyadatok", "kódtárak" and
	// "teendők", where Settings says "Helymeghatározás", "Tárolók" and "Feladatok".
	describe("one noun for one account", () => {
		it("labels an account's row with the name Settings gives it, in both languages", () => {
			for (const language of ["en", "hu"] as const) {
				uiLanguage.set(language);
				const translate = get(t);
				for (const tool of CONNECTOR_TOOL_NAMES) {
					expect(
						translate(`toolCalls.${tool}` as never),
						`${language} ${tool}`,
					).toBe(translate(`connections.capability.${tool}` as never));
				}
			}
		});

		const ACCOUNT_STEMS = {
			calendar: "naptár",
			contacts: "névjegy",
			email: "e-mail",
			files: "fájl",
			location: "helymeghatár|helyadat",
			media: "médi",
			photos: "fénykép",
			repos: "tároló",
			tasks: "feladat",
		} as const;

		it("says its account by Settings' noun in every sentence, and by none of the nouns it used to use", () => {
			const words = (language: "en" | "hu") => ({
				...Object.fromEntries(
					Object.entries(toolRowsDict[language]).filter(([key]) =>
						/^toolRows\.(connector|placeholder|object|unit)\./.test(key),
					),
				),
				...Object.fromEntries(
					Object.entries(chatDict[language]).filter(
						([key]) =>
							/^toolCalls\.(calendar|contacts|email|files|location|media|photos|repos|tasks)$/.test(
								key,
							) || key === "toolActivity.photosViewed",
					),
				),
			});
			const retired = {
				hu: [/levelezés/i, /kódtár/i, /teendő/i, /helyforrás/i, /fotó/i],
				en: [/code account/i, /location source/i],
			} as const;
			for (const language of ["en", "hu"] as const) {
				for (const [key, value] of Object.entries(words(language))) {
					for (const noun of retired[language]) {
						expect(value, `${language} ${key}`).not.toMatch(noun);
					}
				}
			}
			// Each tool's sentences about the account itself (connecting it, changing it,
			// using it) name it the way Settings does.
			for (const tool of CONNECTOR_TOOL_NAMES) {
				const stem = new RegExp(ACCOUNT_STEMS[tool], "i");
				for (const code of [
					"not_connected",
					"needs_reconnect",
					"writes_turned_off",
					"fallback",
				]) {
					const value =
						toolRowsDict.hu[`toolRows.connector.${tool}.${code}` as never];
					expect(value, `hu ${tool} ${code}`).toMatch(stem);
				}
			}
		});

		it("agrees 'not connected' with the account's number: Névjegyek nincsenek, Naptár nincs", () => {
			const plural = ["contacts", "files", "photos", "repos", "tasks"];
			const singular = ["calendar", "email", "location", "media"];
			expect([...plural, ...singular].sort()).toEqual(
				[...CONNECTOR_TOOL_NAMES].sort(),
			);
			uiLanguage.set("hu");
			for (const tool of plural) {
				expect(get(t)(connectorNotConnectedKey(tool)), tool).toBe(
					"nincsenek csatlakoztatva",
				);
			}
			for (const tool of singular) {
				expect(get(t)(connectorNotConnectedKey(tool)), tool).toBe(
					"nincs csatlakoztatva",
				);
			}
			// English has no number to agree: one phrase for the nine.
			uiLanguage.set("en");
			for (const tool of CONNECTOR_TOOL_NAMES) {
				expect(get(t)(connectorNotConnectedKey(tool)), tool).toBe(
					"not connected",
				);
			}
			// A name that is no account tool gets the singular, as before.
			expect(connectorNotConnectedKey("research_web")).toBe(
				"toolRows.object.notConnected",
			);
		});

		it("says each case the review found, in the nouns above", () => {
			const sentence = (language: "en" | "hu", tool: string, code: string) =>
				toolRowsDict[language][`toolRows.connector.${tool}.${code}` as never] as
					| string
					| undefined;
			const hu: [string, string, string][] = [
				[
					"email",
					"no_such_account",
					"Nincs ilyen nevű csatlakoztatott e-mail-fiók.",
				],
				[
					"email",
					"read_only_account",
					"Ez az e-mail-fiók csak olvasható, nem módosítható.",
				],
				[
					"email",
					"account_unreachable",
					"A levelezőszerver nem válaszolt, ezért Alfy nem tudott belenézni.",
				],
				[
					"contacts",
					"account_unreachable",
					"A névjegyzék nem válaszolt, ezért Alfy nem tudott belenézni.",
				],
				["contacts", "not_supported", "Ez a névjegyzék erre nem képes."],
				[
					"tasks",
					"account_unreachable",
					"A feladatlista nem válaszolt, ezért Alfy nem tudott belenézni.",
				],
				["files", "not_set_up", "A tárhelyed még nincs beállítva."],
				["photos", "not_set_up", "A fényképtárad még nincs beállítva."],
				[
					"location",
					"no_such_account",
					"Nincs ilyen nevű csatlakoztatott helyszolgáltatás.",
				],
				[
					"location",
					"account_unreachable",
					"A helyszolgáltatás nem válaszolt, ezért Alfy nem tudott belenézni.",
				],
				["location", "not_supported", "A helyszolgáltatás erre nem képes."],
				[
					"location",
					"not_set_up",
					"A helyadatok még nincsenek teljesen beállítva.",
				],
			];
			for (const [tool, code, expected] of hu) {
				expect(sentence("hu", tool, code), `hu ${tool} ${code}`).toBe(expected);
			}
			const en: [string, string, string][] = [
				["files", "not_set_up", "Your file storage isn't set up yet."],
				["photos", "not_set_up", "Your photo library isn't set up yet."],
				["location", "not_set_up", "Location isn't fully set up yet."],
				[
					"location",
					"no_such_account",
					"There's no connected location service by that name.",
				],
				[
					"repos",
					"no_such_account",
					"There's no connected repository account by that name.",
				],
			];
			for (const [tool, code, expected] of en) {
				expect(sentence("en", tool, code), `en ${tool} ${code}`).toBe(expected);
			}
		});
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
				["(watched item)", "Something you watched"],
			];
			for (const [title, shown] of english) {
				expect(localizedThingTitle(title, en, clock), title).toBe(shown);
			}
			uiLanguage.set("hu");
			const hu = get(t);
			const hungarian: [string, string][] = [
				[CONNECTOR_PLACEHOLDER_TITLES.untitledEvent, "Névtelen esemény"],
				[CONNECTOR_PLACEHOLDER_TITLES.noSubject, "Nincs tárgy"],
				[CONNECTOR_PLACEHOLDER_TITLES.photo, "Fénykép"],
				["(unnamed contact)", "Névtelen névjegy"],
				["(watched item)", "Megnézett műsor"],
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
			).toBe("Unnamed place, at 2026-11-18T18:42:00Z");
			uiLanguage.set("hu");
			expect(
				localizedThingTitle(
					`${LOCATION_AT_PREFIX}2026-11-18T18:42:00Z`,
					get(t),
					clock,
				),
			).toBe("Névtelen hely, at 2026-11-18T18:42:00Z");
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
