// The architecture guard (spec section 6.3).
//
// Modelled on `file-production/obsolete-surfaces.test.ts`: source-text
// assertions, no AST, no build step. It fails a file that collects four or
// more distinct file extensions or four or more distinct MIME literals,
// because that is what an ad-hoc file-type map looks like.
//
// TWO allowlists:
//
//  * PERMANENT — files that will never read the registry, each with the reason
//    the spec records. Adding a row needs a reason.
//
//  * TRANSITIONAL — the maps this phase is in the middle of deleting. Each row
//    carries a BUDGET (the counts measured on the slice-A commit) and the slice
//    that removes it. The budget is a ratchet: a slice that deletes a map makes
//    the file pass with room to spare and does NOT have to edit this file, but
//    nothing can ever add literals back. When a slice's file drops to zero the
//    row should be deleted outright — see the report/PR notes for slice B-E.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const srcDir = path.join(root, "src");

const REGISTRY_PREFIX = "src/lib/shared/file-types/";

const EXT_LITERAL =
	/(["'`])\.?(pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|tsv|markdown|md|txt|rtf|json|xml|html?|png|jpe?g|jfif|gif|webp|svg|heic|heif|avif|tiff?|bmp|zip|rar|7z|tar|gz|py|rb|rs|go|java|kts?|swift|cs|cpp|cxx|cc|hpp|php|yaml|yml|toml|sql|graphql|gql|ini|env|conf|log|sh|bash|zsh|mjs|cjs|jsx?|tsx?|css|scss|sass|less|mp3|mp4|mov|wav|webm)\1/g;
const MIME_LITERAL =
	/(["'`])(?:text|image|audio|video|application)\/[a-z0-9.+-]+\1/g;
const ACCEPT_LITERAL = /accept=["'{][^"'}]*\.[a-z0-9]{2,5}\s*,/;

const THRESHOLD = 4;

/** Files that will never read the registry. Every row states why. */
const PERMANENT_ALLOWLIST = new Map<string, string>([
	[
		"src/lib/server/services/campaign-assets.ts",
		'MIME_EXTENSIONS kept by spec decision row 46 (image/tiff -> "tiff" would rename stored asset paths); covered by the parity test in legacy-equivalence.test.ts',
	],
	[
		"src/lib/server/prompts.ts",
		"model-facing prose inside a cached prompt prefix; verified by format-prose.test.ts (spec row 42)",
	],
	[
		"src/lib/server/services/normal-chat-tools/index.ts",
		"EN/HU produce_file tool prose inside a cached prompt prefix; verified by format-prose.test.ts (spec row 43)",
	],
	[
		"src/lib/server/services/skills/user-skills.ts",
		"EN/HU built-in skill prose; verified by format-prose.test.ts (spec row 62)",
	],
	[
		"src/lib/server/favicon/fetch.ts",
		"favicon IMAGE_TYPES includes image/x-icon and image/vnd.microsoft.icon, which have no registry entry; adding .ico would widen the upload allowlist (spec row 57)",
	],
	[
		"src/lib/server/services/file-serving-response-policy.ts",
		"CSP/sandbox policy keyed on text/html + image/svg+xml; a security decision, not a type table (spec row 58)",
	],
	[
		"src/lib/server/services/working-document-selection.ts",
		"natural-language intent regexes over user messages, not file classification (spec row 61)",
	],
	[
		"src/lib/server/services/atlas/output-files.ts",
		"separate Atlas pipeline with its own PR queue (spec row 70)",
	],
	[
		"src/lib/components/chat/AtlasActivityBody.svelte",
		"Atlas export keys, the UI half of spec row 70",
	],
	[
		"src/routes/api/map-tiles/[z]/[x]/[y]/+server.ts",
		"fixed-format tile proxy, not user files (spec row 67)",
	],
	[
		"src/routes/api/admin/model-icons/upload/+server.ts",
		"admin-only single-extension inference (spec row 65)",
	],
	[
		"src/routes/api/chat/import/+server.ts",
		"ChatGPT-export import; folding it in would make .zip look uploadable (spec row 66)",
	],
	[
		"src/lib/components/chat/ImportChatGPTModal.svelte",
		"the UI half of spec row 66",
	],
	[
		"src/lib/components/ui/ProfilePictureEditor.svelte",
		'avatar picker accept string; folded into getAcceptAttribute("avatar") in a later phase (spec row 68 / open question 9)',
	],
	[
		"src/lib/server/sandbox/python-version.ts",
		"producer LIBRARY names (python-docx, openpyxl), not file types",
	],
	[
		"src/lib/services/markdown.ts",
		"highlighter language ids and aliases for fenced code blocks, not file classification",
	],
	[
		"src/lib/services/markdown-blocks.ts",
		"markdown fence kinds (mermaid/chart/csv/html), not file classification",
	],
]);

interface TransitionalBudget {
	readonly ext: number;
	readonly mime: number;
	readonly slice: string;
	readonly what: string;
}

/**
 * Measured on the slice-A commit. `ext`/`mime` are ceilings, never targets:
 * a slice that deletes its map simply comes in under budget.
 */
const TRANSITIONAL_ALLOWLIST = new Map<string, TransitionalBudget>([
	// `src/lib/utils/file-preview.ts` and
	// `src/lib/components/chat/attachment-file-type.ts` were slice B's largest
	// rows; both are now re-exports over the registry and carry no table, so
	// their rows are gone and the guard holds them to the 4/4 threshold.
	[
		"src/lib/components/document-workspace/preview-runtime/index.ts",
		{
			ext: 6,
			mime: 0,
			slice: "B",
			what: "the PreviewKind / TextPreviewKind discriminants themselves — the tables are gone (spec rows 39, 72)",
		},
	],
	[
		"src/lib/components/document-workspace/preview-runtime/office/index.ts",
		{
			ext: 4,
			mime: 2,
			slice: "B",
			what: "the four renderer branches; the union itself moved to ./kinds",
		},
	],
	[
		"src/lib/components/document-workspace/preview-runtime/office/kinds.ts",
		{
			ext: 4,
			mime: 0,
			slice: "B",
			what: "OfficePreviewKind union (spec row 38), in a leaf module so the renderers stay behind a dynamic import",
		},
	],
	[
		"src/lib/components/document-workspace/DocumentPreviewRenderer.svelte",
		{
			ext: 6,
			mime: 0,
			slice: "B",
			what: 'the preview-kind branches in the template plus lang="ts" — the office union is gone (spec row 40)',
		},
	],
	[
		"src/lib/components/document-workspace/DocumentWorkspace.svelte",
		{
			ext: 4,
			mime: 0,
			slice: "B",
			what: "preview-kind literals (spec row 12 importer)",
		},
	],
	[
		"src/lib/server/services/file-production/execution-adapter.ts",
		{
			ext: 4,
			mime: 0,
			slice: "D",
			// Re-measured on Phase 6 P6-B (the inline_text production mode), which
			// added a third source-mode arm to this file: still exactly 4 / 0. The
			// new arm names no extension and no MIME of its own — it derives the
			// produced MIME through getSandboxMimeTypeForExtension — so the budget
			// does not move. It cannot go lower while the render-kind branches
			// exist, because each one IS one of the four literals.
			what: "normalizeDocumentOutput is gone (spec row 34); what is left is the four render-kind branches in renderDocumentOutputs",
		},
	],
	[
		"src/lib/server/services/normal-chat-tools/produce-file.ts",
		{
			ext: 7,
			mime: 1,
			slice: "D",
			// Re-measured on Phase 6 P6-B: still exactly 7 / 1. P6-B routes text
			// outputs away from buildTextFileProgram but does not delete it —
			// program mode still uses it for a non-text output — and the
			// default-type ladder below it is untouched, so no literal was
			// removed. Lowering this row needs the ladder itself to go.
			what: "both maps are gone (spec rows 28-29); what is left is the default-type ladder in normalizeRequestedOutputs",
		},
	],
]);

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) {
			walk(full, out);
			continue;
		}
		if (!/\.(ts|svelte)$/.test(name)) continue;
		if (/\.test\.ts$/.test(name)) continue;
		out.push(full);
	}
	return out;
}

/**
 * Distinct TOKENS, not distinct literals: `"html"`, `'html'` and `` `html` ``
 * are one extension, and `".md"` is the same extension as `"md"`. Counting raw
 * matches would punish a file for its quote style.
 */
function distinctExtensions(source: string): string[] {
	return [
		...new Set(
			[...source.matchAll(EXT_LITERAL)].map((match) => match[2].toLowerCase()),
		),
	];
}

function distinctMimeTypes(source: string): string[] {
	return [
		...new Set(
			[...source.matchAll(MIME_LITERAL)].map((match) =>
				match[0].slice(1, -1).toLowerCase(),
			),
		),
	];
}

interface Scanned {
	readonly relative: string;
	readonly source: string;
	readonly extensions: string[];
	readonly mimeTypes: string[];
}

const SCANNED: Scanned[] = walk(srcDir)
	.map((file) => {
		const relative = path.relative(root, file).split(path.sep).join("/");
		const source = readFileSync(file, "utf8");
		return {
			relative,
			source,
			extensions: distinctExtensions(source),
			mimeTypes: distinctMimeTypes(source),
		};
	})
	.filter((entry) => !entry.relative.startsWith(REGISTRY_PREFIX));

describe("no ad-hoc file-type maps", () => {
	it("scanned a plausible number of files", () => {
		// A broken walk that finds nothing would make every assertion vacuous.
		expect(SCANNED.length).toBeGreaterThan(200);
	});

	it("collects extensions and MIME types only in the registry", () => {
		const offenders: string[] = [];

		for (const file of SCANNED) {
			const overExtensions = file.extensions.length >= THRESHOLD;
			const overMimeTypes = file.mimeTypes.length >= THRESHOLD;
			if (!overExtensions && !overMimeTypes) continue;

			if (PERMANENT_ALLOWLIST.has(file.relative)) continue;

			const budget = TRANSITIONAL_ALLOWLIST.get(file.relative);
			if (
				budget &&
				file.extensions.length <= budget.ext &&
				file.mimeTypes.length <= budget.mime
			) {
				continue;
			}

			const overBudget = budget
				? ` — over its slice-${budget.slice} budget of ${budget.ext} ext / ${budget.mime} mime`
				: "";
			offenders.push(
				`${file.relative}: ${file.extensions.length} extension literals ` +
					`[${file.extensions.slice(0, 12).join(", ")}], ` +
					`${file.mimeTypes.length} MIME literals ` +
					`[${file.mimeTypes.slice(0, 8).join(", ")}]${overBudget}`,
			);
		}

		expect(
			offenders,
			`Read the file type from $lib/shared/file-types instead of listing ` +
				`extensions or MIME types inline. If the file genuinely cannot, add ` +
				`it to PERMANENT_ALLOWLIST with a reason.\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("publishes no dotted accept list outside the registry", () => {
		const offenders = SCANNED.filter(
			(file) =>
				ACCEPT_LITERAL.test(file.source) &&
				!PERMANENT_ALLOWLIST.has(file.relative) &&
				!TRANSITIONAL_ALLOWLIST.has(file.relative),
		).map((file) => file.relative);

		expect(
			offenders,
			`Use getAcceptAttribute(surface) rather than a hand-written accept string.\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("keeps the production and model-facing entry points off client chunks", () => {
		// Spec section 7, bundle-size risk: a stray import would add ~180 alias
		// keys, or Hungarian prose, to every chunk that touches a file.
		const clientFiles = SCANNED.filter(
			(file) =>
				file.relative.startsWith("src/lib/components/") ||
				file.relative.startsWith("src/routes/(app)/"),
		);
		expect(clientFiles.length).toBeGreaterThan(50);

		const offenders = clientFiles
			.filter((file) =>
				/file-types\/(production|model-facing)/.test(file.source),
			)
			.map((file) => file.relative);
		expect(offenders).toEqual([]);
	});

	it("keeps every transitional row pointing at a real file", () => {
		// A renamed or deleted file must not leave a silent hole in the guard.
		const scannedPaths = new Set(SCANNED.map((file) => file.relative));
		for (const relative of TRANSITIONAL_ALLOWLIST.keys()) {
			expect(scannedPaths.has(relative), relative).toBe(true);
		}
	});

	it("gives every permanent allowlist row a reason", () => {
		for (const [relative, reason] of PERMANENT_ALLOWLIST) {
			expect(reason.length, relative).toBeGreaterThan(20);
		}
	});
});
