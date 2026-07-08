import { execSync } from "node:child_process";
import { expect, it } from "vitest";

// Guard test: the Honcho dual-brain has been fully excised. No source file may
// reference it (case-insensitive) ever again.
//
// The search token is assembled from parts so this test file does not match
// itself, and the guard additionally excludes this file by path for clarity.
it("no honcho references remain in src/", () => {
	const token = ["hon", "cho"].join("");
	const out = execSync(
		`grep -ril ${token} src/ | grep -v 'no-${token}.test.ts' || true`,
		{ encoding: "utf8" },
	).trim();
	expect(out).toBe("");
});
