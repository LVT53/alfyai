import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

type I18nLanguage = "en" | "hu";

const AUDITED_PREFIXES = [
	"admin.composerCommandRegistry",
	"admin.systemSkills.",
	// The everyday-redesign composer: the bar's tooltips, the "+" menu, and
	// the four sheets it opens. Added here because the parity test is the
	// only thing that notices a key that landed in EN and not in HU, and a
	// namespace this list does not name is a namespace it does not check.
	"attachmentPicker.",
	"atlasDownload.",
	"composerBar.",
	"composerCommandRegistry.",
	"composerCommands.",
	"composerMenu.",
	"composerSheet.",
	// The file-production card's server-error-code -> localized-line map
	// (`FileProductionCard.svelte`'s `ERROR_MESSAGE_KEYS`). `chat.` as a whole
	// is NOT audited (pre-existing drift), so this narrow prefix is what
	// would have caught the three worker-reclaim codes landing in EN only.
	"fileProduction.error.",
	// The instructions surface (Workspaces feature 1, Slice C): the shared
	// InstructionsDialog, its scope token and the Settings row. Its own
	// namespace, so the whole surface is covered rather than a slice of it —
	// the switch label, the token and the counter all render on a phone and
	// none of them may fall back to a raw key.
	"instructions.",
	// The document-extraction ledger's two client surfaces. Both namespaces
	// are otherwise unaudited (`chat.` and `knowledge.` carry pre-existing
	// drift), so these narrow prefixes are the only thing that notices a
	// status or error-code string that landed in EN and not in HU — and the
	// codes are exactly the ones a user sees on a file that failed to read.
	// `chat.extraction` is owned by the composer slice; the prefix is added
	// here, with the other audit entries, so there is one list to read.
	"chat.extraction",
	"knowledge.extraction",
	// Phase 5 P5-C — the composer's paste-to-attach live region. Two keys, and
	// the only thing a screen-reader user gets told when a paste turns into
	// chips, so a line that landed in EN and not in HU would silently leave
	// Hungarian readers with the raw key. `chat.` as a whole is NOT audited
	// (it carries pre-existing drift), hence the narrow prefix.
	"chat.paste",
	// The chat home's greeting pool: ~76 keys a side, all of them optional to
	// any one render, so a line that landed in EN and not in HU would show as
	// the raw key to exactly the users who read Hungarian and nobody else.
	"landing.",
	// The upload family: five refusal keys the server names by `errorKey`,
	// plus the drop-zone and tooltip copy that carries the size limit. The
	// `knowledge.` namespace as a whole is NOT audited (it has pre-existing
	// drift this phase does not touch), so the prefix is deliberately narrow.
	"knowledge.upload",
	"modelPicker.",
	// The project surface (Workspaces feature 1, Slice D): the project page's
	// greeting, stats, list and quiet line, plus the sidebar's "open the
	// project" button. Its own namespace, so the whole page is covered rather
	// than a slice of it — every one of these strings is the only thing
	// naming a project to the user, and a key that landed in EN and not in HU
	// would show a Hungarian reader the raw key.
	"projects.",
	"skillsPicker.",
	"writeConfirm.",
	"linkedSources.",
	"messageBubble.",
	"fork.",
	"pendingSkill.",
	"skillDrafts.",
	"skills.",
	"sourceManager.",
	"toolCalls.",
	"sidebar.failedReorderSidebar",
	"sidebar.failedUpdateConversationPin",
	"sidebar.forkIndicatorTooltip",
	"sidebar.pinToSidebar",
	"sidebar.pinned",
	"sidebar.reorderItem",
	"sidebar.unpinFromSidebar",
] as const;

const DICT_SUFFIX = "Dict";

const i18nDirectory = resolve(
	dirname(new URL(import.meta.url).pathname),
	"i18n",
);

export type DictionaryKeysByLanguage = Record<I18nLanguage, string[]>;

/**
 * The dictionary modules `src/lib/i18n/index.ts` merges, read out of that file.
 *
 * This list used to live here by hand, and it drifted the way a copied list
 * does: `connections` and `legal` were never in it, so any audited-prefix key
 * that lands in either namespace is invisible to the parity test — the one
 * test that notices a key which reached English and never reached Hungarian.
 * Nothing in those two namespaces uses an audited prefix today, which is
 * exactly why nobody noticed: the hole is only visible once someone writes
 * into it. Reading the merge means a namespace is watched from the moment it
 * is merged, and a spread this helper cannot resolve throws rather than
 * quietly shrinking the watch list.
 */
