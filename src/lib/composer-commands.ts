export type ComposerCommandId =
	| "model"
	| "style"
	| "thinking"
	| "attach"
	| "document"
	| "source"
	| "skill"
	| "settings"
	| "clear"
	| "compact"
	| "web"
	| "research";

export type ComposerCommandAvailability =
	| "available"
	| "disabled"
	| "coming_soon";

export type ComposerCommandDefinition = {
	id: ComposerCommandId;
	token: `/${ComposerCommandId}`;
	labelKey: string;
	descriptionKey: string;
	availability: ComposerCommandAvailability;
};

export const STATIC_COMPOSER_COMMANDS = [
	{
		id: "model",
		token: "/model",
		labelKey: "composerCommands.model.label",
		descriptionKey: "composerCommands.model.description",
		availability: "available",
	},
	{
		id: "style",
		token: "/style",
		labelKey: "composerCommands.style.label",
		descriptionKey: "composerCommands.style.description",
		availability: "available",
	},
	{
		id: "thinking",
		token: "/thinking",
		labelKey: "composerCommands.thinking.label",
		descriptionKey: "composerCommands.thinking.description",
		availability: "available",
	},
	{
		id: "attach",
		token: "/attach",
		labelKey: "composerCommands.attach.label",
		descriptionKey: "composerCommands.attach.description",
		availability: "available",
	},
	{
		id: "document",
		token: "/document",
		labelKey: "composerCommands.document.label",
		descriptionKey: "composerCommands.document.description",
		availability: "available",
	},
	{
		id: "source",
		token: "/source",
		labelKey: "composerCommands.source.label",
		descriptionKey: "composerCommands.source.description",
		availability: "available",
	},
	{
		id: "skill",
		token: "/skill",
		labelKey: "composerCommands.skill.label",
		descriptionKey: "composerCommands.skill.description",
		availability: "coming_soon",
	},
	{
		id: "settings",
		token: "/settings",
		labelKey: "composerCommands.settings.label",
		descriptionKey: "composerCommands.settings.description",
		availability: "available",
	},
	{
		id: "clear",
		token: "/clear",
		labelKey: "composerCommands.clear.label",
		descriptionKey: "composerCommands.clear.description",
		availability: "available",
	},
	{
		id: "compact",
		token: "/compact",
		labelKey: "composerCommands.compact.label",
		descriptionKey: "composerCommands.compact.description",
		availability: "available",
	},
	{
		id: "web",
		token: "/web",
		labelKey: "composerCommands.web.label",
		descriptionKey: "composerCommands.web.description",
		availability: "available",
	},
	{
		id: "research",
		token: "/research",
		labelKey: "composerCommands.research.label",
		descriptionKey: "composerCommands.research.description",
		availability: "available",
	},
] as const satisfies ComposerCommandDefinition[];

export const COMPOSER_COMMAND_VISIBLE_RESULT_LIMIT = 7;
