import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readSource(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

describe("file-production architecture boundaries", () => {
	it("keeps produce route intake behind the file-production boundary", () => {
		const source = readSource("src/routes/api/chat/files/produce/+server.ts");

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

	it("keeps durable job state transitions behind the ledger module", () => {
		const facade = readSource(
			"src/lib/server/services/file-production/index.ts",
		);
		const ledger = readSource(
			"src/lib/server/services/file-production/job-ledger.ts",
		);

		expect(facade).toContain(
			'type JobLedgerModule = typeof import("./job-ledger")',
		);
		expect(facade).toContain("loadJobLedger()");
		expect(facade).not.toContain("function mapJobRow");
		expect(facade).not.toContain("fileProductionJobAttempts");
		expect(ledger).toContain(
			"export async function claimNextFileProductionJob",
		);
		expect(ledger).toContain("fileProductionJobAttempts");
	});

	it("keeps worker execution lazy-loaded behind the facade", () => {
		const facade = readSource(
			"src/lib/server/services/file-production/index.ts",
		);
		const workerRunner = readSource(
			"src/lib/server/services/file-production/worker-runner.ts",
		);
		const executionAdapter = readSource(
			"src/lib/server/services/file-production/execution-adapter.ts",
		);

		expect(facade).toContain(
			'type WorkerRunnerModule = typeof import("./worker-runner")',
		);
		expect(facade).toContain('return import("./worker-runner")');
		expect(facade).not.toMatch(/^import\s+\{[\s\S]*from "\.\/worker-runner";/m);
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
		const workerRunner = readSource(
			"src/lib/server/services/file-production/worker-runner.ts",
		);
		const storageAdapter = readSource(
			"src/lib/server/services/file-production/storage-adapter.ts",
		);
		const facade = readSource(
			"src/lib/server/services/file-production/index.ts",
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

	it("keeps read-only generated-file hydration on a read-model entrypoint", () => {
		const conversationDetailRoute = readSource(
			"src/routes/api/conversations/[id]/+server.ts",
		);
		const conversationDetailReadModel = readSource(
			"src/lib/server/services/conversation-detail/read-model.ts",
		);
		const readModel = readSource(
			"src/lib/server/services/file-production/read-model.ts",
		);

		expect(conversationDetailRoute).toContain(
			"$lib/server/services/conversation-detail/read-model",
		);
		expect(conversationDetailRoute).not.toContain(
			"$lib/server/services/file-production/read-model",
		);
		expect(conversationDetailReadModel).toContain(
			"$lib/server/services/file-production/read-model",
		);
		expect(conversationDetailReadModel).toContain(
			"listConversationGeneratedFiles",
		);
		expect(conversationDetailReadModel).not.toContain(
			"$lib/server/services/chat-files",
		);
		expect(readModel).toContain(
			"export async function listConversationGeneratedFiles",
		);
		expect(readModel).toContain("function mapChatFileToGeneratedFile");
		expect(readModel).toMatch(/\.map\(\s*mapChatFileToGeneratedFile,\s*\)/);
		expect(readModel).toContain(
			"export async function listConversationFileProductionJobs",
		);
		for (const eagerFileProductionImport of [
			"file-production/worker-runner",
			"file-production/execution-adapter",
			"file-production/storage-adapter",
		]) {
			expect(conversationDetailReadModel).not.toContain(
				eagerFileProductionImport,
			);
		}
		for (const eagerImport of [
			'from "./index"',
			"from './index'",
			'from "./worker-runner"',
			"from './worker-runner'",
			'from "./execution-adapter"',
			"from './execution-adapter'",
			'from "./storage-adapter"',
			"from './storage-adapter'",
			"$lib/server/services/chat-files",
			"$lib/server/services/honcho",
			"document-extraction",
		]) {
			expect(readModel).not.toContain(eagerImport);
		}
	});

	it("keeps legacy job backfill out of the durable ledger", () => {
		const ledger = readSource(
			"src/lib/server/services/file-production/job-ledger.ts",
		);

		expect(ledger).not.toContain("$lib/server/services/chat-files");
		expect(ledger).not.toContain(
			"export async function listConversationFileProductionJobs",
		);
		expect(ledger).not.toContain("function ensureLegacyJobs");
		expect(ledger).not.toContain("function legacyJobId");
		expect(ledger).not.toContain("function legacyJobFileLinkId");
	});
});
