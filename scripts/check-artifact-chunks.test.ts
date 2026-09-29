import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkArtifactChunks,
	chunkReader,
	findTargetKeys,
	formatReport,
	PACKAGE_FINGERPRINTS,
	staticClosure,
	// @ts-expect-error — plain .mjs build script, no type declarations
} from "./check-artifact-chunks.mjs";

// A build, reduced to what the guard reads: a manifest (which chunk imports
// which, statically or on demand) and the text of each chunk.
type Chunk = {
	file: string;
	name?: string;
	src?: string;
	isEntry?: boolean;
	isDynamicEntry?: boolean;
	imports?: string[];
	dynamicImports?: string[];
	css?: string[];
};

const FLOW = '…class="svelte-flow__pane"…'; // what Svelte Flow keeps through minification
const PEN = "…{simulatePressure:!0}…runningLength…";
const SNAP = "…throw new Error('Failed to clone iframe')…";

/** A tiny app: the entry, the chat and knowledge route nodes, the lazy Canvas editor and a shared helper. */
function app(
	overrides: {
		texts?: Record<string, string>;
		manifest?: Record<string, Chunk>;
	} = {},
) {
	const manifest: Record<string, Chunk> = {
		"entry/start": {
			file: "entry/start.js",
			isEntry: true,
			imports: ["_shared"],
		},
		"nodes/chat": {
			file: "nodes/chat.js",
			isDynamicEntry: true,
			imports: ["_shared"],
			dynamicImports: [
				"src/lib/components/artifacts/canvas/CanvasEditor.svelte",
			],
		},
		"nodes/knowledge": {
			file: "nodes/knowledge.js",
			isDynamicEntry: true,
			imports: ["_shared"],
		},
		"src/lib/components/artifacts/canvas/CanvasEditor.svelte": {
			file: "chunks/canvas-editor.js",
			name: "CanvasEditor",
			src: "src/lib/components/artifacts/canvas/CanvasEditor.svelte",
			isDynamicEntry: true,
			imports: ["_shared", "_board"],
		},
		_shared: { file: "chunks/shared.js" },
		_board: { file: "chunks/board.js" },
		...overrides.manifest,
	};
	const texts: Record<string, string> = {
		"entry/start.js": "start",
		"nodes/chat.js": "chat page",
		"nodes/knowledge.js": "knowledge page",
		"chunks/canvas-editor.js": `editor ${FLOW} ${PEN} ${SNAP}`,
		"chunks/shared.js": "shared helpers",
		"chunks/board.js": "board internals",
		...overrides.texts,
	};
	return {
		manifest,
		readChunk: (chunk: Chunk) =>
			[chunk.file, ...(chunk.css ?? [])].map((f) => texts[f] ?? "").join("\n"),
	};
}

const CONFINE = ["@xyflow", "perfect-freehand", "html-to-image"];

describe("findTargetKeys", () => {
	it("selects by name, by key and by source path", () => {
		const { manifest } = app();
		expect(findTargetKeys(manifest, "CanvasEditor")).toEqual([
			"src/lib/components/artifacts/canvas/CanvasEditor.svelte",
		]);
		expect(findTargetKeys(manifest, "artifacts/canvas/")).toHaveLength(1);
		expect(findTargetKeys(manifest, "NoSuchEditor")).toEqual([]);
	});

	it("selects every entry a name matches, so an editor split into two chunks is one target", () => {
		const { manifest } = app({
			manifest: {
				"src/lib/components/artifacts/canvas/CanvasEditorExtras.svelte": {
					file: "chunks/extras.js",
					name: "CanvasEditorExtras",
					isDynamicEntry: true,
				},
			},
		});
		expect(findTargetKeys(manifest, "CanvasEditor")).toHaveLength(2);
	});
});

describe("staticClosure", () => {
	it("follows static imports, not dynamic ones", () => {
		const { manifest } = app();
		expect([...staticClosure(manifest, ["nodes/chat"])].sort()).toEqual([
			"_shared",
			"nodes/chat",
		]);
	});

	it("terminates on an import cycle", () => {
		const cyclic: Record<string, Chunk> = {
			a: { file: "a.js", imports: ["b"] },
			b: { file: "b.js", imports: ["a"] },
		};
		expect([...staticClosure(cyclic, ["a"])].sort()).toEqual(["a", "b"]);
	});

	it("ignores an import the manifest does not list", () => {
		const closure = staticClosure({ a: { file: "a.js", imports: ["ghost"] } }, [
			"a",
		]);
		expect([...closure]).toEqual(["a"]);
	});
});

