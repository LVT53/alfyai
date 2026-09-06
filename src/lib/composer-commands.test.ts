import { describe, expect, it } from "vitest";
import chatDict from "./i18n/chat";
import {
	type ComposerCommandDefinition,
	HIDDEN_COMPOSER_COMMAND_ALIASES,
	STATIC_COMPOSER_COMMANDS,
} from "./composer-commands";

// Widened to the general shape so tests can freely probe the optional
// `argument` field without fighting the catalog's literal `as const` types.
const commands: readonly ComposerCommandDefinition[] = STATIC_COMPOSER_COMMANDS;

describe("STATIC_COMPOSER_COMMANDS", () => {
	it("lists every command exactly once, all available", () => {
		const ids = commands.map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const command of commands) {
			expect(command.availability).toBe("available");
		}
	});

	it("declares an argument only for /document and /remember, /remember required", () => {
		const withArguments = commands
			.filter((command) => command.argument)
			.map((command) => command.id);
		expect(withArguments.sort()).toEqual(["document", "remember"]);

		const remember = commands.find((command) => command.id === "remember");
		expect(remember?.argument?.required).toBe(true);

		const doc = commands.find((command) => command.id === "document");
		expect(doc?.argument?.required).toBeFalsy();
	});

	it("declares argument hints as i18n keys, never literal text", () => {
		for (const command of commands) {
			if (!command.argument) continue;
			expect(command.argument.placeholderKey).toMatch(
				/^composerCommands\.[a-z]+\.argumentPlaceholder$/,
			);
		}
	});

	// Every string the tray renders for a command comes from these keys. A
	// missing one degrades to the raw key text in the UI, and the dictionary's
	// own parity test cannot catch a key that was never added to either
	// language — so resolve them straight off the catalog, in both languages.
	it.each(["en", "hu"] as const)(
		"resolves every command's label, description and argument hint in %s",
		(language) => {
			const dictionary: Record<string, string> = chatDict[language];
			for (const command of commands) {
				expect(dictionary[command.labelKey], `${command.labelKey}`).toBeTypeOf(
					"string",
				);
				expect(
					dictionary[command.descriptionKey],
					`${command.descriptionKey}`,
				).toBeTypeOf("string");
				if (command.argument) {
					expect(
						dictionary[command.argument.placeholderKey],
						`${command.argument.placeholderKey}`,
					).toBeTypeOf("string");
				}
			}
		},
	);

	it.each(["en", "hu"] as const)(
		"resolves the aliased target's keys in %s",
		(language) => {
			const dictionary: Record<string, string> = chatDict[language];
			for (const targetId of Object.values(HIDDEN_COMPOSER_COMMAND_ALIASES)) {
				const target = commands.find((command) => command.id === targetId);
				expect(target, `alias target ${targetId}`).toBeDefined();
				expect(dictionary[String(target?.labelKey)]).toBeTypeOf("string");
				expect(dictionary[String(target?.descriptionKey)]).toBeTypeOf("string");
			}
		},
	);

	it("does not list /depth — it only survives as a hidden alias", () => {
		const ids: string[] = commands.map((command) => command.id);
		expect(ids).not.toContain("depth");
		expect(HIDDEN_COMPOSER_COMMAND_ALIASES.depth).toBe("think");
	});
});
