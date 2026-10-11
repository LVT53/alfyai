// Starting and stopping the servers an e2e run talks to, one per worker slot,
// and giving each its own freshly migrated, freshly seeded database file.
//
// Why the runner does this instead of Playwright's `webServer`: that option
// starts its servers one after the other, before `globalSetup`, and knows
// nothing about a database per server. Here every slot's database is made and
// every server started at once (a built server is up in about a second), and
// the logs of each server are kept in `data/e2e-servers/slot-N.log`, which is
// where a failing test's server-side error is.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { ARTIFACT_TOUR_CONTENT_VERSION } from "../../src/lib/server/artifact-tour-defaults";
import {
	ARTIFACT_TOUR_SLIDE_COUNT,
	SHIPPED_ARTIFACT_TOUR_TYPES,
} from "../../src/lib/shared/artifacts/tours";
import {
	E2E_HOST,
	type E2eServerMode,
	e2eBaseUrl,
	e2eDatabasePath,
	e2ePort,
	e2eSessionSecret,
} from "./e2e-env";

const execFileAsync = promisify(execFile);

export type SlotServer = {
	slot: number;
	port: number;
	pid: number;
	child: ChildProcess;
	logPath: string;
};

const ROOT = () => process.cwd();

// ---------------------------------------------------------------- the build

/** Where the production build's handler is: written last, so its mtime is "when the build finished". */
const BUILD_HANDLER = join("build", "handler.js");
/**
 * What the build is made of. A change to any of these after the build means the
 * build is old. (Not package.json: a script edit there changes nothing in the
 * build, and a dependency change is an install, which a clock cannot see.)
 */
const BUILD_INPUT_DIRS = ["src", "static"];
const BUILD_INPUT_FILES = [
	"svelte.config.js",
	"vite.config.js",
	"tsconfig.json",
];

function newestMtimeMs(path: string): number {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.mtimeMs;
	let newest = 0;
	for (const entry of readdirSync(path)) {
		newest = Math.max(newest, newestMtimeMs(join(path, entry)));
	}
	return newest;
}

/**
 * The servers run `build/`. A build older than the code is the worst kind of
 * wrong answer for an agent that just fixed something: the spec runs, shows the
 * old behaviour, and the fix looks like it failed. So say so, before any server.
 */
export function assertBuildIsFresh(root: string = ROOT()): void {
	const handler = join(root, BUILD_HANDLER);
	if (!existsSync(handler)) {
		throw new Error(
			[
				"[e2e] There is no production build to run (build/handler.js is missing).",
				"      Build it once with `npm run build` (about 15 s alone on a Mac),",
				"      or run against `vite dev` with E2E_SERVER=dev while you iterate on UI code.",
			].join("\n"),
		);
	}
	if (process.env.E2E_ALLOW_STALE_BUILD === "1") return;
	const builtAt = statSync(handler).mtimeMs;
	let newest = 0;
	let newestPath = "";
	for (const input of [...BUILD_INPUT_DIRS, ...BUILD_INPUT_FILES]) {
		const mtime = newestMtimeMs(join(root, input));
		if (mtime > newest) {
			newest = mtime;
			newestPath = input;
		}
	}
	// A second of grace: the build's own files are written after it reads the sources.
	if (newest > builtAt + 1000) {
		throw new Error(
			[
				`[e2e] build/ is older than the code under ${newestPath} (built ${new Date(builtAt).toLocaleTimeString()}, changed ${new Date(newest).toLocaleTimeString()}).`,
				"      Run `npm run build` again, or E2E_SERVER=dev to test the code as it is,",
				"      or E2E_ALLOW_STALE_BUILD=1 if the files' times only changed in a sync.",
			].join("\n"),
		);
	}
}

// ------------------------------------------------------------------ ports

export function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: E2E_HOST });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

// -------------------------------------------------------------- databases

function databaseEnv(dbPath: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		DATABASE_PATH: dbPath,
		E2E_DATABASE_PATH: dbPath,
		SESSION_SECRET: e2eSessionSecret(),
	};
}

const TSX = join("node_modules", "tsx", "dist", "cli.mjs");

async function seedAdmin(dbPath: string): Promise<void> {
	// `seed-admin` runs the migrations itself (`db:prepare`) before it adds the user.
	await execFileAsync(
		process.execPath,
		[
			TSX,
			"scripts/seed-admin.ts",
			"--email=admin@local",
			"--password=admin123",
			"--name=Admin User",
			"--admin",
		],
		{ cwd: ROOT(), env: databaseEnv(dbPath) },
	);
}

