import { execSync } from "node:child_process";
import { expect, it } from "vitest";

// Seam guard (C1 / ADR-0051): the inferred project-memory substrate has been
// retired. No source file may reference the dropped tables or column ever
// again. Folder-anchored continuity is the single continuity authority; the
// model-facing `memory_context` tool retains retrieval via the substrate-free
// folder path (see project.folder-retrieval.test.ts).
//
// Tokens are assembled from parts so this guard does not match itself, and the
// guard additionally excludes this file by path.
it("no inferred memoryProjects substrate references remain in src/", () => {
	const tokens = [
		["memory", "Projects"].join(""),
		["memory", "ProjectTaskLinks"].join(""),
		["canonical", "MemoryProjectId"].join(""),
	];
	const pattern = tokens.join("|");
	const out = execSync(
		`grep -rlE '${pattern}' src/ | grep -v 'no-memory-projects.test.ts' || true`,
		{ encoding: "utf8" },
	).trim();
	expect(out).toBe("");
});
