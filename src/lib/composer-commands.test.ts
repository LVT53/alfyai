import { describe, expect, it } from "vitest";
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

	it("does not list /depth — it only survives as a hidden alias", () => {
		const ids: string[] = commands.map((command) => command.id);
		expect(ids).not.toContain("depth");
		expect(HIDDEN_COMPOSER_COMMAND_ALIASES.depth).toBe("think");
	});
});
