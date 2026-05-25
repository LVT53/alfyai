import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const obsoletePaths = [
	"src/routes/api/chat/files/generate/+server.ts",
	"src/routes/api/chat/files/generate/generate.test.ts",
	"src/routes/api/chat/files/export/+server.ts",
	"langflow_nodes/file_generator_tool.py",
	"langflow_nodes/export_document_tool.py",
	"sandbox-helpers/create-pdf.js",
	"src/lib/components/chat/GeneratedFile.svelte",
	"src/lib/components/chat/GeneratedFile.test.ts",
	"src/lib/utils/generate-file-tool.ts",
	"src/lib/utils/generate-file-tool.test.ts",
	"scripts/verify-pdf-layout.mjs",
];

const scannedRoots = ["src", "langflow_nodes", "local", "scripts"];
const scannedFiles = ["AGENTS.md", "README.md"];
const obsoleteText = [
	"generate_file",
	"export_document",
	"createPDF",
	"create-pdf",
	"/api/chat/files/generate",
	"/api/chat/files/export",
	"ChatGeneratedFileListItem",
	"generatedFile.",
	"Terracotta Crown",
];

function collectFiles(path: string, output: string[] = []): string[] {
	const absolute = join(root, path);
	if (!existsSync(absolute)) return output;
	const stat = statSync(absolute);
	if (stat.isFile()) {
		output.push(path);
		return output;
	}
	for (const entry of readdirSync(absolute)) {
		collectFiles(join(path, entry), output);
	}
	return output;
}

function isAllowedSearchHit(path: string): boolean {
	return (
		path.endsWith(".test.ts") ||
		path === "docs/adr/0005-unified-file-production-boundary.md" ||
		path === "docs/file-production-overhaul-plan.md"
	);
}

describe("obsolete file-generation surfaces", () => {
	it("removes dead split-tool files instead of keeping compatibility shims", () => {
		for (const path of obsoletePaths) {
			expect(existsSync(join(root, path)), path).toBe(false);
		}
	});

	it("keeps active source and agent-facing guidance on produce_file only", () => {
		const paths = [
			...scannedRoots.flatMap((path) => collectFiles(path)),
			...scannedFiles,
		].filter((path) => !isAllowedSearchHit(path));
		const hits: string[] = [];

		for (const path of paths) {
			const content = readFileSync(join(root, path), "utf8");
			for (const token of obsoleteText) {
				if (content.includes(token)) {
					hits.push(`${path}: ${token}`);
				}
			}
		}

		expect(hits).toEqual([]);
	});

	it("keeps model guidance aligned with queued file-production jobs", () => {
		const source = readFileSync(
			join(root, "src/lib/server/services/langflow.ts"),
			"utf8",
		);

		expect(source).toContain(
			"Tool success means the file-production request was accepted",
		);
		expect(source).toContain("Do not mention file-production job IDs");
		expect(source).toContain(
			"Prefer one `document_source` call with multiple `requestedOutputs`",
		);
		expect(source).toContain("`program` must be an object");
		expect(source).toContain(
			"`documentSource` and `program` are object fields",
		);
		expect(source).not.toContain(
			"Only tell the user a file is ready after the tool succeeds.",
		);
		expect(source).not.toContain(
			"Generated files appear in the chat UI after the response finishes.",
		);
	});
});
