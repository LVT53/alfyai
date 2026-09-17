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
		expect(deployLibScript).toContain(
			'--python-version "$SANDBOX_PYTHON_VERSION"',
		);
		expect(deployLibScript).toContain("--implementation cp");
		expect(deployLibScript).toContain("--only-binary=:all:");
		expect(deployLibScript).toMatch(/--platform manylinux\S*_x86_64/);
		// The venv built with the host python is what broke production.
		expect(deployLibScript).not.toMatch(/-m venv/);
	});

	it("creates the mount source as the deploying user before Docker can", () => {
		expect(deployLibScript).toContain('mkdir -p "$target"');
		expect(deployLibScript).toContain('--user "$(id -u):$(id -g)"');
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
		const pruneBody = deployLibScript.slice(
			deployLibScript.indexOf("prune_old_releases()"),
		);
		expect(pruneBody).toContain("sudo rm -rf");
		expect(pruneBody).toContain("sudo chown -R");
		// A release we cannot delete is a disk-space problem, not a deploy
		// failure: the function returns 0 and records a warning instead.
		expect(pruneBody).not.toMatch(/\bexit 1\b/);
		expect(pruneBody).toContain("deploy_warn");
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
