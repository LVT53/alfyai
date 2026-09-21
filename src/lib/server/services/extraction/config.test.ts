// What the stale window is allowed to depend on.
//
// It used to be `max(configured, mineruTimeoutMs * 2)`. On the dev box, where
// an admin had raised the MinerU timeout to 600 s to get a 250-page PDF through,
// that silently turned a 15-minute window into a 20-minute one: a restart
// orphaned a `parsing` attempt and nothing was allowed to call it dead for
// twenty minutes. The heartbeat runs every `heartbeatMs` through every phase,
// indexing included, and does not stop while the extractor's HTTP call is in
// flight — so the backend timeout says nothing about whether a worker is alive.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getConfig = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/config-store", () => ({ getConfig }));

import {
	EXTRACTION_STALE_HEARTBEAT_FLOOR,
	getExtractionConfig,
} from "./config";

function stored(overrides: Record<string, unknown> = {}) {
	return {
		documentExtractionWorkerEnabled: true,
		documentExtractionMaxConcurrency: 3,
		documentExtractionPerUserConcurrency: 2,
		documentExtractionMaxAttempts: 3,
		documentExtractionRetryBaseMs: 2000,
		documentExtractionRetryMaxMs: 60000,
		documentExtractionStaleAttemptMs: 120000,
		documentExtractionHeartbeatMs: 15000,
		documentExtractionInlineBudgetMs: 1500,
		documentExtractionPreflightWaitMs: 2500,
		documentExtractionMaxDirectTextBytes: 8388608,
		mineruTimeoutMs: 600000,
		...overrides,
	};
}

beforeEach(() => {
	getConfig.mockReset();
});

describe("getExtractionConfig stale window", () => {
	it("ignores the backend timeout entirely", () => {
		getConfig.mockReturnValue(stored());
		expect(getExtractionConfig().staleAttemptMs).toBe(120000);
	});

	it("still ignores it when the admin raises it far past the window", () => {
		getConfig.mockReturnValue(stored({ mineruTimeoutMs: 3_600_000 }));
		expect(getExtractionConfig().staleAttemptMs).toBe(120000);
	});

	it("honours an admin who raises the key itself", () => {
		getConfig.mockReturnValue(
			stored({ documentExtractionStaleAttemptMs: 600000 }),
		);
		expect(getExtractionConfig().staleAttemptMs).toBe(600000);
	});

	it("never drops below four heartbeats, whatever the key says", () => {
		// A busy event loop can delay one beat; three missed in a row is a dead
		// worker. Two keys that can be edited independently is exactly how a
		// configuration ends up declaring a live attempt stale.
		getConfig.mockReturnValue(
			stored({
				documentExtractionStaleAttemptMs: 60000,
				documentExtractionHeartbeatMs: 120000,
			}),
		);
		expect(getExtractionConfig().staleAttemptMs).toBe(
			120000 * EXTRACTION_STALE_HEARTBEAT_FLOOR,
		);
	});
});
