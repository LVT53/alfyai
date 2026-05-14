import { STATIC_COMPOSER_COMMANDS } from "$lib/composer-commands";

export type ComposerCommandRegistryScope = "normal_chat";

export interface ComposerCommandRegistryShell {
	scope: ComposerCommandRegistryScope;
	commands: typeof STATIC_COMPOSER_COMMANDS;
	message: "composerCommandRegistry.empty";
}

export function getComposerCommandRegistryShell(): ComposerCommandRegistryShell {
	return {
		scope: "normal_chat",
		commands: STATIC_COMPOSER_COMMANDS,
		message: "composerCommandRegistry.empty",
	};
}
