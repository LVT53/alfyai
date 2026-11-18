import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import {
	collectDictionaryKeys,
	mergedDictionaryModules,
} from "$lib/i18n.test-helpers";
import {
	BOARD_REFUSAL_REASONS,
	refusalLabelKey,
} from "$lib/shared/artifacts/board-ops";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { uiLanguage } from "$lib/stores/settings";
import artifactsDict from "./artifacts";

// Every merged dictionary module, loaded as a real module object — the same
// set `src/lib/i18n/index.ts` merges, so a namespace added later is covered
// the day it is merged. The colocated tests are excluded: importing them
// eagerly would run their suites inside this one.
const dictionaryModules = import.meta.glob(["./*.ts", "!./*.test.ts"], {
	eager: true,
}) as Record<
	string,
	{ default?: { en: Record<string, string>; hu: Record<string, string> } }
>;

afterEach(() => {
	uiLanguage.set("en");
});

describe("the artifacts dictionary", () => {
	it("has every key in both languages", () => {
		expect(Object.keys(artifactsDict.hu).sort()).toEqual(
			Object.keys(artifactsDict.en).sort(),
		);
	});

	it("names the five types with ADR-0066's words — Canvas is Tábla in Hungarian", () => {
		expect({
			file: artifactsDict.en["artifacts.type.file"],
			document: artifactsDict.en["artifacts.type.document"],
			app: artifactsDict.en["artifacts.type.app"],
			canvas: artifactsDict.en["artifacts.type.canvas"],
			slides: artifactsDict.en["artifacts.type.slides"],
		}).toEqual({
			file: "File",
			document: "Document",
			app: "App",
			canvas: "Canvas",
			slides: "Slides",
		});
		expect({
			file: artifactsDict.hu["artifacts.type.file"],
			document: artifactsDict.hu["artifacts.type.document"],
			app: artifactsDict.hu["artifacts.type.app"],
			canvas: artifactsDict.hu["artifacts.type.canvas"],
			slides: artifactsDict.hu["artifacts.type.slides"],
		}).toEqual({
			file: "Fájl",
			document: "Dokumentum",
			app: "Alkalmazás",
			canvas: "Tábla",
			slides: "Diasor",
		});
	});

	it("is merged into the app's dictionary and watched by the parity test", () => {
		expect(mergedDictionaryModules()).toContain("artifacts");
		const keys = collectDictionaryKeys();
		expect(keys.en).toContain("artifacts.type.canvas");
		expect(keys.hu).toContain("artifacts.type.canvas");

		expect(get(t)("artifacts.type.canvas")).toBe("Canvas");
		uiLanguage.set("hu");
		expect(get(t)("artifacts.type.canvas")).toBe("Tábla");
	});

	it("counts items with a singular in English and none needed in Hungarian", () => {
		const translate = get(t);
		expect(translate("artifacts.panel.count", { count: 1 })).toBe(
			"1 item · newest first",
		);
		expect(translate("artifacts.panel.count", { count: 6 })).toBe(
			"6 items · newest first",
		);
		uiLanguage.set("hu");
		expect(get(t)("artifacts.panel.count", { count: 6 })).toBe(
			"6 elem · legújabb elöl",
		);
	});
});

// ADR-0066: "Artifact" is AlfyAI's engineering word; the UI never shows it,
// in English or Hungarian — not in a label, a title, an aria-label or an
// error. Checked across every dictionary the app merges, not just this
// feature's, because the rule is the app's.
// RC-A (the audit's copy seams, ruling 77's principle: one short, natural word): a
// retry button read "Újrapróbálom" in a Download, "Újrapróbálkozás" under a file's
// preview and in History, "Próbáld újra" in a board's picture and "Újra" on a board
// block (which is also the Hungarian for Redo). Every retry button of the panel and of
// the file card says it one way, in Hungarian.
describe("the retry buttons", () => {
	const RETRY_BUTTONS = [
		"artifacts.action.retry",
		"artifacts.take.tryAgain",
		"artifacts.document.export.tryAgain",
		"artifacts.canvas.retry",
		"artifacts.canvas.chat.retry",
		"artifacts.canvas.export.tryAgain",
		"common.retry",
		"filePreview.retry",
		"fileProduction.retry",
	];

	it("say 'Újrapróbálom' in Hungarian, whichever surface they are on", () => {
		const hu: Record<string, string> = {};
		for (const module of Object.values(dictionaryModules)) {
			Object.assign(hu, module.default?.hu ?? {});
		}
		for (const key of RETRY_BUTTONS) {
			expect(hu[key], key).toBe("Újrapróbálom");
		}
	});
});

