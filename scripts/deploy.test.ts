import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	SANDBOX_PYTHON_IMAGE,
	SANDBOX_PYTHON_IMPORT_NAMES,
	SANDBOX_PYTHON_PACKAGES,
	SANDBOX_PYTHON_PACKAGES_MOUNT_PATH,
	SANDBOX_PYTHON_SITE_PACKAGES_RELPATH,
	SANDBOX_PYTHON_VERSION,
} from "../src/lib/server/sandbox/python-version";

// These tests read scripts/deploy.sh and scripts/deploy-dev.sh as plain text
// and assert the ADR-0054 atomic-release properties. See
// docs/adr/0054-atomic-release-cutover.md for the design these encode.

const DEPLOY_SH_PATH = resolve(__dirname, "deploy.sh");
const DEPLOY_DEV_SH_PATH = resolve(__dirname, "deploy-dev.sh");
const DEPLOY_LIB_SH_PATH = resolve(__dirname, "deploy-lib.sh");
const SANDBOX_VERSION_SH_PATH = resolve(__dirname, "sandbox-python-version.sh");
const VERIFY_PACKAGES_SH_PATH = resolve(
	__dirname,
	"verify-sandbox-packages.sh",
);
const SANDBOX_CONFIG_TS_PATH = resolve(
	__dirname,
	"../src/lib/server/sandbox/config.ts",
);
const NORMAL_CHAT_TOOLS_TS_PATH = resolve(
	__dirname,
	"../src/lib/server/services/normal-chat-tools/index.ts",
);

const deployScript = readFileSync(DEPLOY_SH_PATH, "utf8");
const deployDevScript = readFileSync(DEPLOY_DEV_SH_PATH, "utf8");
const deployLibScript = readFileSync(DEPLOY_LIB_SH_PATH, "utf8");
const sandboxVersionScript = readFileSync(SANDBOX_VERSION_SH_PATH, "utf8");
const verifyPackagesScript = readFileSync(VERIFY_PACKAGES_SH_PATH, "utf8");
const sandboxConfigSource = readFileSync(SANDBOX_CONFIG_TS_PATH, "utf8");
const normalChatToolsSource = readFileSync(NORMAL_CHAT_TOOLS_TS_PATH, "utf8");

/**
 * Reads a plain `NAME="value"` assignment out of a sourced shell constants
 * file. Deliberately dumb: these files are only allowed to contain literal
 * assignments, so a regex is the whole parser.
 */
function shellConstant(script: string, name: string): string | null {
	const match = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
	return match ? match[1] : null;
}

/** The same assignment with `${SANDBOX_PYTHON_VERSION}` expanded. */
function expandedShellConstant(script: string, name: string): string | null {
	const raw = shellConstant(script, name);
	if (raw === null) return null;
	const version = shellConstant(script, "SANDBOX_PYTHON_VERSION") ?? "";
	// Written as a concatenation so Biome doesn't read the shell placeholder
	// as a mis-typed JS template literal.
	return raw.replaceAll(`\${${"SANDBOX_PYTHON_VERSION"}}`, version);
}

/**
 * Every `rm ...` invocation found in a shell script, captured up to the end
 * of that shell statement (newline, `;`, `&&`, `||`, or `|`).
 */
function rmInvocations(script: string): string[] {
	const matches = script.match(/\brm\s+[^\n;&|]+/g);
	return matches ?? [];
}

/**
 * True when a captured `rm` invocation targets `current`, `shared`, or a
 * path under either (including the durable `shared/data` and `shared/.env`)
 * as a whole path component. Deliberately does NOT match lookalikes such as
 * `current.tmp` (the atomic-flip staging symlink) or `releases/<sha>`.
 */