export function mergedDictionaryModules(): string[] {
	const indexSource = readFileSync(resolve(i18nDirectory, "index.ts"), "utf8");
	const sourceFile = ts.createSourceFile(
		"index.ts",
		indexSource,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const moduleOf = new Map<string, string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const defaultName = statement.importClause?.name;
		const specifier = statement.moduleSpecifier;
		if (!defaultName || !ts.isStringLiteral(specifier)) continue;
		if (!specifier.text.startsWith("./")) continue;
		moduleOf.set(defaultName.text, specifier.text.slice(2));
	}

	const modules = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (
			ts.isSpreadAssignment(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			(node.expression.name.text === "en" || node.expression.name.text === "hu")
		) {
			const name = node.expression.expression.text;
			const mod = moduleOf.get(name);
			if (!mod) {
				throw new Error(
					`src/lib/i18n/index.ts spreads \`${name}.…\`, but no default import in that file maps \`${name}\` to a module, so this helper cannot tell which namespace it is and the parity test would not be watching it.`,
				);
			}
			modules.add(mod);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	if (modules.size === 0) {
		throw new Error(
			"src/lib/i18n/index.ts no longer spreads any dictionary this helper can read — the parse is stale, not the dictionaries.",
		);
	}

	return [...modules].sort();
}

function readDictionaryModule(mod: string): string {
	const filePath = resolve(i18nDirectory, `${mod}.ts`);
	return readFileSync(filePath, "utf8");
}

function parseDictionaryObject(
	source: string,
): ts.ObjectLiteralExpression | null {
	const sourceFile = ts.createSourceFile(
		"i18n.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	for (const node of sourceFile.statements) {
		if (!ts.isVariableStatement(node)) {
			continue;
		}

		for (const declaration of node.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) {
				continue;
			}

			if (
				!declaration.name.text.endsWith(DICT_SUFFIX) ||
				!declaration.initializer
			) {
				continue;
			}

			const init = ts.isAsExpression(declaration.initializer)
				? declaration.initializer.expression
				: declaration.initializer;

			if (ts.isObjectLiteralExpression(init)) {
				return init;
			}
		}
	}

	return null;
}

function collectLanguageObject(
	dictObject: ts.ObjectLiteralExpression,
	language: I18nLanguage,
): ts.ObjectLiteralExpression | null {
	const languageProperty = dictObject.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) &&
			ts.isIdentifier(property.name) &&
			property.name.text === language,
	);

	if (
		!languageProperty ||
		!ts.isObjectLiteralExpression(languageProperty.initializer)
	) {
		return null;
	}

	return languageProperty.initializer;
}

function collectAuditedKeysForLanguage(
	languageObject: ts.ObjectLiteralExpression,
	prefixes: readonly string[],
): string[] {
	return languageObject.properties
		.filter(
			(property): property is ts.PropertyAssignment =>
				ts.isPropertyAssignment(property) &&
				(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)),
		)
		.map((property) => {
			if (ts.isStringLiteral(property.name)) return property.name.text;
			if (ts.isIdentifier(property.name)) return property.name.text;
			return null;
		})
		.filter((key): key is string => key !== null)
		.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
}

export function collectDictionaryKeys(): DictionaryKeysByLanguage {
	const keys: DictionaryKeysByLanguage = { en: [], hu: [] };

	for (const mod of mergedDictionaryModules()) {
		const moduleSource = readDictionaryModule(mod);
		const dictionary = parseDictionaryObject(moduleSource);
		if (!dictionary) {
			throw new Error(
				`src/lib/i18n/${mod}.ts does not declare a \`…${DICT_SUFFIX}\` object literal this helper can read, so its keys would be silently skipped by the parity test.`,
			);
		}

		for (const language of ["en", "hu"] as const) {
			const languageObject = collectLanguageObject(dictionary, language);
			if (!languageObject) {
				throw new Error(
					`src/lib/i18n/${mod}.ts has no \`${language}\` object inside its dictionary, so its ${language} keys would be silently skipped by the parity test.`,
				);
			}

			keys[language].push(
				...collectAuditedKeysForLanguage(languageObject, AUDITED_PREFIXES),
			);
		}
	}

	keys.en.sort();
	keys.hu.sort();
	return keys;
}
