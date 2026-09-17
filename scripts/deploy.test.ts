import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
