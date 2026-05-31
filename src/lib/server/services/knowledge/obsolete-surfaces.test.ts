import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const uploadRoutePaths = [
	"src/routes/api/knowledge/upload/+server.ts",
	"src/routes/api/knowledge/upload/raw/+server.ts",
	"src/routes/api/knowledge/upload/chunk/+server.ts",
	"src/routes/api/knowledge/upload/intent/+server.ts",
];

const staleImportNames = [
	"syncArtifactToHoncho",
	"saveUploadedArtifact",
	"saveUploadedArtifactFromStoredFile",
	"createNormalizedArtifact",
	"resolvePromptAttachmentArtifacts",
	"getConversation",
];

function importStatements(source: string): string[] {
	return source.match(/import[\s\S]*?from\s+['"][^'"]+['"];?/g) ?? [];
}

describe("Knowledge upload route boundaries", () => {
	it("keeps upload adapters on Knowledge Upload Intake instead of stale completion surfaces", async () => {
		for (const routePath of uploadRoutePaths) {
			const source = await readFile(join(process.cwd(), routePath), "utf8");
			const imports = importStatements(source);
			const importsText = imports.join("\n");

			expect(importsText, routePath).toContain("knowledge/upload-intake");
			expect(importsText, routePath).not.toContain(
				"knowledge/upload-completion",
			);

			for (const staleName of staleImportNames) {
				expect(importsText, `${routePath} imports ${staleName}`).not.toContain(
					staleName,
				);
			}
		}
	});
});
