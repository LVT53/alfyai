import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import {
	e2eDatabasePath,
	e2ePort,
	e2eReusesServers,
	e2eServerMode,
} from "./e2e-env";
import {
	assertBuildIsFresh,
	isPortInUse,
	killServersOnExit,
	prepareFreshDatabase,
	resetDatabaseInPlace,
	type SlotServer,
	startSlotServer,
	stopSlotServers,
} from "./e2e-servers";
import { acquireRunLock } from "./run-lock";

/**
 * One server and one database per worker slot, made before the first test.
 *
 * Slot N is the Playwright worker with `TEST_PARALLEL_INDEX` N: it talks to the
 * server on `E2E_PORT + N`, and the specs it runs open `data/…-wN.db` through
 * `$lib/server/db` (the config points `DATABASE_PATH` at the slot's file in each
 * worker). Every slot starts from a new file with the migrations applied and the
 * e2e admin seeded, so no spec meets another worker's rows, and the order in
 * which files reach workers does not matter.
 *
 * With `PLAYWRIGHT_REUSE_EXISTING_SERVER=true` a server that is already
 * listening on a slot's port is used as it is (an agent iterating on a dev
 * server it started itself): its database is reset in place, since the server
 * holds the file open. Without it, a busy port is an error, not a surprise.
 */
export default async function globalSetup(config: FullConfig) {
	const mode = e2eServerMode();
	const reuse = e2eReusesServers();
	const slots = Array.from({ length: config.workers }, (_, slot) => slot);

	if (mode === "build") assertBuildIsFresh();
	mkdirSync(join(process.cwd(), "data"), { recursive: true });
	// Runs share the databases and build/: one at a time per worktree.
	const releaseLock = acquireRunLock(slots.map((slot) => e2ePort(slot)));
	process.once("exit", releaseLock);

	const started: SlotServer[] = [];
	killServersOnExit(started);
	try {
		await Promise.all(
			slots.map(async (slot) => {
				const port = e2ePort(slot);
				const dbPath = e2eDatabasePath(slot);
				if (await isPortInUse(port)) {
					if (!reuse) {
						throw new Error(
							[
								`[e2e] Port ${port} (worker slot ${slot}) is already in use.`,
								`      Find what holds it with \`lsof -iTCP:${port} -sTCP:LISTEN\`, pick another E2E_PORT,`,
								"      or set PLAYWRIGHT_REUSE_EXISTING_SERVER=true to run against that server.",
							].join("\n"),
						);
					}
					await resetDatabaseInPlace(dbPath);
					console.log(
						`[globalSetup] slot ${slot}: using the server already on port ${port}`,
					);
					return;
				}
				await prepareFreshDatabase(dbPath);
				started.push(await startSlotServer(slot, mode));
			}),
		);
	} catch (error) {
		await stopSlotServers(started);
		releaseLock();
		throw error;
	}

	console.log(
		`[globalSetup] ${started.length} ${mode} server(s) up on ports ${slots
			.map((slot) => e2ePort(slot))
			.join(", ")}; logs in data/e2e-servers/`,
	);
	return async () => {
		await stopSlotServers(started);
		releaseLock();
	};
}
