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

	it("keeps produce route intake behind the file-production boundary", () => {
		const source = readFileSync(
			join(root, "src/routes/api/chat/files/produce/+server.ts"),
			"utf8",
		);

		expect(source).toContain("submitFileProductionIntake");
		expect(source).toContain("getFileProductionIntakeConversationId");
		expect(source).not.toContain("validateProgramRequest");
		expect(source).not.toContain("extractFailureDraft");
		expect(source).not.toContain("validateFileProductionStaticLimits");
		expect(source).not.toContain("validateGeneratedDocumentSource");
		expect(source).not.toContain("createFailedFileProductionJob");
		expect(source).not.toContain("createOrReuseFileProductionJob");
		expect(source).not.toContain("wakeFileProductionWorker");
		expect(source).not.toContain("file-production/limits");
		expect(source).not.toContain("file-production/source-schema");
	});

	it("keeps durable file-production job ledger transitions behind the ledger module", () => {
		const facade = readFileSync(
			join(root, "src/lib/server/services/file-production/index.ts"),
			"utf8",
		);
		const ledgerPath = "src/lib/server/services/file-production/job-ledger.ts";
		const ledger = readFileSync(join(root, ledgerPath), "utf8");

		expect(facade).toContain('from "./job-ledger"');
		expect(facade).not.toContain("function mapJobRow");
		expect(facade).not.toContain("fileProductionJobAttempts");
		expect(ledger).toContain(
			"export async function claimNextFileProductionJob",
		);
		expect(ledger).toContain("fileProductionJobAttempts");
	});

	it("keeps file-production worker and execution dispatch behind deeper modules", () => {
		const facade = readFileSync(
			join(root, "src/lib/server/services/file-production/index.ts"),
			"utf8",
		);
		const workerRunner = readFileSync(
			join(root, "src/lib/server/services/file-production/worker-runner.ts"),
			"utf8",
		);
		const executionAdapter = readFileSync(
			join(
				root,
				"src/lib/server/services/file-production/execution-adapter.ts",
			),
			"utf8",
		);

		expect(facade).toContain('from "./worker-runner"');
		expect(facade).toContain('return import("./worker-runner")');
		expect(facade).not.toMatch(/^import\s+\{[\s\S]*from "\.\/worker-runner";/m);
		expect(facade).not.toMatch(/^import\s+\{[\s\S]*from "\.\/job-ledger";/m);
		expect(facade).not.toContain("DEFAULT_WORKER_ID");
		expect(facade).not.toContain("workerInitialized");
		expect(facade).not.toContain("drainPromise");
		expect(facade).not.toContain("parseFileProductionJobRequest");
		expect(facade).not.toContain("renderStandardReportPdf");
		expect(facade).not.toContain("executeSandboxCode");
		expect(workerRunner).toContain("const DEFAULT_WORKER_ID");
		expect(workerRunner).toContain("let workerInitialized");
		expect(workerRunner).toContain("let drainPromise");
		expect(executionAdapter).toContain(
			"function parseFileProductionJobRequest",
		);
		expect(executionAdapter).toContain("renderStandardReportPdf");
		expect(executionAdapter).toContain("executeSandboxCode");
	});

	it("keeps generated-file storage and linking behind the storage adapter", () => {
		const workerRunner = readFileSync(
			join(root, "src/lib/server/services/file-production/worker-runner.ts"),
			"utf8",
		);
		const storageAdapter = readFileSync(
			join(root, "src/lib/server/services/file-production/storage-adapter.ts"),
			"utf8",
		);
		const facade = readFileSync(
			join(root, "src/lib/server/services/file-production/index.ts"),
			"utf8",
		);

		expect(workerRunner).toContain('from "./storage-adapter"');
		for (const directStorageImport of [
			"storeGeneratedFile as",
			"syncGeneratedFilesToMemory as",
			"validateFileProductionOutputLimits",
			"validateProgramOutputContract",
			"attachGeneratedDocumentSourceArtifactToRenderedFiles",
			"mapChatFileToProducedFile",
			"mapChatFileToSourceProducedFile",
		]) {
			expect(workerRunner).not.toContain(directStorageImport);
			expect(storageAdapter).toContain(directStorageImport.replace(" as", ""));
			expect(facade).not.toContain(directStorageImport);
		}
	});

	it("keeps read-only file-production callers on a read-model entrypoint", () => {
		const conversationDetailRoute = readFileSync(
			join(root, "src/routes/api/conversations/[id]/+server.ts"),
			"utf8",
		);
		const readModel = readFileSync(
			join(root, "src/lib/server/services/file-production/read-model.ts"),
			"utf8",
		);

		expect(conversationDetailRoute).toContain(
			'$lib/server/services/file-production/read-model',
		);
		expect(readModel).toContain(
			"export async function listConversationFileProductionJobs",
		);
		for (const eagerImport of [
			"from \"./index\"",
			"from './index'",
			"from \"./worker-runner\"",
			"from './worker-runner'",
			"from \"./execution-adapter\"",
			"from './execution-adapter'",
			"from \"./storage-adapter\"",
			"from './storage-adapter'",
			"$lib/server/services/chat-files",
			"$lib/server/services/honcho",
			"document-extraction",
		]) {
			expect(readModel).not.toContain(eagerImport);
		}
	});

	it("keeps conversation detail generated-file reads off Honcho and stale ledger projections", () => {
		const chatFiles = readFileSync(
			join(root, "src/lib/server/services/chat-files.ts"),
			"utf8",
		);
		const ledger = readFileSync(
			join(root, "src/lib/server/services/file-production/job-ledger.ts"),
			"utf8",
		);

		expect(chatFiles).not.toContain(
			"import { syncArtifactToHoncho } from '$lib/server/services/honcho';",
		);
		expect(chatFiles).toContain("import('$lib/server/services/honcho')");
		expect(ledger).not.toContain("$lib/server/services/chat-files");
		expect(ledger).not.toContain(
			"export async function listConversationFileProductionJobs",
		);
		expect(ledger).not.toContain("function ensureLegacyJobs");
		expect(ledger).not.toContain("function legacyJobId");
		expect(ledger).not.toContain("function legacyJobFileLinkId");
	});
});