function targetsProtectedPath(rmInvocation: string): boolean {
	const wholeComponent = /(^|[\s"'/])(current|shared)([\s"'/]|$)/;
	const dotEnv = /(^|[\s"'/])\.env([\s"'/]|$)/;
	return wholeComponent.test(rmInvocation) || dotEnv.test(rmInvocation);
}

/**
 * The body of a top-level shell function, from its `name() {` header to the
 * first line that is exactly `}`. These files only define top-level
 * functions, so that is an exact parse rather than a heuristic. Throws when
 * the function is missing, so a renamed function fails the assertion that
 * uses it instead of silently passing against an empty string.
 */
function shellFunctionBody(script: string, name: string): string {
	const header = `${name}() {`;
	const start = script.indexOf(header);
	if (start === -1) {
		throw new Error(`shell function ${name}() not found`);
	}
	const end = script.indexOf("\n}\n", start);
	if (end === -1) {
		throw new Error(`shell function ${name}() is not closed`);
	}
	return script.slice(start + header.length, end);
}

function releasesToKeep(script: string): number {
	const match = script.match(/RELEASES_TO_KEEP(?::-|=)"?(\d+)"?/);
	return match ? Number(match[1]) : Number.NaN;
}

/**
 * Strips comment-only lines, blank lines, the restart_service() function
 * body (intentionally different: prod has passwordless sudo, staging falls
 * back to printing a privileged command), and the three intentionally
 * differing default-variable values (branch, service, health port) so the
 * remaining executable body can be compared for exact equality between the
 * prod and staging scripts.
 */
function normalizeForMirrorComparison(script: string): string {
	const withoutRestartFn = script.replace(
		/restart_service\(\) \{[\s\S]*?\n\}\n/,
		"restart_service() {\n  # environment-specific; see header comment\n}\n",
	);
	return withoutRestartFn
		.split("\n")
		.filter((line) => line.trim() !== "" && !/^\s*#/.test(line))
		.join("\n")
		.replace(/DEPLOY_BRANCH:-\w+/g, 'DEPLOY_BRANCH:-"<branch>"')
		.replace(/SERVICE_NAME:-[\w.-]+/g, 'SERVICE_NAME:-"<service>"')
		.replace(/HEALTH_PORT:-\d+/g, 'HEALTH_PORT:-"<port>"');
}

describe.each([
	["scripts/deploy.sh", deployScript],
	["scripts/deploy-dev.sh", deployDevScript],
])("%s (ADR-0054 atomic release properties)", (_label, script) => {
	it("never rm -rf's (or otherwise removes) current/, shared/, shared/data, or .env", () => {
		const dangerous = rmInvocations(script).filter(targetsProtectedPath);
		expect(dangerous).toEqual([]);
	});

	it("materializes each release into a releases/<sha> directory via git archive", () => {
		expect(script).toMatch(/releases\//);
		expect(script).toMatch(/rev-parse\s+--short/);
		expect(script).toMatch(/git(?:\s+-C\s+"[^"]+")?\s+archive/);
		expect(script).toMatch(/tar\s+-x/);
	});

	it("tries npm ci and falls back to npm install", () => {
		expect(script).toMatch(/npm ci \|\| npm install/);
	});

	it("runs db:prepare after build and before the symlink flip", () => {
		const buildIndex = script.indexOf("npm run build");
		const dbPrepareIndex = script.indexOf("npm run db:prepare");
		const flipIndex = script.indexOf("mv -Tf");

		expect(buildIndex).toBeGreaterThan(-1);
		expect(dbPrepareIndex).toBeGreaterThan(buildIndex);
		expect(flipIndex).toBeGreaterThan(dbPrepareIndex);
	});

	it("cuts over with an atomic symlink flip, not cp or a bare rm of current", () => {
		expect(script).toMatch(/ln -sfn/);
		expect(script).toMatch(/mv -Tf|mv -T\b/);
		expect(script).not.toMatch(/\bcp\s+-[a-zA-Z]*r[a-zA-Z]*\s+\S*current/);
	});

	it("still runs npm run check:migrations", () => {
		expect(script).toContain("npm run check:migrations");
	});

	it("retains the last 3 releases via a prune step", () => {
		expect(releasesToKeep(script)).toBe(3);
		expect(script).toMatch(/RELEASES_DIR/);
	});

	it("errors with a clear message instead of migrating a missing shared/ layout", () => {
		expect(script).toMatch(/if\s+\[\s+!\s+-d\s+"\$SHARED_DIR"\s+\]/);
		expect(script).toMatch(/exit 1/);
	});

	// D2 (ADR-0054 amendment): drains in-flight streams before the cutover
	// restart so no user turn is interrupted. Gated on ALFYAI_API_SIGNING_KEY
	// (never fails the deploy when it's unset) and capped so a stuck drain
	// can't hang the deploy forever.
	describe("D2 drain-before-cutover step", () => {
		it("drains via POST /api/admin/drain gated on ALFYAI_API_SIGNING_KEY, before the symlink flip", () => {
			const drainIndex = script.indexOf("/api/admin/drain");
			const dbPrepareIndex = script.indexOf("npm run db:prepare");
			const flipIndex = script.indexOf("mv -Tf");

			expect(drainIndex).toBeGreaterThan(-1);
			expect(drainIndex).toBeGreaterThan(dbPrepareIndex);
			expect(drainIndex).toBeLessThan(flipIndex);
			expect(script).toMatch(/if\s+\[\s+-n\s+"\$ALFYAI_API_SIGNING_KEY"\s+\]/);
			expect(script).toMatch(/Authorization: Bearer \$ALFYAI_API_SIGNING_KEY/);
			expect(script).toMatch(/"draining":\s*true/);
		});

		it("polls /api/health's activeStreams down to 0 with a hard cap, using only curl/grep/sed (no jq)", () => {
			expect(script).toMatch(/http:\/\/localhost:\$HEALTH_PORT\/api\/health/);
			expect(script).toMatch(/activeStreams/);
			expect(script).not.toMatch(/\bjq\b/);

			const drainBlockMatch = script.match(
				/ALFYAI_API_SIGNING_KEY[\s\S]*?(?=\n\n)/,
			);
			expect(drainBlockMatch).not.toBeNull();
			const drainBlock = drainBlockMatch?.[0] ?? "";
			// 60 attempts * 2s sleep = 120s hard cap.
			expect(drainBlock).toMatch(/seq 1 60/);
			expect(drainBlock).toMatch(/sleep 2/);
		});

		it("never fails the deploy on the drain step (no bare exit 1 inside the drain block)", () => {
			const startIndex = script.indexOf("ALFYAI_API_SIGNING_KEY");
			const flipIndex = script.indexOf("mv -Tf");
			const drainBlock = script.slice(startIndex, flipIndex);

			expect(drainBlock).not.toMatch(/\bexit 1\b/);
		});
	});
});

// ---------------------------------------------------------------------------
// Python sandbox packages.
//
// The 2026-09-17 outage: the deploy built a venv with the HOST python (3.12 on
// the box) and installed openpyxl et al. into
// sandbox-python-env/lib/python3.12/site-packages, while the container mounts
// .../python3.11/site-packages. Docker created the missing mount source as an
// empty root-owned directory, every Python program-mode job died with
// ModuleNotFoundError, and the root-owned directory then made every later
// prune step fail. These tests pin the three things that must agree.
// ---------------------------------------------------------------------------
describe("sandbox Python version is declared once", () => {
	it("scripts/sandbox-python-version.sh matches src/lib/server/sandbox/python-version.ts", () => {
		expect(shellConstant(sandboxVersionScript, "SANDBOX_PYTHON_VERSION")).toBe(
			SANDBOX_PYTHON_VERSION,
		);
		expect(
			expandedShellConstant(sandboxVersionScript, "SANDBOX_PYTHON_IMAGE"),
		).toBe(SANDBOX_PYTHON_IMAGE);
		expect(
			expandedShellConstant(
				sandboxVersionScript,
				"SANDBOX_PYTHON_PACKAGES_MOUNT_PATH",
			),
		).toBe(SANDBOX_PYTHON_PACKAGES_MOUNT_PATH);
	});

	it("the deploy scripts write to the same path config.ts bind-mounts", () => {
		const shellRelpath = expandedShellConstant(
			sandboxVersionScript,
			"SANDBOX_PYTHON_SITE_PACKAGES_RELPATH",
		);

		expect(shellRelpath).toBe(SANDBOX_PYTHON_SITE_PACKAGES_RELPATH);
		expect(shellRelpath).toBe(
			`sandbox-python-env/lib/python${SANDBOX_PYTHON_VERSION}/site-packages`,
		);

		// The installer and the verifier both build their target from that one
		// constant rather than re-spelling the path.
		expect(deployLibScript).toContain(
			'"$release_dir/$SANDBOX_PYTHON_SITE_PACKAGES_RELPATH"',
		);
		expect(verifyPackagesScript).toContain(
			'"$RELEASE_DIR/$SANDBOX_PYTHON_SITE_PACKAGES_RELPATH"',
		);
	});

	it("config.ts derives the mount from the shared constant instead of a literal version", () => {
		expect(sandboxConfigSource).toContain(
			"SANDBOX_PYTHON_SITE_PACKAGES_RELPATH",
		);
		expect(sandboxConfigSource).toContain("SANDBOX_PYTHON_IMAGE");
		expect(sandboxConfigSource).not.toMatch(/python3\.\d+/);
		expect(sandboxConfigSource).not.toMatch(/"python:3\.\d+-slim"/);
	});

	it("no deploy script hardcodes a Python minor version in executable code", () => {
		// Comments may spell the path out for a human reader; executable lines
		// must go through the constant.
		const withoutComments = (script: string) =>
			script
				.split("\n")
				.filter((line) => !/^\s*#/.test(line))
				.join("\n");

		for (const script of [deployScript, deployDevScript, deployLibScript]) {
			expect(withoutComments(script)).not.toMatch(/python3\.\d+/);
			expect(withoutComments(script)).not.toMatch(/python:3\.\d+-slim/);
		}
	});
});

describe("sandbox Python package list", () => {
	it("matches the TypeScript list and its import names", () => {
		const shellPackages = shellConstant(
			sandboxVersionScript,
			"SANDBOX_PYTHON_PACKAGES",
		);
		const shellImports = shellConstant(
			sandboxVersionScript,
			"SANDBOX_PYTHON_IMPORT_NAMES",
		);

		expect(shellPackages?.split(/\s+/)).toEqual([...SANDBOX_PYTHON_PACKAGES]);
		expect(shellImports?.split(/\s+/)).toEqual([
			...SANDBOX_PYTHON_IMPORT_NAMES,
		]);
		expect(SANDBOX_PYTHON_IMPORT_NAMES).toHaveLength(
			SANDBOX_PYTHON_PACKAGES.length,
		);
	});

	it("matches what the tool descriptions promise the model", () => {
		// src/lib/server/services/normal-chat-tools/index.ts tells the model
		// "openpyxl, xlsxwriter, python-docx and python-pptx are present".
		// Promising a package the deploy never installs is the bug this whole
		// file guards against, so the promise and the install list are pinned
		// to each other.
		for (const packageName of SANDBOX_PYTHON_PACKAGES) {
			expect(normalChatToolsSource).toContain(packageName);
		}
	});
});

describe("scripts/deploy-lib.sh (shared deploy steps)", () => {
	it("never rm -rf's current/, shared/, shared/data, or .env", () => {
		const dangerous =
			rmInvocations(deployLibScript).filter(targetsProtectedPath);
		expect(dangerous).toEqual([]);
	});

	it("installs wheels for the container's interpreter, not the host's", () => {
		const crossInstall = shellFunctionBody(
			deployLibScript,
			"sandbox_pip_cross_install",
		);
		expect(crossInstall).toContain('--target "$target"');
		expect(crossInstall).toContain(
			'--python-version "$SANDBOX_PYTHON_VERSION"',
		);
		expect(crossInstall).toContain("--implementation cp");
		expect(crossInstall).toContain("--only-binary=:all:");
		expect(crossInstall).toMatch(/--platform manylinux\S*_x86_64/);
		// Re-running on a release directory that already has packages (a
		// redeploy of the same sha) must replace them, not make pip warn and
		// skip.
		expect(crossInstall).toContain("--upgrade");
	});

	it("only ever builds a venv as a throwaway pip bootstrap, never as the mount source", () => {
		// Installing into a venv built with the HOST python is the bug. A venv
		// is still allowed as a way to *obtain* a pip on a host whose python3
		// has no pip module (the Debian python3-pip split) — but it must live
		// in a scratch directory and be deleted again, and the install itself
		// still goes through sandbox_pip_cross_install's --target.
		const venvInvocations = deployLibScript.match(/-m venv\s+\S+/g) ?? [];
		expect(venvInvocations).toEqual(['-m venv "$bootstrap_dir/venv"']);

		const bootstrap = shellFunctionBody(
			deployLibScript,
			"sandbox_install_with_bootstrap_venv",
		);
		expect(bootstrap).toContain("mktemp -d");
		expect(bootstrap).toContain('rm -rf "$bootstrap_dir"');
		expect(bootstrap).toContain(
			'sandbox_pip_cross_install "$bootstrap_dir/venv/bin/pip" "$target"',
		);
		// Nothing from the throwaway venv is ever the mount source.
		expect(bootstrap).not.toContain("SANDBOX_PYTHON_SITE_PACKAGES_RELPATH");
	});

	it("creates the mount source as the deploying user before Docker can", () => {
		expect(deployLibScript).toContain('mkdir -p "$target"');
		expect(deployLibScript).toContain('--user "$(id -u):$(id -g)"');
	});

	it("never lets the sandbox step abort the deploy, even when mkdir fails", () => {
		const setup = shellFunctionBody(
			deployLibScript,
			"setup_sandbox_python_packages",
		);
		// Both deploy scripts call this as a plain command under `set -e`, so
		// every command in it has to be guarded or the deploy dies here.
		expect(setup).toMatch(/if\s+!\s+mkdir -p "\$target"/);
		expect(setup).not.toMatch(/^\s*mkdir -p "\$target"\s*$/m);
		// Every exit path returns 0.
		expect(setup).not.toMatch(/\breturn 1\b/);
		expect(setup).not.toMatch(/\bexit\b/);
	});

	it("bounds every external command so a wedged Docker or index cannot hang a deploy", () => {
		// DOCKER_HOST is a TCP socket proxy; `docker version`/`docker run` have
		// no client-side timeout of their own, and neither does pip.
		for (const fn of [
			"sandbox_pip_cross_install",
			"sandbox_docker_is_reachable",
			"sandbox_install_with_container",
		]) {
			expect(shellFunctionBody(deployLibScript, fn)).toContain(
				"sandbox_bounded",
			);
		}
		expect(
			shellFunctionBody(deployLibScript, "sandbox_install_with_bootstrap_venv"),
		).toContain("sandbox_bounded");
		// The verifier runs mid-deploy too, and must not pull a missing image.
		expect(verifyPackagesScript).toContain("sandbox_bounded");
		expect(verifyPackagesScript).toContain("docker image inspect");
		// The helper itself degrades to running unbounded rather than skipping
		// the step on a host without coreutils `timeout`.
		expect(sandboxVersionScript).toContain("sandbox_bounded()");
		expect(sandboxVersionScript).toMatch(/timeout "\$seconds" "\$@"/);
	});

	it("warns loudly instead of silencing a failed package install", () => {
		expect(deployLibScript).toContain("deploy_warn");
		expect(deployLibScript).toMatch(/ModuleNotFoundError/);
		// No `|| true` anywhere in the helper: an install or prune failure must
		// reach deploy_warn rather than being swallowed the way the old
		// `pip install ... 2>/dev/null || true` line swallowed it.
		expect(deployLibScript).not.toMatch(/\|\|\s*true/);
		// pip's own stderr is never redirected away either — the old
		// `pip install ... 2>/dev/null || true` is exactly how a completely
		// empty site-packages directory reached production unnoticed.
		const silencedInstallLines = deployLibScript
			.split("\n")
			.filter((line) => /install\b/.test(line) && /\/dev\/null/.test(line));
		expect(silencedInstallLines).toEqual([]);
	});

	it("tolerates root-owned leftovers when pruning and prints the sudo cleanup", () => {
		const pruneBody = shellFunctionBody(deployLibScript, "prune_old_releases");
		expect(pruneBody).toContain("sudo rm -rf");
		expect(pruneBody).toContain("sudo chown -R");
		// A release we cannot delete is a disk-space problem, not a deploy
		// failure: the function returns 0 and records a warning instead.
		expect(pruneBody).not.toMatch(/\bexit 1\b/);
		expect(pruneBody).toContain("deploy_warn");
		// The warning has to name the paths AND carry the real error, so a full
		// disk or a read-only filesystem is not filed forever under
		// "root-owned files".
		expect(pruneBody).toContain("$leftovers");
		// Written as a concatenation so Biome doesn't read the shell array
		// expansion as a mis-typed JS template literal.
		expect(pruneBody).toContain(`\${${"reasons[0]"}}`);
	});

	it("refuses to delete the live release or the one being deployed", () => {
		const pruneBody = shellFunctionBody(deployLibScript, "prune_old_releases");
		// Protected paths arrive as trailing arguments and are compared after
		// symlinks are resolved, so `current` is matched by the directory it
		// points at rather than by its own name.
		expect(pruneBody).toContain("deploy_path_is_protected");
		expect(pruneBody).toContain("deploy_canonical_dir");
		expect(
			shellFunctionBody(deployLibScript, "deploy_canonical_dir"),
		).toContain("pwd -P");
		// The guard runs before the rm, not after it.
		const guardIndex = pruneBody.indexOf("deploy_path_is_protected");
		const rmIndex = pruneBody.indexOf("rm -rf --");
		expect(guardIndex).toBeGreaterThan(-1);
		expect(rmIndex).toBeGreaterThan(guardIndex);
	});
});

describe.each([
	["scripts/deploy.sh", deployScript],
	["scripts/deploy-dev.sh", deployDevScript],
])("%s (sandbox package step)", (_label, script) => {
	it("sources the shared helper out of the release it just materialized", () => {
		expect(script).toContain('source "$RELEASE_DIR/scripts/deploy-lib.sh"');
		const archiveIndex = script.indexOf('git -C "$APP_DIR" archive');
		const sourceIndex = script.indexOf(
			'source "$RELEASE_DIR/scripts/deploy-lib.sh"',
		);
		expect(sourceIndex).toBeGreaterThan(archiveIndex);
	});

	it("never `source`s deploy-lib.sh unguarded, which under set -e would abort a rollback deploy", () => {
		// Deploying a sha from before deploy-lib.sh existed (how a rollback is
		// done when `current` is already gone) must not kill the deploy at the
		// source line. Every source is behind an -f test, with this script's
		// own copy as the fallback and stand-ins as the last resort.
		for (const line of script.split("\n")) {
			if (!/^\s*source\s/.test(line)) continue;
			if (line.includes("/.env")) continue;
			expect(line).toMatch(/deploy-lib\.sh/);
		}
		expect(script).toContain('if [ -f "$RELEASE_DIR/scripts/deploy-lib.sh" ]');
		expect(script).toContain('elif [ -f "$SCRIPT_DIR/deploy-lib.sh" ]');
		expect(script).toMatch(/SCRIPT_DIR="\$\(cd "\$\(dirname/);
		// The last resort defines every name the rest of the script calls, so
		// nothing later explodes with "command not found".
		for (const fn of [
			"deploy_warn()",
			"print_deploy_warnings()",
			"setup_sandbox_python_packages()",
			"prune_old_releases()",
			"backup_database()",
		]) {
			expect(script).toContain(`  ${fn} {`);
		}
	});

	it("passes the live release and the one being deployed to the prune step as protected", () => {
		expect(script).toContain(
			'prune_old_releases "$RELEASES_DIR" "$RELEASES_TO_KEEP" "$APP_DIR/current" "$RELEASE_DIR"',
		);
	});

	it("installs the sandbox packages before the cutover, never inside the downtime window", () => {
		const setupIndex = script.indexOf(
			'setup_sandbox_python_packages "$RELEASE_DIR"',
		);
		const flipIndex = script.indexOf("mv -Tf");
		const restartIndex = script.indexOf("if restart_service;");

		expect(setupIndex).toBeGreaterThan(-1);
		expect(setupIndex).toBeLessThan(flipIndex);
		expect(setupIndex).toBeLessThan(restartIndex);
	});

	it("installs the sandbox packages after the .env load, so DOCKER_HOST is set", () => {
		const envLoadIndex = script.indexOf('source "$RELEASE_DIR/.env"');
		const setupIndex = script.indexOf(
			'setup_sandbox_python_packages "$RELEASE_DIR"',
		);
		const buildIndex = script.indexOf("npm run build");

		expect(envLoadIndex).toBeGreaterThan(-1);
		expect(setupIndex).toBeGreaterThan(envLoadIndex);
		expect(setupIndex).toBeLessThan(buildIndex);
	});

	it("prunes through the tolerant helper and repeats warnings in the summary", () => {
		expect(script).toContain(
			'prune_old_releases "$RELEASES_DIR" "$RELEASES_TO_KEEP"',
		);
		// lastIndexOf: both names also appear in the header comment block.
		const summaryIndex = script.lastIndexOf("=== Deployment complete!");
		const warningsIndex = script.lastIndexOf("print_deploy_warnings");
		expect(summaryIndex).toBeGreaterThan(-1);
		expect(warningsIndex).toBeGreaterThan(summaryIndex);
	});
});

// ---------------------------------------------------------------------------
// Database backup before migrations.
//
// db:prepare runs 110 migrations (9 destructive) against the live ~140 MB
// SQLite file under shared/data. Until now there was no copy of it anywhere.
// The backup is the one step allowed to abort a deploy, because it happens
// before the cutover: aborting leaves production on the old release with an
// unmigrated database, which is strictly safer than migrating blind.
// ---------------------------------------------------------------------------

describe.each([
	["scripts/deploy.sh", deployScript],
	["scripts/deploy-dev.sh", deployDevScript],
])("%s (database backup step)", (_label, script) => {
	it("backs up the database before db:prepare and before the cutover", () => {
		const backupIndex = script.indexOf(
			'backup_database "$RELEASE_DIR" "$SHARED_DIR" "$RELEASE_SHA"',
		);
		const dbPrepareIndex = script.indexOf("npm run db:prepare");
		const flipIndex = script.indexOf("mv -Tf");

		expect(backupIndex).toBeGreaterThan(-1);
		expect(backupIndex).toBeLessThan(dbPrepareIndex);
		expect(backupIndex).toBeLessThan(flipIndex);
	});

	it("aborts the deploy when the backup fails", () => {
		// The ONLY `exit 1` between the migration-check step and the drain
		// block. Written as `if ! backup_database ...; then exit 1; fi` rather
		// than relying on `set -e`, so the helper's own explanation is printed
		// first.
		expect(script).toMatch(
			/if ! backup_database "\$RELEASE_DIR" "\$SHARED_DIR" "\$RELEASE_SHA"; then\n\s*exit 1\n\s*fi/,
		);
	});

	it("keeps the abort out of the drain block, which must never fail a deploy", () => {
		// The existing drain assertion slices from the first
		// ALFYAI_API_SIGNING_KEY to the flip and forbids `exit 1` there; the
		// backup has to sit before that slice starts, not inside it.
		const backupIndex = script.indexOf('if ! backup_database "$RELEASE_DIR"');
		const drainIndex = script.indexOf("ALFYAI_API_SIGNING_KEY");

		expect(backupIndex).toBeGreaterThan(-1);
		expect(drainIndex).toBeGreaterThan(-1);
		expect(backupIndex).toBeLessThan(drainIndex);
	});
});

describe("scripts/deploy-lib.sh backup_database (static)", () => {
	it("prefers sqlite3's online .backup, then better-sqlite3, then cp", () => {
		const body = shellFunctionBody(deployLibScript, "backup_database");
		const sqliteIndex = body.indexOf("db_backup_with_sqlite3");
		const nodeIndex = body.indexOf("db_backup_with_node");
		const cpIndex = body.indexOf("db_backup_with_cp");

		expect(sqliteIndex).toBeGreaterThan(-1);
		expect(nodeIndex).toBeGreaterThan(sqliteIndex);
		expect(cpIndex).toBeGreaterThan(nodeIndex);

		// The two consistent strategies use SQLite's online backup API, which is
		// the only thing that is safe against the live writer under WAL.
		expect(
			shellFunctionBody(deployLibScript, "db_backup_with_sqlite3"),
		).toContain(".backup");
		expect(shellFunctionBody(deployLibScript, "db_backup_with_node")).toContain(
			"db.backup(",
		);
		// The cp fallback is only correct if it takes the sidecars too.
		const cpBody = shellFunctionBody(deployLibScript, "db_backup_with_cp");
		expect(cpBody).toContain('"$db-wal"');
		expect(cpBody).toContain('"$db-shm"');
	});

	it("bounds every external command so a stalled filesystem cannot hang a deploy", () => {
		for (const fn of [
			"db_backup_with_sqlite3",
			"db_backup_with_node",
			"db_backup_verify",
		]) {
			expect(shellFunctionBody(deployLibScript, fn)).toContain(
				"sandbox_bounded",
			);
		}
	});

	it("verifies the backup with PRAGMA integrity_check, or at least a non-empty file", () => {
		const body = shellFunctionBody(deployLibScript, "db_backup_verify");
		expect(body).toContain("integrity_check");
		expect(body).toContain('[ -s "$dest" ]');
	});

	it("resolves the database path the same way db:prepare does", () => {
		// db:prepare defaults DATABASE_PATH to "./data/chat.db" and runs with the
		// release directory as cwd, where `data` is a symlink to shared/data.
		// Backing up a different file than the one about to be migrated would be
		// worse than no backup, because it would look like it worked.
		const body = shellFunctionBody(deployLibScript, "deploy_database_path");
		expect(body).toContain('"$shared_dir/data/chat.db"');
		expect(body).toContain('/*) echo "$DATABASE_PATH"');
		// Split so Biome doesn't read the shell parameter expansion as a
		// mis-typed JS template literal, the same way the constants above are.
		expect(body).toContain('*) echo "$release_dir/');
		expect(body).toContain("DATABASE_PATH#./");
	});

	it("writes owner-only, under a 700 directory, into shared/backups", () => {
		const body = shellFunctionBody(deployLibScript, "backup_database");
		expect(body).toContain('"$shared_dir/backups"');
		expect(body).toMatch(/chat-\$timestamp-\$release_sha\.db/);
		expect(body).toContain('chmod 700 "$backup_dir"');
		expect(body).toContain('chmod 600 "$dest"');
		// Born restricted rather than widened for the length of a 140 MB copy.
		for (const fn of [
			"db_backup_with_sqlite3",
			"db_backup_with_node",
			"db_backup_with_cp",
		]) {
			expect(shellFunctionBody(deployLibScript, fn)).toContain("umask 077");
		}
	});

	it("defaults retention to 7 and makes the backup required, both overridable", () => {
		expect(deployLibScript).toMatch(/DB_BACKUP_KEEP="\$\{DB_BACKUP_KEEP:-7\}"/);
		expect(deployLibScript).toMatch(
			/DB_BACKUP_REQUIRED="\$\{DB_BACKUP_REQUIRED:-1\}"/,
		);
	});

	it("prints the restore command in the success line", () => {
		expect(shellFunctionBody(deployLibScript, "backup_database")).toMatch(
			/Restore:/,
		);
	});
});

// ---------------------------------------------------------------------------
// The same helper, actually executed. Everything above is text matching; these
// source scripts/deploy-lib.sh in a real bash and run the functions against
// throwaway directories, because the failure modes that matter here (a backup
// that "succeeds" into a zero-byte file, a retention sweep that eats the
// backup it just made) are behavioural, not textual.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..");
const scratchDirs: string[] = [];

function makeScratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "alfyai-deploy-backup-"));
	scratchDirs.push(dir);
	return dir;
}

/**
 * Sources scripts/deploy-lib.sh in a real bash and runs `script` after it,
 * under `set -e` exactly as the deploy scripts do.
 *
 * DATABASE_PATH is blanked unless a case sets it: vitest's global setup puts a
 * test database path in the ambient environment, and inheriting it would make
 * every case back up the wrong file.
 */
function runDeployLib(
	script: string,
	env: Record<string, string> = {},
): { status: number; output: string } {
	const result = spawnSync(
		"bash",
		["-c", `set -e\nsource "${DEPLOY_LIB_SH_PATH}"\n${script}`],
		{
			encoding: "utf8",
			env: { ...process.env, DATABASE_PATH: "", ...env },
		},
	);
	return {
		status: result.status ?? -1,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

/** A shared/ + releases/<sha> layout with a real, populated SQLite database. */
function makeFakeDeployTree(options: { withDatabase: boolean }): {
	root: string;
	sharedDir: string;
	releaseDir: string;
	dbPath: string;
} {
	const root = makeScratchDir();
	const sharedDir = join(root, "shared");
	const releaseDir = join(root, "releases", "abc1234");
	mkdirSync(join(sharedDir, "data"), { recursive: true });
	mkdirSync(releaseDir, { recursive: true });

	// So the better-sqlite3 fallback is reachable on a host with no sqlite3 CLI,
	// exactly as it would be in a real release directory after `npm ci`.
	symlinkSync(
		join(REPO_ROOT, "node_modules"),
		join(releaseDir, "node_modules"),
	);
	symlinkSync(join(sharedDir, "data"), join(releaseDir, "data"));

	const dbPath = join(sharedDir, "data", "chat.db");
	if (options.withDatabase) {
		const database = new Database(dbPath);
		database.pragma("journal_mode = WAL");
		database.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)");
		const insert = database.prepare("INSERT INTO messages (body) VALUES (?)");
		for (let index = 0; index < 200; index += 1) {
			insert.run(`message ${index}`);
		}
		database.close();
	}

	return { root, sharedDir, releaseDir, dbPath };
}

function backupFiles(sharedDir: string): string[] {
	const dir = join(sharedDir, "backups");
	if (!existsSync(dir)) return [];
	return spawnSync("ls", ["-1", dir], { encoding: "utf8" })
		.stdout.split("\n")
		.filter((name) => name.endsWith(".db"));
}

describe("scripts/deploy-lib.sh backup_database (executed)", () => {
	afterEach(() => {
		while (scratchDirs.length > 0) {
			const dir = scratchDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes a verified, owner-only backup of the live database", () => {
		const { sharedDir, releaseDir } = makeFakeDeployTree({
			withDatabase: true,
		});

		const result = runDeployLib(
			`backup_database "${releaseDir}" "${sharedDir}" abc1234`,
		);

		expect(result.status).toBe(0);
		expect(result.output).toContain("Database backed up via");
		expect(result.output).toContain("Restore:");

		const backups = backupFiles(sharedDir);
		expect(backups).toHaveLength(1);
		expect(backups[0]).toMatch(/^chat-\d{8}T\d{6}Z-abc1234\.db$/);

		const backupPath = join(sharedDir, "backups", backups[0]);
		// 0o777 masks off the file-type bits; the backup is a full copy of every
		// conversation and every encrypted credential in the product.
		expect(statSync(backupPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(sharedDir, "backups")).mode & 0o777).toBe(0o700);

		// It is a real database with the real rows in it, not an empty file.
		const restored = new Database(backupPath, { readonly: true });
		const row = restored
			.prepare("SELECT COUNT(*) AS count FROM messages")
			.get() as { count: number };
		restored.close();
		expect(row.count).toBe(200);
	});

	it("skips quietly when there is no database yet (first install)", () => {
		const { sharedDir, releaseDir } = makeFakeDeployTree({
			withDatabase: false,
		});

		const result = runDeployLib(
			`backup_database "${releaseDir}" "${sharedDir}" abc1234`,
		);

		expect(result.status).toBe(0);
		expect(result.output).toContain("nothing to back up");
		expect(backupFiles(sharedDir)).toEqual([]);
	});

	it("honours an absolute DATABASE_PATH from the deployed .env", () => {
		const { sharedDir, releaseDir, root } = makeFakeDeployTree({
			withDatabase: false,
		});
		const elsewhere = join(root, "elsewhere.db");
		new Database(elsewhere).close();

		const result = runDeployLib(
			`backup_database "${releaseDir}" "${sharedDir}" abc1234`,
			{ DATABASE_PATH: elsewhere },
		);

		expect(result.status).toBe(0);
		expect(backupFiles(sharedDir)).toHaveLength(1);
	});

	it("aborts the deploy when the backup cannot be written", () => {
		const { sharedDir, releaseDir } = makeFakeDeployTree({
			withDatabase: true,
		});
		// A regular file where the backups directory needs to be: mkdir -p
		// fails, which is the same shape as a full disk or a directory owned by
		// somebody else.
		writeFileSync(join(sharedDir, "backups"), "not a directory");

		const result = runDeployLib(
			`backup_database "${releaseDir}" "${sharedDir}" abc1234`,
		);

		expect(result.status).toBe(1);
		expect(result.output).toContain("Database backup FAILED");
		expect(result.output).toContain("Refusing to run db:prepare");
	});

	it("downgrades the abort to a warning under DB_BACKUP_REQUIRED=0", () => {
		const { sharedDir, releaseDir } = makeFakeDeployTree({
			withDatabase: true,
		});
		writeFileSync(join(sharedDir, "backups"), "not a directory");

		const result = runDeployLib(
			`backup_database "${releaseDir}" "${sharedDir}" abc1234`,
			{ DB_BACKUP_REQUIRED: "0" },
		);

		expect(result.status).toBe(0);
		expect(result.output).toContain("no way back");
	});

	it("deletes a backup that does not verify rather than leaving it to be trusted", () => {
		const { sharedDir, releaseDir, dbPath } = makeFakeDeployTree({
			withDatabase: false,
		});
		// A file that exists and is non-empty but is not a database. Every
		// strategy either refuses it or copies the garbage through, and the
		// integrity check is what has to catch the latter.
		writeFileSync(dbPath, "this is definitely not a sqlite database");

		const result = runDeployLib(
			`backup_database "${releaseDir}" "${sharedDir}" abc1234`,
		);

		expect(result.status).toBe(1);
		expect(result.output).toContain("Database backup FAILED");
		expect(backupFiles(sharedDir)).toEqual([]);
	});
});

describe("scripts/deploy-lib.sh prune_old_db_backups", () => {
	afterEach(() => {
		while (scratchDirs.length > 0) {
			const dir = scratchDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	/** Ten backups, oldest first, with distinct mtimes so `ls -t` is stable. */
	function makeBackups(dir: string, count: number): string[] {
		mkdirSync(dir, { recursive: true });
		const paths: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const path = join(dir, `chat-2026090${index}T000000Z-abc123${index}.db`);
			writeFileSync(path, `backup ${index}`);
			const seconds = 1_700_000_000 + index * 60;
			utimesSync(path, seconds, seconds);
			paths.push(path);
		}
		return paths;
	}

	it("keeps the newest N and deletes the rest", () => {
		const dir = join(makeScratchDir(), "backups");
		const paths = makeBackups(dir, 10);

		const result = runDeployLib(`prune_old_db_backups "${dir}" 7 ""`);

		expect(result.status).toBe(0);
		// paths[0..2] are the three oldest.
		expect(paths.filter((path) => existsSync(path))).toEqual(paths.slice(3));
	});

	it("never deletes the backup this deploy just made", () => {
		const dir = join(makeScratchDir(), "backups");
		const paths = makeBackups(dir, 10);
		// Pretend the newest backup somehow sorted oldest — a restored file with
		// an old mtime, a clock jump, or two deploys inside the same second.
		const justMade = paths[0];

		const result = runDeployLib(
			`prune_old_db_backups "${dir}" 3 "${justMade}"`,
		);

		expect(result.status).toBe(0);
		expect(existsSync(justMade)).toBe(true);
		expect(paths.filter((path) => existsSync(path))).toEqual([
			justMade,
			...paths.slice(7),
		]);
	});

	it("does nothing when there are fewer backups than the retention count", () => {
		const dir = join(makeScratchDir(), "backups");
		const paths = makeBackups(dir, 3);

		const result = runDeployLib(`prune_old_db_backups "${dir}" 7 ""`);

		expect(result.status).toBe(0);
		expect(paths.every((path) => existsSync(path))).toBe(true);
	});

	it("is a no-op on a directory that does not exist yet", () => {
		const result = runDeployLib(
			`prune_old_db_backups "${join(makeScratchDir(), "nope")}" 7 ""`,
		);
		expect(result.status).toBe(0);
	});

	it("takes the sidecars with the backup it deletes", () => {
		const dir = join(makeScratchDir(), "backups");
		const paths = makeBackups(dir, 3);
		writeFileSync(`${paths[0]}-wal`, "wal");
		writeFileSync(`${paths[0]}-shm`, "shm");

		const result = runDeployLib(`prune_old_db_backups "${dir}" 2 ""`);

		expect(result.status).toBe(0);
		expect(existsSync(paths[0])).toBe(false);
		expect(existsSync(`${paths[0]}-wal`)).toBe(false);
		expect(existsSync(`${paths[0]}-shm`)).toBe(false);
	});
});

describe("scripts/deploy-dev.sh mirrors scripts/deploy.sh", () => {
	it("has the identical executable body aside from branch/service/port defaults", () => {
		expect(normalizeForMirrorComparison(deployDevScript)).toBe(
			normalizeForMirrorComparison(deployScript),
		);
	});

	it("defaults to the dev branch and the langflow-chat-dev.service unit on port 3002", () => {
		expect(deployDevScript).toMatch(/DEPLOY_BRANCH:-dev/);
		expect(deployDevScript).toMatch(/SERVICE_NAME:-langflow-chat-dev\.service/);
		expect(deployDevScript).toMatch(/HEALTH_PORT:-3002/);
	});

	it("defaults to the main branch and the langflow-chat.service unit on port 3001", () => {
		expect(deployScript).toMatch(/DEPLOY_BRANCH:-main/);
		expect(deployScript).toMatch(/SERVICE_NAME:-langflow-chat\.service/);
		expect(deployScript).toMatch(/HEALTH_PORT:-3001/);
	});
});