/** Tables that must never be wiped: drizzle's migration bookkeeping. */
const PRESERVED_TABLES = new Set(["__drizzle_migrations"]);

/**
 * Wipe all user/runtime data IN PLACE, without deleting the database file. Only
 * for a server that is already running on the file and that we did not start
 * (`PLAYWRIGHT_REUSE_EXISTING_SERVER=true`): deleting the file would strand it on
 * an unlinked inode, so every login would read an empty old file while the seed
 * landed in the new one.
 */
function wipeUserData(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.pragma("foreign_keys = OFF");
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as { name: string }[];
		db.transaction(() => {
			for (const { name } of tables) {
				if (PRESERVED_TABLES.has(name)) continue;
				db.prepare(`DELETE FROM "${name}"`).run();
			}
		})();
		db.pragma("foreign_keys = ON");
	} finally {
		db.close();
	}
}

/**
 * The shared e2e admin (the user nearly every spec signs in as) has already
 * been through every first-open tour. Without this, each artifact spec would
 * meet a card above its Document, App or Canvas the first time it opened one,
 * and the card would move what those specs measure and take the focus they
 * type into. The rows are what finishing a tour writes (`completed`, the last
 * slide, the code copy's key), put in the table directly: the app has no route
 * that resets or pre-answers a tour and gets none for tests.
 *
 * Tours are tested with users of their own (`artifact-tours.spec.ts`), who
 * have seen nothing.
 */
export function markSharedAdminToursSeen(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		const admin = db
			.prepare("SELECT id FROM users WHERE email = ?")
			.get("admin@local") as { id: string } | undefined;
		if (!admin) return;
		const insert = db.prepare(
			`INSERT OR IGNORE INTO artifact_tour_states
				(id, user_id, artifact_type, content_key, status, slide_count, last_slide, completed_at)
			VALUES (?, ?, ?, ?, 'completed', ?, ?, unixepoch())`,
		);
		for (const kind of SHIPPED_ARTIFACT_TOUR_TYPES) {
			insert.run(
				randomUUID(),
				admin.id,
				kind,
				`default:${ARTIFACT_TOUR_CONTENT_VERSION}`,
				ARTIFACT_TOUR_SLIDE_COUNT,
				ARTIFACT_TOUR_SLIDE_COUNT - 1,
			);
		}
	} finally {
		db.close();
	}
}

/** A new file: migrated, with the e2e admin, who has seen the tours. Nobody has it open. */
export async function prepareFreshDatabase(dbPath: string): Promise<void> {
	mkdirSync(join(dbPath, ".."), { recursive: true });
	for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
		rmSync(path, { force: true });
	}
	await seedAdmin(dbPath);
	markSharedAdminToursSeen(dbPath);
}

/** The same end state on a file a running server already holds open. */
export async function resetDatabaseInPlace(dbPath: string): Promise<void> {
	await execFileAsync(process.execPath, [TSX, "scripts/prepare-db.ts"], {
		cwd: ROOT(),
		env: databaseEnv(dbPath),
	});
	wipeUserData(dbPath);
	await seedAdmin(dbPath);
	markSharedAdminToursSeen(dbPath);
}

// ---------------------------------------------------------------- servers

/**
 * Loaded before the app in every e2e server: its transactions take their write lock when
 * they begin, because the spec's own process writes the same file (see
 * immediate-transactions.cjs). The Playwright config loads the same file in each worker.
 */
const SQLITE_PRELOAD = () =>
	// Absolute: `node -r tests/e2e/x.cjs` would be looked up as a package name.
	join(ROOT(), "tests", "e2e", "sqlite-immediate.cjs");

export function serverCommand(
	slot: number,
	mode: E2eServerMode,
): { args: string[]; env: NodeJS.ProcessEnv } {
	const port = e2ePort(slot);
	const dbPath = e2eDatabasePath(slot);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		// The same dotenv preload the dev server always had: a developer's .env still applies.
		dotenv_config_path: ".env",
		PLAYWRIGHT_TEST: "1",
		// The home summary is cached 30s per user in production. Specs seed the
		// conversations, jobs and usage rows it reads straight into SQLite,
		// behind the server's back, so a warm entry would serve the state from
		// before the seed. Off here; the TTL itself is unit-tested.
		HOME_SUMMARY_CACHE_TTL_MS: "0",
		DATABASE_PATH: dbPath,
		E2E_DATABASE_PATH: dbPath,
		SESSION_SECRET: e2eSessionSecret(),
	};
	if (mode === "build") {
		// `production` would make the session cookie Secure, which a plain-http test
		// server cannot set for the API request contexts; `vite dev` never set it.
		if (env.NODE_ENV === "production") delete env.NODE_ENV;
		Object.assign(env, {
			PORT: String(port),
			HOST: E2E_HOST,
			ORIGIN: e2eBaseUrl(slot),
		});
		return {
			args: [
				"-r",
				"dotenv/config",
				"-r",
				SQLITE_PRELOAD(),
				join("build", "index.js"),
			],
			env,
		};
	}
	// One optimizer cache per dev server: two servers re-optimizing one cache break each other.
	env.VITE_CACHE_DIR = join(ROOT(), "data", "vite-cache", `w${slot}`);
	return {
		args: [
			"-r",
			"dotenv/config",
			"-r",
			SQLITE_PRELOAD(),
			join("node_modules", "vite", "bin", "vite.js"),
			"dev",
			"--host",
			E2E_HOST,
			"--port",
			String(port),
			"--strictPort",
		],
		env,
	};
}

