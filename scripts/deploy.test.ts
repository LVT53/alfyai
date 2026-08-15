import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// These tests read scripts/deploy.sh and scripts/deploy-dev.sh as plain text
// and assert the ADR-0054 atomic-release properties. See
// docs/adr/0054-atomic-release-cutover.md for the design these encode.

const DEPLOY_SH_PATH = resolve(__dirname, "deploy.sh");
const DEPLOY_DEV_SH_PATH = resolve(__dirname, "deploy-dev.sh");

const deployScript = readFileSync(DEPLOY_SH_PATH, "utf8");
const deployDevScript = readFileSync(DEPLOY_DEV_SH_PATH, "utf8");

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
