import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const auditedPrefixes = [
	'admin.composerCommandRegistry',
	'admin.systemSkills.',
	'composerCommandRegistry.',
	'composerCommands.',
	'linkedSources.',
	'pendingSkill.',
	'skillDrafts.',
	'skillSessions.',
	'skills.',
	'sourceManager.',
] as const;

function collectDictionaryKeys(): Record<'en' | 'hu', string[]> {
	const sourcePath = resolve(dirname(new URL(import.meta.url).pathname), 'i18n.ts');
	const sourceFile = ts.createSourceFile(
		sourcePath,
		readFileSync(sourcePath, 'utf8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	let dictionary: ts.ObjectLiteralExpression | null = null;
	sourceFile.forEachChild((node) => {
		if (!ts.isVariableStatement(node)) return;
		for (const declaration of node.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === 'dictionary' &&
				declaration.initializer
			) {
				const initializer = ts.isAsExpression(declaration.initializer)
					? declaration.initializer.expression
					: declaration.initializer;
				if (ts.isObjectLiteralExpression(initializer)) {
					dictionary = initializer;
				}
			}
		}
	});

	if (!dictionary) {
		throw new Error('Could not find i18n dictionary object');
	}

	const keys = { en: [] as string[], hu: [] as string[] };
	for (const language of ['en', 'hu'] as const) {
		const property = dictionary.properties.find(
			(prop): prop is ts.PropertyAssignment =>
				ts.isPropertyAssignment(prop) &&
				ts.isIdentifier(prop.name) &&
				prop.name.text === language,
		);
		if (!property || !ts.isObjectLiteralExpression(property.initializer)) {
			throw new Error(`Could not find ${language} i18n dictionary`);
		}

		keys[language] = property.initializer.properties
			.map((prop) => {
				if (!ts.isPropertyAssignment(prop)) return null;
				if (ts.isStringLiteral(prop.name) || ts.isIdentifier(prop.name)) {
					return prop.name.text;
				}
				return null;
			})
			.filter((key): key is string => Boolean(key))
			.filter((key) => auditedPrefixes.some((prefix) => key.startsWith(prefix)))
			.sort();
	}

	return keys;
}

describe('i18n composer and skills namespaces', () => {
	it('keeps English and Hungarian keys in parity', () => {
		const keys = collectDictionaryKeys();

		expect(keys.hu).toEqual(keys.en);
		expect(keys.en.length).toBeGreaterThan(0);
	});
});
