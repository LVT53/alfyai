// Boots the engine against a fixture database, the way every engine test does.
//
// The engine opens its database through the `$lib/server/db` singleton at
// import time, so a test creates the file first, points `DATABASE_PATH` at it,
// resets the module registry and only then imports the engine. A second call
// with `bootSecondProcess` does it again: the registry is reset, the engine is
// imported anew, and it opens its OWN connection to the same file. As far as
// SQLite can tell that is another process, which is what the tests of caps and
// claims across processes need.

import { vi } from "vitest";
import { createJobsFixture, type JobsFixture } from "./fixture";
import type { TestKindControl } from "./test-kind";

export type Engine = typeof import("../index");
export type Ledger = typeof import("../ledger");

export interface BootedProcess {
	engine: Engine;
	ledger: Ledger;
	control: TestKindControl;
	/** The engine's own connection to the file, for tests that break it on purpose. */
	sqlite: typeof import("$lib/server/db").sqlite;
}

export interface EngineHarness extends BootedProcess {
	fixture: JobsFixture;
	userId: string;
	/** Another engine, with its own connection to the same file. */
	bootSecondProcess(): Promise<BootedProcess>;
	cleanup(): void;
}

async function importEngine(): Promise<BootedProcess> {
	vi.resetModules();
	const engine = await import("../index");
	const ledger = await import("../ledger");
	const { sqlite } = await import("$lib/server/db");
	const { createTestKind } = await import("./test-kind");
	return {
		engine,
		ledger,
		sqlite,
		control: createTestKind(engine.defineJobKind),
	};
}

export async function bootEngine(prefix: string): Promise<EngineHarness> {
	const fixture = createJobsFixture(prefix);
	const userId = fixture.seedUser("user-1");
	process.env.DATABASE_PATH = fixture.dbPath;

	const booted: BootedProcess[] = [await importEngine()];
	const [first] = booted;

	return {
		...first,
		fixture,
		userId,
		async bootSecondProcess(): Promise<BootedProcess> {
			const second = await importEngine();
			booted.push(second);
			return second;
		},
		cleanup(): void {
			for (const instance of booted) {
				instance.engine.resetJobsForTests();
				try {
					instance.sqlite.close();
				} catch {
					// Closed by the test already.
				}
			}
			fixture.cleanup();
		},
	};
}