describe("checkArtifactChunks", () => {
	it("passes when every library is only in the lazy editor's chunk, and reports what it found", () => {
		const { manifest, readChunk } = app();
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: CONFINE,
		});
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.packages).toEqual([
			{ pkg: "@xyflow", chunks: ["chunks/canvas-editor.js"] },
			{ pkg: "perfect-freehand", chunks: ["chunks/canvas-editor.js"] },
			{ pkg: "html-to-image", chunks: ["chunks/canvas-editor.js"] },
		]);
		expect(result.targetFiles).toEqual(["chunks/canvas-editor.js"]);
	});

	it("accepts the library in a chunk only the editor loads (its own dependency chunk)", () => {
		const { manifest, readChunk } = app({
			texts: { "chunks/canvas-editor.js": "editor", "chunks/board.js": FLOW },
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(true);
		expect(result.packages[0].chunks).toEqual(["chunks/board.js"]);
	});

	it("FAILS when the library is in a chunk a route also loads: a leak into the chat shell", () => {
		// The bundler hoisted Svelte Flow into the helper both the editor and the chat page import.
		const { manifest, readChunk } = app({
			texts: { "chunks/canvas-editor.js": "editor", "chunks/shared.js": FLOW },
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]).toMatchObject({
			kind: "leak",
			pkg: "@xyflow",
			file: "chunks/shared.js",
		});
		// It names who loads it: the entry and both route nodes.
		expect(result.violations[0].roots.sort()).toEqual([
			"entry/start",
			"nodes/chat",
			"nodes/knowledge",
		]);
		expect(formatReport("CanvasEditor", result)).toContain("FAIL (leak)");
	});

	it("FAILS when the library is imported statically by the chat route itself", () => {
		const { manifest, readChunk } = app({
			manifest: {
				"nodes/chat": {
					file: "nodes/chat.js",
					isDynamicEntry: true,
					imports: ["_shared", "_board"],
				},
			},
			texts: { "chunks/canvas-editor.js": "editor", "chunks/board.js": FLOW },
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			kind: "leak",
			roots: ["nodes/chat"],
		});
	});

	it("FAILS when the library is in a chunk the editor does not even load", () => {
		const { manifest, readChunk } = app({
			manifest: {
				"src/lib/components/artifacts/slides/SlidesEditor.svelte": {
					file: "chunks/slides-editor.js",
					name: "SlidesEditor",
					isDynamicEntry: true,
				},
			},
			texts: {
				"chunks/canvas-editor.js": "editor",
				"chunks/slides-editor.js": FLOW,
			},
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			kind: "outside",
			file: "chunks/slides-editor.js",
		});
	});

	it("lets a named sibling lazy entry share the library when the caller says so", () => {
		const { manifest, readChunk } = app({
			manifest: {
				"src/lib/components/artifacts/slides/SlidesEditor.svelte": {
					file: "chunks/slides-editor.js",
					name: "SlidesEditor",
					isDynamicEntry: true,
					imports: ["_board"],
				},
			},
			texts: { "chunks/canvas-editor.js": "editor", "chunks/board.js": FLOW },
		});
		const strict = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(strict.ok).toBe(false);
		const shared = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			allowEntries: ["SlidesEditor"],
		});
		expect(shared.ok).toBe(true);
	});

	it("finds a library's stylesheet too: CSS that leaks into a shell chunk is a leak", () => {
		const { manifest, readChunk } = app({
			manifest: {
				"nodes/chat": {
					file: "nodes/chat.js",
					isDynamicEntry: true,
					imports: ["_shared"],
					css: ["assets/chat.css"],
				},
			},
			texts: {
				"chunks/canvas-editor.js": "editor",
				"assets/chat.css": ".svelte-flow__pane{cursor:grab}",
			},
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			kind: "outside",
			file: "nodes/chat.js",
		});
	});

	it("does not count a chunk that has only some of a package's fingerprints", () => {
		const { manifest, readChunk } = app({
			texts: {
				"chunks/canvas-editor.js": "editor",
				"nodes/chat.js":
					"something that mentions simulatePressure but nothing else",
			},
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["perfect-freehand"],
		});
		expect(result.ok).toBe(true);
		expect(result.packages[0].chunks).toEqual([]);
	});

	it("says a package is absent rather than guarded when no chunk has it, and still passes", () => {
		const { manifest, readChunk } = app({
			texts: { "chunks/canvas-editor.js": `editor ${FLOW}` },
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: CONFINE,
		});
		expect(result.ok).toBe(true);
		const report = formatReport("CanvasEditor", result);
		expect(report).toContain("perfect-freehand: not in this build");
		expect(report).toContain("html-to-image: not in this build");
		expect(report).toContain("@xyflow: chunks/canvas-editor.js");
	});

	it("FAILS loudly when no chunk matches the name, instead of vouching for nothing", () => {
		const { manifest, readChunk } = app();
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "SlidesEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			expect.objectContaining({ kind: "no-target" }),
		]);
	});

	it("is reusable for another editor: the same guard, its own name and its own libraries", () => {
		const { manifest, readChunk } = app({
			manifest: {
				"src/lib/components/artifacts/slides/SlidesEditor.svelte": {
					file: "chunks/slides-editor.js",
					name: "SlidesEditor",
					isDynamicEntry: true,
					imports: ["_shared"],
				},
			},
			texts: {
				"chunks/canvas-editor.js": "editor",
				"chunks/slides-editor.js": "slides pptx-viewer-internals",
			},
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "SlidesEditor",
			confine: ["pptx"],
			fingerprints: { pptx: ["pptx-viewer-internals"] },
		});
		expect(result.ok).toBe(true);
		expect(result.packages).toEqual([
			{ pkg: "pptx", chunks: ["chunks/slides-editor.js"] },
		]);
	});

	it("throws for a package it has no fingerprint for, rather than reporting it clean", () => {
		const { manifest, readChunk } = app();
		expect(() =>
			checkArtifactChunks({
				manifest,
				readChunk,
				name: "CanvasEditor",
				confine: ["left-pad"],
			}),
		).toThrow(/no fingerprint is known for "left-pad"/);
	});

	it("measures what the editor loads on its own, and enforces a budget on it", () => {
		const big = "x".repeat(40_000);
		const { manifest, readChunk } = app({
			texts: {
				"chunks/canvas-editor.js": `editor ${FLOW} ${big}`,
				"chunks/board.js": big,
			},
		});
		const open = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(open.ok).toBe(true);
		// Its own chunk and the board chunk only it loads; `_shared` is loaded by the shell too.
		expect(open.numbers.exclusiveChunks).toBe(2);
		expect(open.numbers.sharedChunks).toBe(1);
		expect(open.numbers.targetRawBytes).toBeGreaterThan(40_000);
		expect(open.numbers.exclusiveGzipBytes).toBeGreaterThan(0);

		const capped = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			maxGzip: 10,
		});
		expect(capped.ok).toBe(false);
		expect(capped.violations[0].kind).toBe("budget");
	});
});

describe("the fingerprints", () => {
	it("cover the three packages this slice installs, each with something a minifier keeps", () => {
		expect(Object.keys(PACKAGE_FINGERPRINTS).sort()).toEqual([
			"@xyflow",
			"html-to-image",
			"perfect-freehand",
		]);
		expect(PACKAGE_FINGERPRINTS["@xyflow"]).toContain("svelte-flow__pane");
	});
});

describe("chunkReader", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("reads a chunk's JS and its CSS, and treats a missing file as empty", () => {
		const root = mkdtempSync(join(tmpdir(), "artifact-chunks-"));
		dirs.push(root);
		mkdirSync(join(root, "chunks"), { recursive: true });
		writeFileSync(join(root, "chunks/a.js"), "js-part", "utf8");
		writeFileSync(join(root, "chunks/a.css"), "css-part", "utf8");
		const read = chunkReader(root);
		const text = read({
			file: "chunks/a.js",
			css: ["chunks/a.css", "chunks/missing.css"],
		});
		expect(text).toContain("js-part");
		expect(text).toContain("css-part");
	});
});
