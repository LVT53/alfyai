// Telling a request for one of the app's own modules apart from the rest, in
// both ways the e2e servers can run.
//
// `vite dev` serves a module at its source path (`/src/lib/…/placement.ts`), so a
// spec could once match the URL against the file's name. The production build
// serves the same code from a hashed chunk (`/_app/immutable/chunks/6GI4UJIe.js`),
// so a name that was in the URL is not there. The build's own manifest says which
// chunk is which: every module loaded with `import()` is an entry in it, keyed by
// its source path. A spec that asks "was the code for X requested yet?" therefore
// asks this module for X's pattern and gets one that fits the server it runs on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { e2eServerMode } from "./e2e-env";

const MANIFEST = join(
	".svelte-kit",
	"output",
	"client",
	".vite",
	"manifest.json",
);

type ManifestEntry = { file: string; isDynamicEntry?: boolean };

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A pattern for the URL the browser requests the module at `sourcePath` with
 * (relative to the repo root, e.g. `src/lib/components/artifacts/canvas/_lib/placement.ts`).
 * The module must be loaded with `import()` somewhere, so that the build gives it a
 * chunk of its own; a module that is bundled into another chunk has no URL of its own,
 * and asking for it is an error, not a pattern that silently matches nothing.
 */
export function moduleUrlPattern(
	sourcePath: string,
	root: string = process.cwd(),
): RegExp {
	if (e2eServerMode() === "dev") {
		return new RegExp(`/${escapeForRegExp(sourcePath)}(\\?|$)`);
	}
	const manifest = JSON.parse(
		readFileSync(join(root, MANIFEST), "utf8"),
	) as Record<string, ManifestEntry>;
	const entry = manifest[sourcePath];
	if (!entry?.isDynamicEntry) {
		throw new Error(
			`${sourcePath} is not loaded with import() in the build, so no request is made for it by itself (manifest: ${MANIFEST}); ask for a module that is`,
		);
	}
	return new RegExp(`/${escapeForRegExp(entry.file)}(\\?|$)`);
}
