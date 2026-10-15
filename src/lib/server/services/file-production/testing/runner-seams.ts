// The seams a test of the file-production handler drives it through.
//
// The handler is loaded by the engine, so a test cannot hand it a fake sandbox, a
// fake chat-file store or tighter limits the way the old worker took them as
// arguments. These are spies on the two modules the handler reads them from (the
// execution adapter and the storage adapter), installed AFTER the module registry
// has been reset so that they land on the instances the engine is about to load,
// and undone by `vi.restoreAllMocks()`. Each spy lays the test's choice over the
// call's own arguments and leaves everything it did not choose to the real module.
//
// Shared rather than copied because the handler's test, its logging test and the
// façade's tests all need them, and a seam that lives in one `.test.ts` gets copied
// and then drifts.

import { vi } from "vitest";
import type { ProgramExecutionResult } from "../execution-adapter";
import type { FileProductionLimits } from "../limits";
import type {
	StoreGeneratedFileDependency,
	SyncGeneratedFilesToMemoryDependency,
} from "../storage-adapter";
import type { FileProductionJob } from "../types";

export interface RunnerSeams {
	/** The sandbox; null = the real one. */
	executeCode:
		| null
		| ((
				sourceCode: string,
				language: "python" | "javascript",
				options?: { signal?: AbortSignal },
		  ) => Promise<ProgramExecutionResult>);
	/** The chat-file store; null = the real one. */
	storeGeneratedFile: StoreGeneratedFileDependency | null;
	/** The memory sync after a success; null = the real one. */
	syncGeneratedFilesToMemory: SyncGeneratedFilesToMemoryDependency | null;
	/** Limits laid over the configured ones. */
	limits: Partial<FileProductionLimits> | null;
	/** What the last successful store handed back, for a test that asks what a run made. */
	producedFiles: FileProductionJob["files"] | null;
	installed: boolean;
}

export const seams: RunnerSeams = {
	executeCode: null,
	storeGeneratedFile: null,
	syncGeneratedFilesToMemory: null,
	limits: null,
	producedFiles: null,
	installed: false,
};

/** Back to the real thing, for the next test. Call after `vi.resetModules()`. */
export function resetSeams(): void {
	seams.executeCode = null;
	seams.storeGeneratedFile = null;
	seams.syncGeneratedFilesToMemory = null;
	seams.limits = null;
	seams.producedFiles = null;
	seams.installed = false;
}

/** Puts the seams on the modules the engine is about to load. Once per registry. */
export async function installSeams(): Promise<void> {
	if (seams.installed) return;
	seams.installed = true;
	const execution = await import("../execution-adapter");
	const storage = await import("../storage-adapter");
	const realExecute = execution.executePersistedFileProductionRequest;
	const realStore = storage.storeFileProductionOutputs;
	const realSync = storage.syncFileProductionOutputsToMemory;

	vi.spyOn(
		execution,
		"executePersistedFileProductionRequest",
	).mockImplementation(async (input) => {
		const result = await realExecute({
			...input,
			...(seams.executeCode ? { executeCode: seams.executeCode } : {}),
			...(seams.limits ? { limits: { ...input.limits, ...seams.limits } } : {}),
		});
		return result;
	});
	vi.spyOn(storage, "storeFileProductionOutputs").mockImplementation(
		async (input) => {
			const result = await realStore({
				...input,
				...(seams.storeGeneratedFile
					? { storeGeneratedFile: seams.storeGeneratedFile }
					: {}),
				...(seams.limits
					? { limits: { ...input.limits, ...seams.limits } }
					: {}),
			});
			if (result.ok) seams.producedFiles = result.producedFiles;
			return result;
		},
	);
	vi.spyOn(storage, "syncFileProductionOutputsToMemory").mockImplementation(
		(input) =>
			realSync({
				...input,
				...(seams.syncGeneratedFilesToMemory
					? { syncGeneratedFilesToMemory: seams.syncGeneratedFilesToMemory }
					: {}),
			}),
	);
}
