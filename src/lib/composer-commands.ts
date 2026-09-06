export type ComposerCommandId =
	| "model"
	| "style"
	| "think"
	| "attach"
	| "document"
	| "source"
	| "skill"
	| "settings"
	| "clear"
	| "compact"
	| "web"
	| "quick"
	| "thorough"
	| "new"
	| "remember"
	| "export";

export type ComposerCommandAvailability =
	| "available"
	| "disabled"
	| "coming_soon";

export type ComposerCommandArgument = {
	/**
	 * i18n key for the hint shown next to the command row once its name is
	 * fully typed. A key, not literal text — the tray renders it in the
	 * user's own UI language like every other label in this catalog.
	 */
	placeholderKey: string;
	/** When true, selecting the command with no argument text is a no-op. */
	required?: boolean;
};

export type ComposerCommandDefinition = {
	id: ComposerCommandId;
	token: `/${ComposerCommandId}`;
	labelKey: string;
	descriptionKey: string;
	availability: ComposerCommandAvailability;
	argument?: ComposerCommandArgument;
};

export const STATIC_COMPOSER_COMMANDS: readonly ComposerCommandDefinition[] = [
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
		id: "think",
		token: "/think",
		labelKey: "composerCommands.think.label",
		descriptionKey: "composerCommands.think.description",
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
		argument: {
			placeholderKey: "composerCommands.document.argumentPlaceholder",
		},
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
		availability: "available",
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
		id: "quick",
		token: "/quick",
		labelKey: "composerCommands.quick.label",
		descriptionKey: "composerCommands.quick.description",
		availability: "available",
	},
	{
		id: "thorough",
		token: "/thorough",
		labelKey: "composerCommands.thorough.label",
		descriptionKey: "composerCommands.thorough.description",
		availability: "available",
	},
	{
		id: "new",
		token: "/new",
		labelKey: "composerCommands.new.label",
		descriptionKey: "composerCommands.new.description",
		availability: "available",
	},
	{
		id: "remember",
		token: "/remember",
		labelKey: "composerCommands.remember.label",
		descriptionKey: "composerCommands.remember.description",
		availability: "available",
		argument: {
			placeholderKey: "composerCommands.remember.argumentPlaceholder",
			required: true,
		},
	},
	{
		id: "export",
		token: "/export",
		labelKey: "composerCommands.export.label",
		descriptionKey: "composerCommands.export.description",
		availability: "available",
	},
];

/**
 * ADR-0061 renamed `/depth` to `/think` when the reasoning-depth ladder
 * collapsed into a single on/off toggle. `/depth` still works — typed in
 * full, it resolves to the same command — but it is intentionally left out
 * of `STATIC_COMPOSER_COMMANDS` so it never shows up while browsing `/` or
 * filtering by a partial prefix.
 */
export const HIDDEN_COMPOSER_COMMAND_ALIASES: Readonly<
	Record<string, ComposerCommandId>
> = {
	depth: "think",
};

export const COMPOSER_COMMAND_VISIBLE_RESULT_LIMIT = 7;
