import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

/**
 * A file that no longer exists reads as empty rather than throwing.
 *
 * Every assertion below is "this symbol is NOT in that file", so a deleted file
 * satisfies it trivially and correctly — and the guard still fires if the file
 * ever comes back carrying the symbol. `services/document-extraction.ts` is the
 * case: the MinerU 3.x client was deleted outright, and an ENOENT here would
 * turn its removal into a failing test about file-production boundaries.
 */
function readSource(path: string): string {
	try {
		return readFileSync(join(root, path), "utf8");
	} catch {
		return "";
	}
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

	it("keeps durable job state transitions behind the job engine", () => {
		const facade = readSource(
			"src/lib/server/services/file-production/index.ts",
		);
		const kind = readSource(
			"src/lib/server/services/file-production/production-job.ts",
		);
		const links = readSource(
			"src/lib/server/services/file-production/job-links.ts",
		);

		expect(facade).not.toContain("function mapJobRow");
		expect(facade).not.toContain("fileProductionJobAttempts");
		// The kind is defined once, on the engine, and says what is particular to
		// file production; the engine owns every lifecycle transition.
		expect(kind).toContain("defineJobKind");
		expect(kind).toContain('from "$lib/server/services/jobs"');
		expect(kind).toContain('name: "file-production"');
		// What remains beside it writes the links a job carries, never its lifecycle.
		expect(links).not.toContain("fileProductionJobAttempts");
		// The ledger, the worker and the wait helper they replaced are gone, and a
		// file that comes back under those names is a second way to run a job.
		for (const gone of ["job-ledger.ts", "worker-runner.ts", "job-wait.ts"]) {
			expect(
				readSource(`src/lib/server/services/file-production/${gone}`),
				gone,
			).toBe("");
		}
	});

	it("keeps the handler lazy-loaded behind the kind's definition", () => {
		const facade = readSource(
			"src/lib/server/services/file-production/index.ts",
		);
		const kind = readSource(
			"src/lib/server/services/file-production/production-job.ts",
		);
		const productionRunner = readSource(
			"src/lib/server/services/file-production/production-runner.ts",
		);
		const executionAdapter = readSource(
			"src/lib/server/services/file-production/execution-adapter.ts",
		);

		// The engine loads the handler on the first claim: the definition names it
		// with a dynamic import, so a route that only reads, retries or cancels never
		// imports a renderer or the sandbox client.
		expect(kind).toContain('import("./production-runner")');
		expect(kind).not.toMatch(/^import\s[^;]*from "\.\/production-runner";/m);
		expect(facade).not.toMatch(/^import\s[^;]*from "\.\/production-runner";/m);
		expect(facade).not.toContain('from "./execution-adapter"');
		expect(facade).not.toContain("parseFileProductionJobRequest");
		expect(facade).not.toContain("renderStandardReportPdf");
		expect(facade).not.toContain("executeSandboxCode");
		expect(productionRunner).toContain("executePersistedFileProductionRequest");
		// The scheduler's state and the loop are the engine's.
		expect(productionRunner).not.toContain("setInterval");
		expect(productionRunner).not.toContain("DEFAULT_WORKER_ID");
		expect(executionAdapter).toContain(
			"function parseFileProductionJobRequest",
		);
		expect(executionAdapter).toContain("renderStandardReportPdf");
		expect(executionAdapter).toContain("executeSandboxCode");
	});

	it("keeps generated-file storage and linking behind the storage adapter", () => {
		const productionRunner = readSource(
			"src/lib/server/services/file-production/production-runner.ts",
		);
		const storageAdapter = readSource(
			"src/lib/server/services/file-production/storage-adapter.ts",
		);
		const facade = readSource(
			"src/lib/server/services/file-production/index.ts",
		);

		expect(productionRunner).toContain('from "./storage-adapter"');
		for (const directStorageImport of [
			"storeGeneratedFile as",
			"syncGeneratedFilesToMemory as",
			"validateFileProductionOutputLimits",
			"validateProgramOutputContract",
			"attachGeneratedDocumentSourceArtifactToRenderedFiles",
			"mapChatFileToProducedFile",
			"mapChatFileToSourceProducedFile",
		]) {
			expect(productionRunner).not.toContain(directStorageImport);
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
			"file-production/production-runner",
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
			'from "./production-runner"',
			"from './production-runner'",
			// The kind's definition reads the read model (the card a wait hands back),
			// so the read model must never read the kind.
			'from "./production-job"',
			"from './production-job'",
			'from "./execution-adapter"',
			"from './execution-adapter'",
			'from "./storage-adapter"',
			"from './storage-adapter'",
			"$lib/server/services/chat-files",
			"document-extraction",
		]) {
			expect(readModel).not.toContain(eagerImport);
		}
	});

	// Phase 1: the server-side extension/MIME tables moved to
	// $lib/shared/file-types. `no-ad-hoc-maps.test.ts` stops a NEW table
	// appearing anywhere; this stops these specific ones coming back by name.
	it("keeps the server-side type tables in the shared registry", () => {
		for (const [relative, goneSymbol] of [
			[
				"src/lib/server/services/file-production/output-types.ts",
				"const OUTPUT_TYPE_EXTENSIONS",
			],
			[
				"src/lib/server/services/file-production/output-validation.ts",
				"const EXTENSION_MIME_TYPES",
			],
			[
				"src/lib/server/services/file-production/output-validation.ts",
				"const TEXT_LIKE_EXTENSIONS",
			],
			[
				"src/lib/server/services/file-production/execution-adapter.ts",
				"function normalizeDocumentOutput",
			],
			["src/lib/server/services/sandbox-execution.ts", "const MIME_TYPES"],
			[
				"src/lib/server/services/generated-file-serving.ts",
				"const FULL_VALIDATION_EXTENSIONS",
			],
			[
				"src/lib/server/services/document-extraction.ts",
				"function mimeFromExtension",
			],
			[
				"src/lib/server/services/document-extraction.ts",
				"function isDirectTextExtractionFile",
			],
			[
				"src/lib/server/services/normal-chat-tools/produce-file.ts",
				"const OUTPUT_TYPE_EXTENSIONS",
			],
			[
				"src/lib/server/services/normal-chat-tools/files.ts",
				"const TEXT_LIKE_MIME_TYPES",
			],
		]) {
			expect(readSource(relative), `${relative}: ${goneSymbol}`).not.toContain(
				goneSymbol,
			);
		}
	});

	it("keeps legacy job backfill out of the job kind", () => {
		const kind = readSource(
			"src/lib/server/services/file-production/production-job.ts",
		);

		expect(kind).not.toContain("$lib/server/services/chat-files");
		expect(kind).not.toContain(
			"export async function listConversationFileProductionJobs",
		);
		expect(kind).not.toContain("function ensureLegacyJobs");
		expect(kind).not.toContain("function legacyJobId");
		expect(kind).not.toContain("function legacyJobFileLinkId");
	});
});
