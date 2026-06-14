import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import chatDict from "./i18n/chat";

const auditedPrefixes = [
	"admin.composerCommandRegistry",
	"admin.reasoningDepthClassifier",
	"admin.systemSkills.",
	"composerCommandRegistry.",
	"composerCommands.",
	"deepResearch.",
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

const I18N_MODULES = [
	"chat",
	"common",
	"knowledge",
	"settings",
	"skills",
] as const;

function collectDictionaryKeys(): Record<"en" | "hu", string[]> {
	const keys: Record<"en" | "hu", string[]> = { en: [], hu: [] };
	const dir = dirname(new URL(import.meta.url).pathname);

	for (const mod of I18N_MODULES) {
		const filePath = resolve(dir, "i18n", `${mod}.ts`);
		const source = readFileSync(filePath, "utf8");
		const sourceFile = ts.createSourceFile(
			filePath,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);

		let dictObj: ts.ObjectLiteralExpression | null = null;
		for (const node of sourceFile.statements) {
			if (!ts.isVariableStatement(node)) continue;
			for (const decl of node.declarationList.declarations) {
				if (
					ts.isIdentifier(decl.name) &&
					decl.name.text.endsWith("Dict") &&
					decl.initializer
				) {
					const init = ts.isAsExpression(decl.initializer)
						? decl.initializer.expression
						: decl.initializer;
					if (ts.isObjectLiteralExpression(init)) {
						dictObj = init;
					}
				}
			}
		}
		if (!dictObj) continue;

		for (const lang of ["en", "hu"] as const) {
			const prop = dictObj.properties.find(
				(p): p is ts.PropertyAssignment =>
					ts.isPropertyAssignment(p) &&
					ts.isIdentifier(p.name) &&
					p.name.text === lang,
			);
			if (!prop || !ts.isObjectLiteralExpression(prop.initializer)) continue;

			for (const p of prop.initializer.properties) {
				if (!ts.isPropertyAssignment(p)) continue;
				let key: string | null = null;
				if (ts.isStringLiteral(p.name)) key = p.name.text;
				else if (ts.isIdentifier(p.name)) key = p.name.text;
				if (key && auditedPrefixes.some((prefix) => key?.startsWith(prefix))) {
					keys[lang].push(key);
				}
			}
		}
	}

	keys.en.sort();
	keys.hu.sort();
	return keys;
}

describe("i18n composer and skills namespaces", () => {
	it("keeps English and Hungarian keys in parity", () => {
		const keys = collectDictionaryKeys();

		expect(keys.hu).toEqual(keys.en);
		expect(keys.en.length).toBeGreaterThan(0);
	});

	it("localizes every conversation fork creation failure code", () => {
		const keys = collectDictionaryKeys();
		const expectedForkErrorKeys = [
			"fork.errors.emptySourceMessage",
			"fork.errors.invalidSourceMessage",
			"fork.errors.requiredArtifactUnauthorized",
			"fork.errors.requiredArtifactUnavailable",
			"fork.errors.requiredGeneratedWorkUnavailable",
			"fork.errors.sequenceConflict",
			"fork.errors.sourceConversationNotFound",
			"fork.errors.stoppedSourceMessage",
		];

		for (const key of expectedForkErrorKeys) {
			expect(keys.en).toContain(key);
			expect(keys.hu).toContain(key);
		}
	});

	it("localizes the inherited Skill Draft copy guard", () => {
		const keys = collectDictionaryKeys();

		expect(keys.en).toContain("skillDrafts.inheritedCopyBlocked");
		expect(keys.hu).toContain("skillDrafts.inheritedCopyBlocked");
	});

	it("uses localized Hungarian labels for depth profiles", () => {
		expect(chatDict.hu["messageBubble.depthProfileExtended"]).not.toBe(
			chatDict.en["messageBubble.depthProfileExtended"],
		);
		expect(chatDict.hu["messageBubble.depthProfileMaximum"]).not.toBe(
			chatDict.en["messageBubble.depthProfileMaximum"],
		);
		expect(chatDict.hu["messageBubble.depthProfileStandard"]).not.toBe(
			chatDict.en["messageBubble.depthProfileStandard"],
		);
	});

	it("localizes the response audit details labels", () => {
		expect(chatDict.hu["messageBubble.responseAuditDetails"]).not.toBe(
			chatDict.en["messageBubble.responseAuditDetails"],
		);
		expect(chatDict.hu["messageBubble.auditSources"]).not.toBe(
			chatDict.en["messageBubble.auditSources"],
		);
		expect(chatDict.hu["messageBubble.auditMaxTurns"]).not.toBe(
			chatDict.en["messageBubble.auditMaxTurns"],
		);
	});
});