// The one exception (owner, 2026-11-18; ADR-0066, amended): the English name of
// the chat's list, "Chat Artifacts", in the strings that name it. The Hungarian
// names it without the word ("A beszélgetés elemei"), and no other value may use it.
const CHAT_ARTIFACTS_KEYS = new Set([
	"artifacts.panel.title",
	"artifacts.header.buttonA11y",
	"artifacts.header.buttonA11yPending",
	"artifacts.error.list",
]);

describe("the word 'artifact' in the UI", () => {
	it("appears in no dictionary value, in either language, but the English name of the chat's list", () => {
		const offenders: string[] = [];
		const modules = mergedDictionaryModules();
		for (const [path, loaded] of Object.entries(dictionaryModules)) {
			const name = path.replace(/^\.\//, "").replace(/\.ts$/, "");
			if (!modules.includes(name) || !loaded.default) continue;
			for (const language of ["en", "hu"] as const) {
				for (const [key, value] of Object.entries(loaded.default[language])) {
					const named =
						name === "artifacts" &&
						language === "en" &&
						CHAT_ARTIFACTS_KEYS.has(key);
					const checked = named ? value.replace("Chat Artifacts", "") : value;
					if (/artifact|artefakt/i.test(checked)) {
						offenders.push(`${name}.${language} ${key}: ${value}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
		// The walk above saw every merged module, so a pass is a real pass.
		expect(
			Object.keys(dictionaryModules).filter((path) =>
				modules.includes(path.replace(/^\.\//, "").replace(/\.ts$/, "")),
			),
		).toHaveLength(modules.length);
	});

	it("names the chat's list Chat Artifacts in English, and A beszélgetés elemei in Hungarian", () => {
		for (const key of CHAT_ARTIFACTS_KEYS) {
			const name = key as keyof typeof artifactsDict.en;
			expect(artifactsDict.en[name], key).toContain("Chat Artifacts");
			expect(artifactsDict.hu[name], key).toMatch(/a beszélgetés elemei/i);
		}
	});
});

// The first-open tours' chrome and the empty states' lines (Slice 6 T7). The
// parity test above covers "every key in both languages"; this names the keys
// the card, the list's menu and the three empty states read, so a key that
// loses its reader, or a reader that loses its key, shows up here.
describe("the tours' strings", () => {
	const TOUR_KEYS = [
		"artifacts.tour.region",
		"artifacts.tour.stepOf",
		"artifacts.tour.dots",
		"artifacts.tour.next",
		"artifacts.tour.back",
		"artifacts.tour.done",
		"artifacts.tour.skip",
		"artifacts.tour.replayHint",
		"artifacts.tour.replayOpened",
		"artifacts.tour.replay",
	] as const;
	const EMPTY_STATE_KEYS = [
		"artifacts.document.emptyState",
		"artifacts.app.emptyState",
		"artifacts.canvas.emptyBoard",
	] as const;

	it("has exactly the artifacts.tour keys the card, the menu and the empty states read, in both languages", () => {
		for (const language of ["en", "hu"] as const) {
			const present = Object.keys(artifactsDict[language]).filter((key) =>
				key.startsWith("artifacts.tour."),
			);
			expect(present.sort()).toEqual([...TOUR_KEYS].sort());
			for (const key of TOUR_KEYS) {
				expect(
					artifactsDict[language][key].trim(),
					`${language} ${key}`,
				).not.toBe("");
			}
		}
	});

	it("has the three empty states' fallback lines in both languages, none blank", () => {
		for (const language of ["en", "hu"] as const) {
			for (const key of EMPTY_STATE_KEYS) {
				expect(artifactsDict[language][key].trim().length).toBeGreaterThan(10);
			}
		}
	});

	it("keeps each tour string's placeholders the same in both languages", () => {
		// The house plural, `{count, plural, one {} other {s}}`, counts as the one
		// parameter it reads (`t()` resolves it, and its branches take no braces).
		const placeholders = (text: string) =>
			[
				...new Set(
					[
						...text
							.replace(
								/\{(\w+), plural, one \{[^{}]*\} other \{[^{}]*\}\}/g,
								"{$1}",
							)
							.matchAll(/\{(\w+)\}/g),
					].map((match) => match[1]),
				),
			].sort();
		for (const key of TOUR_KEYS) {
			expect(placeholders(artifactsDict.hu[key]), key).toEqual(
				placeholders(artifactsDict.en[key]),
			);
		}
	});

	it("says Újra megnézem and Show it again for the link, and never the engineering word", () => {
		expect(artifactsDict.en["artifacts.tour.replay"]).toBe("Show it again");
		expect(artifactsDict.hu["artifacts.tour.replay"]).toBe("Újra megnézem");
		for (const language of ["en", "hu"] as const) {
			for (const key of [...TOUR_KEYS, ...EMPTY_STATE_KEYS]) {
				expect(artifactsDict[language][key], `${language} ${key}`).not.toMatch(
					/artifact|artefakt/i,
				);
			}
		}
	});
});

// The Canvas tells the reader why a change of Alfy's skipped a block, in the
// reader's own language: every reason the board can refuse for has a sentence,
// in both. (`refusalLabelKey` is an exhaustive switch, so a new reason cannot
// compile without a key; this is the half the compiler cannot see.)
describe("the Canvas's refusal sentences", () => {
	it("has a sentence, in English and in Hungarian, for every reason a board refuses for", () => {
		for (const reason of BOARD_REFUSAL_REASONS) {
			const key = refusalLabelKey(reason);
			expect(artifactsDict.en, `${reason} in English`).toHaveProperty(key);
			expect(artifactsDict.hu, `${reason} in Hungarian`).toHaveProperty(key);
			expect((artifactsDict.hu as Record<string, string>)[key].trim()).not.toBe(
				"",
			);
		}
	});
});

// RV-3 Minor 8 and I2: a native speaker read the board's Hungarian and named the
// sentences that read as translations; the refused-save banner named nobody and
// blamed a reader "who was drawing". These pin what they were changed to.
describe("the Canvas's wording after the review (RV-3 Minor 8, I2, Minor 9)", () => {
	const en = artifactsDict.en as Record<string, string>;
	const hu = artifactsDict.hu as Record<string, string>;

	it("says in Hungarian what a Hungarian reader would say", () => {
		expect(hu["artifacts.canvas.redo"]).toBe("Saját lépés ismét");
		expect(hu["artifacts.canvas.offline"]).toBe(
			"Nincs kapcsolat. A rajzod megmarad, a módosításaidat a kapcsolat helyreálltával mentjük.",
		);
		expect(hu["artifacts.canvas.comment.placed"]).toBe(
			"Megjegyzés indítva — írd meg a listában.",
		);
		expect(hu["artifacts.canvas.arranging"]).toBe("Alfy dolgozik a táblán…");
		expect(hu["artifacts.canvas.arrangingSummary"]).toBe(
			"Alfy dolgozik a táblán: {summary}",
		);
		expect(hu["artifacts.canvas.staleBadge"]).toBe("Elavult");
		expect(hu["artifacts.canvas.comment.blockGone"]).toBe(
			"A blokk már nem létezik.",
		);
		expect(hu["artifacts.canvas.checklistReadOnlyNote"]).toBe(
			"Az itt kipipált elemeket a táblával együtt mentjük.",
		);
		expect(hu["artifacts.canvas.review.landedLeft"]).toBe(
			"{summary} {left} módosítást kihagyott. Nézd át a tábla alatt.",
		);
	});

	it("says what happened when a save is refused: Alfy or another window changed the board, and the last step was not saved", () => {
		const english = en["artifacts.canvas.saveConflict"];
		expect(english).toContain("Alfy");
		expect(english).toContain("your last step was not saved");
		expect(english).not.toMatch(/someone|drawing/i);
		const hungarian = hu["artifacts.canvas.saveConflict"];
		expect(hungarian).toContain("Alfy");
		expect(hungarian).toContain("utolsó lépésedet nem sikerült elmenteni");
		expect(hungarian).not.toMatch(/valaki|rajzolt/i);
	});

	it("gives the zoom group and the button that zooms in different names, in both languages", () => {
		for (const dict of [en, hu]) {
			expect(dict["artifacts.canvas.zoom"]).not.toBe(
				dict["artifacts.canvas.zoomIn"],
			);
			expect(dict["artifacts.canvas.zoom"]).not.toBe(
				dict["artifacts.canvas.zoomOut"],
			);
		}
		expect(hu["artifacts.canvas.zoom"]).toBe("Nagyítás mértéke");
	});
});

describe("the Video kind's strings", () => {
	it("names the kind Video / Videó, and says a deleted one was deleted", () => {
		expect(artifactsDict.en["artifacts.type.video"]).toBe("Video");
		expect(artifactsDict.hu["artifacts.type.video"]).toBe("Videó");
		expect(artifactsDict.en["artifacts.deleted.video"]).toBe(
			"This video was deleted",
		);
		expect(artifactsDict.hu["artifacts.deleted.video"]).toBe(
			"Ez a videó törölve lett",
		);
	});

	it("reads the panel's two downloads as a pair, in both languages", () => {
		expect(artifactsDict.en["artifacts.video.panel.downloadMp4"]).toBe(
			"Download as MP4",
		);
		expect(artifactsDict.en["artifacts.video.panel.downloadGif"]).toBe(
			"Download as GIF",
		);
		expect(artifactsDict.hu["artifacts.video.panel.downloadMp4"]).toBe(
			"Letöltés MP4-ként",
		);
		expect(artifactsDict.hu["artifacts.video.panel.downloadGif"]).toBe(
			"Letöltés GIF-ként",
		);
	});

	it("announces the player's loop and mute changes, in both languages", () => {
		expect(artifactsDict.en["artifacts.video.player.loopOn"]).toBe("Loop on");
		expect(artifactsDict.en["artifacts.video.player.loopOff"]).toBe("Loop off");
		expect(artifactsDict.en["artifacts.video.player.muted"]).toBe("Muted");
		expect(artifactsDict.en["artifacts.video.player.unmuted"]).toBe("Unmuted");
		expect(artifactsDict.hu["artifacts.video.player.loopOn"]).toBe(
			"Ismétlés be",
		);
		expect(artifactsDict.hu["artifacts.video.player.loopOff"]).toBe(
			"Ismétlés ki",
		);
		expect(artifactsDict.hu["artifacts.video.player.muted"]).toBe("Némítva");
		expect(artifactsDict.hu["artifacts.video.player.unmuted"]).toBe(
			"Némítás kikapcsolva",
		);
	});

	it("names the player's fullscreen toggle and its scrubber in both languages", () => {
		expect(artifactsDict.en["artifacts.video.player.fullscreen"]).toBe(
			"Enter fullscreen",
		);
		expect(artifactsDict.en["artifacts.video.player.exitFullscreen"]).toBe(
			"Exit fullscreen",
		);
		expect(artifactsDict.hu["artifacts.video.player.fullscreen"]).toBe(
			"Belépés a teljes képernyőbe",
		);
		expect(artifactsDict.hu["artifacts.video.player.exitFullscreen"]).toBe(
			"Kilépés a teljes képernyőből",
		);
		expect(artifactsDict.en["artifacts.video.player.position"]).toBe(
			"Position",
		);
		expect(artifactsDict.en["artifacts.video.player.positionAt"]).toBe(
			"{current} of {duration} seconds",
		);
		expect(artifactsDict.hu["artifacts.video.player.position"]).toBe("Pozíció");
		expect(artifactsDict.hu["artifacts.video.player.positionAt"]).toBe(
			"{current} / {duration} másodperc",
		);
		expect(artifactsDict.en["artifacts.video.player.loop"]).toBe("Loop");
		expect(artifactsDict.en["artifacts.video.player.mute"]).toBe("Mute");
		expect(artifactsDict.hu["artifacts.video.player.loop"]).toBe("Ismétlés");
		expect(artifactsDict.hu["artifacts.video.player.mute"]).toBe("Némítás");
	});

	it("says History is not shown for a clip yet, rather than that it has none", () => {
		expect(artifactsDict.en["artifacts.video.card.historyUnavailable"]).toBe(
			"History isn't shown for a clip yet.",
		);
		expect(artifactsDict.hu["artifacts.video.card.historyUnavailable"]).toBe(
			"A klip előzményei még nem jelennek meg.",
		);
	});

	it("says where a clip or a picture out of reach opens, in one sentence", () => {
		expect(artifactsDict.en["artifacts.take.elsewhereDetail"]).toBe(
			"Open it from the chat it was made in.",
		);
		expect(artifactsDict.hu["artifacts.take.elsewhereDetail"]).toBe(
			"Abban a beszélgetésben nyitható meg, ahol készült.",
		);
	});

	it("says a deleted video can be regenerated from the chat, in both languages", () => {
		expect(artifactsDict.en["artifacts.delete.bodyRegenerable.video"]).toBe(
			"“{title}” will be deleted. You can regenerate it from the chat.",
		);
		expect(artifactsDict.hu["artifacts.delete.bodyRegenerable.video"]).toBe(
			"„{title}” törlődik. A beszélgetésből újra létrehozhatod.",
		);
	});
});

describe("the Image kind's strings", () => {
	it("names the kind Image / Kep, never Artifact", () => {
		uiLanguage.set("en");
		expect(get(t)("artifacts.type.image")).toBe("Image");
		uiLanguage.set("hu");
		expect(get(t)("artifacts.type.image")).toBe("Kép");
	});

	it("names pictures in the bulk delete dialog, in both languages", () => {
		uiLanguage.set("en");
		expect(get(t)("sidebar.deleteConversationsMessage")).toBe(
			"Their messages, files, reports, and the Documents and pictures made in them are deleted too. This can't be undone.",
		);
		uiLanguage.set("hu");
		expect(get(t)("sidebar.deleteConversationsMessage")).toBe(
			"Az üzeneteik, fájljaik, jelentéseik, valamint a bennük készült dokumentumok és képek is törlődnek. Ez nem vonható vissza.",
		);
		expect(get(t)("sidebar.deleteConversationsMessage")).toContain(
			"dokumentumok és képek",
		);
	});

	it("names a picture in its delete button, question and confirmation, in both languages", () => {
		expect(artifactsDict.en["artifacts.delete.button.image"]).toBe(
			"Delete picture",
		);
		expect(artifactsDict.en["artifacts.delete.title.image"]).toBe(
			"Delete this picture?",
		);
		expect(artifactsDict.en["artifacts.delete.done.image"]).toBe(
			"Picture deleted",
		);
		expect(artifactsDict.hu["artifacts.delete.button.image"]).toBe(
			"Kép törlése",
		);
		expect(artifactsDict.hu["artifacts.delete.title.image"]).toBe(
			"Törlöd ezt a képet?",
		);
		expect(artifactsDict.hu["artifacts.delete.done.image"]).toBe("Kép törölve");
	});
});

// The panel and the delete popover build these keys from the kind
// (`artifacts.delete.button.${kind}`), so a missing one shows its raw key and
// the type checker cannot see it: the night walk of 2026-11-17 found every
// picture's delete words missing. Every kind of the union, in both languages.
describe("every artifact kind has its delete and name words", () => {
	const kinds = Object.keys({
		document: true,
		app: true,
		canvas: true,
		slides: true,
		file: true,
		image: true,
		video: true,
	} satisfies Record<ArtifactKind, true>) as ArtifactKind[];
	const families = [
		"delete.button",
		"delete.title",
		"delete.body",
		"delete.bodyRegenerable",
		"delete.done",
		"deleted",
		"type",
	];

	it.each(kinds)("%s", (kind) => {
		for (const family of families) {
			const key = `artifacts.${family}.${kind}`;
			const en = (artifactsDict.en as Record<string, string>)[key];
			const hu = (artifactsDict.hu as Record<string, string>)[key];
			expect(en, `${key} in English`).toEqual(expect.any(String));
			expect(en?.trim(), `${key} in English`).not.toBe("");
			expect(hu, `${key} in Hungarian`).toEqual(expect.any(String));
			expect(hu?.trim(), `${key} in Hungarian`).not.toBe("");
		}
	});
});
