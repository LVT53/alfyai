// What the file-production stale window is allowed to depend on.
//
// It used to be a hard-coded ten minutes, and it had to be: the worker never
// heartbeated at all, so `heartbeat_at` was frozen at the claim and the window
// was really "the longest an attempt may take" — the 5-minute sandbox timeout
// with slack on top. Now that a timer writes the heartbeat every
// `heartbeatMs` through execution, rendering and storage alike, the window only
// has to clear the heartbeat itself plus the longest the event loop can be
// blocked by a synchronous render (measured at ~9.5 s for a source at the 2 MB
// `FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES` ceiling).

import { beforeEach, describe, expect, it, vi } from "vitest";

const getConfig = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/config-store", () => ({ getConfig }));

import {
	FILE_PRODUCTION_HEARTBEAT_MS,
	FILE_PRODUCTION_STALE_HEARTBEAT_FLOOR,
	getFileProductionWorkerConfig,
} from "./config";

function stored(overrides: Record<string, unknown> = {}) {
	return {
		fileProductionStaleAttemptMs: 120000,
		fileProductionSandboxTimeoutMs: 300000,
		fileProductionRendererTimeoutMs: 300000,
		...overrides,
	};
}

beforeEach(() => {
	getConfig.mockReset();
});

describe("getFileProductionWorkerConfig stale window", () => {
	it("is two minutes by default", () => {
		getConfig.mockReturnValue(stored());
		expect(getFileProductionWorkerConfig().staleAttemptMs).toBe(120000);
	});

	it("ignores the sandbox and renderer timeouts entirely", () => {
		// The old ten-minute window was derived from them. A heartbeat on its own
		// timer means how long the work takes says nothing about whether the
		// worker running it is alive.
		getConfig.mockReturnValue(
			stored({
				fileProductionSandboxTimeoutMs: 3_600_000,
				fileProductionRendererTimeoutMs: 3_600_000,
			}),
		);
		expect(getFileProductionWorkerConfig().staleAttemptMs).toBe(120000);
	});

	it("honours an admin who raises the key itself", () => {
		getConfig.mockReturnValue(stored({ fileProductionStaleAttemptMs: 600000 }));
		expect(getFileProductionWorkerConfig().staleAttemptMs).toBe(600000);
	});

	it("never drops below four heartbeats, whatever the key says", () => {
		// A busy event loop — or one long synchronous PDF layout — can swallow a
		// beat; three missed in a row is a dead worker.
		getConfig.mockReturnValue(stored({ fileProductionStaleAttemptMs: 1000 }));
		expect(getFileProductionWorkerConfig().staleAttemptMs).toBe(
			FILE_PRODUCTION_HEARTBEAT_MS * FILE_PRODUCTION_STALE_HEARTBEAT_FLOOR,
		);
	});

	it("survives a config store that has not learned the key yet", () => {
		getConfig.mockReturnValue({});
		expect(getFileProductionWorkerConfig().staleAttemptMs).toBe(120000);
	});
});
