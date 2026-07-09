import type { WriteOperation } from "./write-guard";

// ---------------------------------------------------------------------------
// Write-executor registry (Issue 6.0) — mirrors adapters.ts
// (registerConnectionAdapter/getConnectionAdapter) but for the confirm-write
// chokepoint instead of health/disconnect. Concrete provider modules call
// registerWriteExecutor at module load (nextcloud today; google/apple/imap/
// immich in Phase 6); confirmPendingWrite (pending-writes.ts) dispatches to
// whichever executor is registered for a pending write's `record.provider`
// rather than hardwiring a single provider's write path. Process-local, same
// as adapters.ts — nothing here is persisted or shared across processes.
// ---------------------------------------------------------------------------

export type WriteExecutionResult =
	| { ok: true; etag?: string | null; detail?: string }
	| { ok: false; reason: string };

export interface WriteExecutor {
	provider: string; // e.g. "nextcloud", "google", "apple", "imap", "immich"
	execute(
		userId: string,
		connectionId: string,
		op: WriteOperation,
		content: string,
		opts?: { fetch?: typeof fetch },
	): Promise<WriteExecutionResult>;
}

const executors = new Map<string, WriteExecutor>();

// Last registration for a given provider wins — same overwrite-on-set
// behavior as registerConnectionAdapter (adapters.ts).
export function registerWriteExecutor(exec: WriteExecutor): void {
	executors.set(exec.provider, exec);
}

export function getWriteExecutor(provider: string): WriteExecutor | undefined {
	return executors.get(provider);
}

export function listRegisteredWriteExecutorProviders(): string[] {
	return [...executors.keys()];
}

// Test-only reset to keep suites isolated.
export function __resetWriteExecutorsForTest(): void {
	executors.clear();
}