async function waitUntilServing(
	server: SlotServer,
	timeoutMs: number,
): Promise<void> {
	const url = `${e2eBaseUrl(server.slot)}/login`;
	const deadline = Date.now() + timeoutMs;
	let exited: number | null | undefined;
	server.child.once("exit", (code) => {
		exited = code;
	});
	while (Date.now() < deadline) {
		if (exited !== undefined) {
			throw new Error(
				`[e2e] The server for slot ${server.slot} exited with code ${exited} before it answered; see ${server.logPath}`,
			);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
			if (response.ok) return;
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(
		`[e2e] The server for slot ${server.slot} did not answer ${url} within ${Math.round(timeoutMs / 1000)} s; see ${server.logPath}`,
	);
}

export async function startSlotServer(
	slot: number,
	mode: E2eServerMode,
): Promise<SlotServer> {
	const logDir = join(ROOT(), "data", "e2e-servers");
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, `slot-${slot}.log`);
	const log = createWriteStream(logPath);
	const { args, env } = serverCommand(slot, mode);
	const child = spawn(process.execPath, args, {
		cwd: ROOT(),
		env,
		// Its own process group, so stopping it stops what it started (vite's workers) too.
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Each line of the server's output with the seconds since it started: a failing
	// spec's server-side story (how long a turn took, what came after what) is only
	// readable with a clock.
	const startedAt = Date.now();
	for (const stream of [child.stdout, child.stderr]) {
		let pending = "";
		stream?.setEncoding("utf8");
		stream?.on("data", (chunk: string) => {
			const lines = (pending + chunk).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const seconds = ((Date.now() - startedAt) / 1000).toFixed(3);
				log.write(`[+${seconds}s] ${line}\n`);
			}
		});
		stream?.on("end", () => {
			if (pending !== "") log.write(`[+end] ${pending}\n`);
		});
	}
	if (child.pid === undefined) {
		throw new Error(`[e2e] Could not start the server for slot ${slot}`);
	}
	const server: SlotServer = {
		slot,
		port: e2ePort(slot),
		pid: child.pid,
		child,
		logPath,
	};
	try {
		await waitUntilServing(server, mode === "build" ? 60_000 : 180_000);
	} catch (error) {
		await stopSlotServers([server]);
		throw error;
	}
	return server;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// already gone
	}
}

export async function stopSlotServers(servers: SlotServer[]): Promise<void> {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve) => {
					if (server.child.exitCode !== null || server.child.signalCode) {
						resolve();
						return;
					}
					const timer = setTimeout(() => {
						killGroup(server.pid, "SIGKILL");
						resolve();
					}, 5000);
					server.child.once("exit", () => {
						clearTimeout(timer);
						// The group may outlive its leader (vite's helpers): make sure.
						killGroup(server.pid, "SIGKILL");
						resolve();
					});
					killGroup(server.pid, "SIGTERM");
				}),
		),
	);
}

/**
 * Last resort for a runner that dies without its teardown: the servers must not
 * outlive it. Playwright tears down on SIGINT and on a normal exit; a SIGTERM or a
 * closed terminal (SIGHUP) would leave them listening on their ports and the next
 * run would refuse to start, so those two are handled here.
 */
export function killServersOnExit(
	servers: SlotServer[],
	onSignal: () => void = () => {},
): void {
	process.once("exit", () => {
		for (const server of servers) killGroup(server.pid, "SIGKILL");
	});
	for (const [signal, code] of [
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const) {
		process.once(signal, () => {
			for (const server of servers) killGroup(server.pid, "SIGKILL");
			onSignal();
			process.exit(code);
		});
	}
}
