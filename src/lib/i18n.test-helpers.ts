import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

type I18nLanguage = "en" | "hu";

const I18N_MODULES = [
	"chat",
	"common",
	"knowledge",
	"settings",
	"skills",
] as const;
const AUDITED_PREFIXES = [
	"admin.composerCommandRegistry",
	"admin.reasoningDepthClassifier",
	"admin.systemSkills.",
	"composerCommandRegistry.",
	"composerCommands.",
	"linkedSources.",
	"messageBubble.",
	"fork.",
	"pendingSkill.",
	"skillDrafts.",
	"skillSessions.",
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

	for (const mod of I18N_MODULES) {
		const moduleSource = readDictionaryModule(mod);
		const dictionary = parseDictionaryObject(moduleSource);
		if (!dictionary) continue;

		for (const language of ["en", "hu"] as const) {
			const languageObject = collectLanguageObject(dictionary, language);
			if (!languageObject) continue;

			keys[language].push(
				...collectAuditedKeysForLanguage(languageObject, AUDITED_PREFIXES),
			);
		}
	}

	keys.en.sort();
	keys.hu.sort();
	return keys;
}
