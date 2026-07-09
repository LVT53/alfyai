import type { ConnectionProvider } from "$lib/server/db/schema";
import type { ConnectionAdapter } from "./registry";

// Process-local registry. Concrete adapters call registerConnectionAdapter at
// module load (Phase 2/5). Foundation ships it empty.
const adapters = new Map<ConnectionProvider, ConnectionAdapter>();

export function registerConnectionAdapter(adapter: ConnectionAdapter): void {
	adapters.set(adapter.provider, adapter);
}

export function getConnectionAdapter(
	provider: ConnectionProvider,
): ConnectionAdapter | null {
	return adapters.get(provider) ?? null;
}

export function listRegisteredAdapterProviders(): ConnectionProvider[] {
	return [...adapters.keys()];
}

// Test-only reset to keep suites isolated.
export function __resetConnectionAdaptersForTest(): void {
	adapters.clear();
}
