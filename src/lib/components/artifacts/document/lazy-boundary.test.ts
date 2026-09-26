import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * T7.8's chunk boundary, by source scan (`slice-1.md` Task T7, Step 1.8):
 * the repo has no build-manifest assertion to read, so this checks the
 * import lines of every file that must stay free of `@tiptap/*` directly —
 * `document-editor.ts` (and what it imports) is the ONLY module in this
 * feature allowed to import Tiptap/ProseMirror, reached exclusively through
 * `DocumentBody.svelte`'s `await import(...)`, so a chat page that never
 * opens a Document never pays for it (the prototype's own figure: ~147 kB
 * gzip).
 *
 * Only `import`/`export … from` LINES are checked, not the whole file text:
 * a doc comment explaining why `@tiptap` is deliberately absent (as this
 * very file's own header does, and `document-editor.ts`'s does too) must
 * not trip the guard it is describing.
 */
const IMPORT_LINE_RE = /^\s*(import|export)\b.*$/gm;

const CLEAN_FILES = [
	"src/lib/components/artifacts/document/DocumentBody.svelte",
	"src/lib/components/artifacts/document/DocumentToolbar.svelte",
	"src/lib/components/artifacts/document/MobileToolbar.svelte",
	"src/lib/components/artifacts/document/toolbar-actions.ts",
	"src/lib/components/artifacts/document/document-autosave.ts",
	"src/lib/components/artifacts/document/ChangeBar.svelte",
	"src/lib/components/artifacts/document/AlfyWriting.svelte",
	"src/lib/components/artifacts/document/Tabs.svelte",
	"src/lib/components/artifacts/document/chips.ts",
	"src/lib/components/artifacts/document/card-view.ts",
	"src/lib/components/artifacts/document/block-attrs.ts",
	"src/lib/components/artifacts/ArtifactCard.svelte",
	"src/lib/components/artifacts/RefusalNotice.svelte",
	"src/lib/components/artifacts/artifact-bodies.ts",
];

describe("Document editor lazy boundary", () => {
	it.each(CLEAN_FILES)("%s imports nothing from @tiptap", (file) => {
		const source = readFileSync(file, "utf8");
		const importLines = source.match(IMPORT_LINE_RE) ?? [];
		for (const line of importLines) {
			expect(
				line,
				`${file} has a non-lazy Tiptap import: ${line}`,
			).not.toContain("@tiptap");
		}
	});

	// T8 added `marks.ts` (the AlfyChange mark + its Keep/Undo mechanics)
	// reachable only from `extensions.ts`'s registration — never imported by
	// `DocumentBody.svelte`, the toolbars, `Tabs.svelte` or the chips module
	// directly (Review Focus 5: a static import anywhere in that set would
	// pull `@tiptap/core` into the panel shell's own chunk).
	it("document-editor.ts, extensions.ts and marks.ts are the only files under document/ that import @tiptap", () => {
		const editorSource = readFileSync(
			"src/lib/components/artifacts/document/document-editor.ts",
			"utf8",
		);
		const extensionsSource = readFileSync(
			"src/lib/components/artifacts/document/extensions.ts",
			"utf8",
		);
		const marksSource = readFileSync(
			"src/lib/components/artifacts/document/marks.ts",
			"utf8",
		);
		expect(editorSource).toContain("@tiptap");
		expect(extensionsSource).toContain("@tiptap");
		expect(marksSource).toContain("@tiptap");
	});

	it("DocumentBody.svelte reaches the editor only through a dynamic import", () => {
		const source = readFileSync(
			"src/lib/components/artifacts/document/DocumentBody.svelte",
			"utf8",
		);
		expect(source).toContain('import("./document-editor")');
		// No static `from "./document-editor"` value import — only `import type`.
		const staticValueImport =
			/import\s+(?!type\s)[^;]*from\s+["']\.\/document-editor["']/;
		expect(staticValueImport.test(source)).toBe(false);
	});
});
