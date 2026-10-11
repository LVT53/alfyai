import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkArtifactChunks,
	checkChatRoute,
	chunkReader,
	findTargetKeys,
	formatChatReport,
	formatReport,
	PACKAGE_FINGERPRINTS,
	parseRouteNodes,
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
const SNAP = "…Error inlining remote css file…externalResourcesRequired…";

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
	it("cover the packages the editor guards, each with something a minifier keeps", () => {
		expect(Object.keys(PACKAGE_FINGERPRINTS).sort()).toEqual([
			"@tiptap/core",
			"@xyflow",
			"chart.js",
			"html-to-image",
			"maplibre-gl",
			"mermaid",
			"perfect-freehand",
			"prosemirror-model",
			"prosemirror-view",
		]);
		expect(PACKAGE_FINGERPRINTS["@xyflow"]).toContain("svelte-flow__pane");
		// Mermaid's core keeps its own error for a source it cannot place (a diagram block loads it on demand).
		expect(PACKAGE_FINGERPRINTS.mermaid).toContain("No diagram type detected");
		// The strings the installed html-to-image really keeps (1.11.11), not another version's.
		expect(PACKAGE_FINGERPRINTS["html-to-image"]).toContain(
			"Error inlining remote css file",
		);
	});
});

describe("lazy parts of the editor", () => {
	/** The editor, and a part of it (the export) that loads on demand and brings its own library. */
	function withPart() {
		return app({
			manifest: {
				"src/lib/components/artifacts/canvas/export-parts.ts": {
					file: "chunks/export-parts.js",
					name: "export-parts",
					src: "src/lib/components/artifacts/canvas/export-parts.ts",
					isDynamicEntry: true,
					imports: ["_shared", "_export"],
				},
				_export: { file: "chunks/export.js" },
				"src/lib/components/artifacts/canvas/CanvasEditor.svelte": {
					file: "chunks/canvas-editor.js",
					name: "CanvasEditor",
					src: "src/lib/components/artifacts/canvas/CanvasEditor.svelte",
					isDynamicEntry: true,
					imports: ["_shared", "_board"],
					dynamicImports: [
						"src/lib/components/artifacts/canvas/export-parts.ts",
					],
				},
			},
			texts: {
				"chunks/canvas-editor.js": `editor ${FLOW}`,
				"chunks/board.js": PEN,
				"chunks/export.js": SNAP,
			},
		});
	}

	it("keeps a library that lives only in a lazy part outside the editor unless the part is named", () => {
		const { manifest, readChunk } = withPart();
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["html-to-image"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0].kind).toBe("outside");
	});

	it("counts a named part as the editor's own: its library may live in its closure, and only there", () => {
		const { manifest, readChunk } = withPart();
		const named = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow", "perfect-freehand", "html-to-image"],
			allowEntries: ["export-parts"],
		});
		expect(named.ok).toBe(true);
		expect(
			named.packages.find((p: { pkg: string }) => p.pkg === "html-to-image")
				.chunks,
		).toEqual(["chunks/export.js"]);
		// The same library leaking into a chunk the chat shell loads is still a leak.
		const leaky = withPart();
		leaky.manifest["nodes/chat"].imports = ["_shared", "_export"];
		const result = checkArtifactChunks({
			manifest: leaky.manifest,
			readChunk: leaky.readChunk,
			name: "CanvasEditor",
			confine: ["html-to-image"],
			allowEntries: ["export-parts"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0].kind).toBe("leak");
	});

	it("does not count what only a named part loads in what the editor loads on its own", () => {
		const big = "y".repeat(30_000);
		const { manifest, readChunk } = withPart();
		const texts = {
			"chunks/export.js": `${SNAP} ${big}`,
		};
		const read = (chunk: Chunk) =>
			chunk.file === "chunks/export.js"
				? texts["chunks/export.js"]
				: readChunk(chunk);
		const result = checkArtifactChunks({
			manifest,
			readChunk: read,
			name: "CanvasEditor",
			confine: ["html-to-image"],
			allowEntries: ["export-parts"],
			maxGzip: 200,
		});
		expect(result.ok).toBe(true);
		expect(result.numbers.exclusiveRawBytes).toBeLessThan(1000);
	});
});

describe("the target chunk's own budget", () => {
	it("is held apart from the closure's: a chunk can be small because its modules moved to a chunk a lazy part shares", () => {
		const big = "q".repeat(60_000);
		const { manifest, readChunk } = app({ texts: { "chunks/board.js": big } });
		const closure = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		const own = closure.numbers.targetGzipBytes;
		expect(own).toBeLessThan(closure.numbers.exclusiveGzipBytes);

		const roomy = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			maxTargetGzip: own + 1,
			maxGzip: closure.numbers.exclusiveGzipBytes + 1,
		});
		expect(roomy.ok).toBe(true);
		// The chunk alone is under its cap, the closure is not: only the honest number fails.
		const tight = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			maxTargetGzip: own + 1,
			maxGzip: own + 1,
		});
		expect(tight.ok).toBe(false);
		expect(
			tight.violations.map((v: { message: string }) => v.message).join("|"),
		).toContain("loads on its own");
		const own2 = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			maxTargetGzip: own - 1,
		});
		expect(own2.ok).toBe(false);
		expect(own2.violations[0].message).toContain("chunk alone");
	});
});

describe("what the editor loads that is shared only with other lazy entries", () => {
	it("is counted apart from what the editor loads on its own, and named in the report", () => {
		const big = "z".repeat(20_000);
		const { manifest, readChunk } = app({
			manifest: {
				// Another editor the chat loads on demand, which shares a helper with this one.
				"src/lib/components/artifacts/document/DocumentBody.svelte": {
					file: "chunks/document-body.js",
					isDynamicEntry: true,
					imports: ["_versions"],
				},
				_versions: { file: "chunks/versions.js" },
				"src/lib/components/artifacts/canvas/CanvasEditor.svelte": {
					file: "chunks/canvas-editor.js",
					name: "CanvasEditor",
					src: "src/lib/components/artifacts/canvas/CanvasEditor.svelte",
					isDynamicEntry: true,
					imports: ["_shared", "_board", "_versions"],
				},
			},
			texts: {
				"chunks/versions.js": big,
				"chunks/canvas-editor.js": `editor ${FLOW}`,
			},
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.ok).toBe(true);
		// Not the editor's own (another entry loads it) and not the shell's: shared with a lazy entry only.
		expect(result.numbers.lazySharedChunks).toBe(1);
		expect(result.numbers.lazySharedGzipBytes).toBeGreaterThan(0);
		expect(result.numbers.exclusiveChunks).toBe(2);
		expect(formatReport("CanvasEditor", result)).toContain(
			"shared only with other lazy entries",
		);
	});

	it("does not count a chunk the chat shell loads too", () => {
		const { manifest, readChunk } = app();
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
		});
		expect(result.numbers.lazySharedChunks).toBe(0);
	});
});

describe("packages the editor must not load", () => {
	const CHART = "…$chartjs…_adapters…";

	it("FAILS when a forbidden package is in a chunk the editor loads when it opens", () => {
		const { manifest, readChunk } = app({
			texts: { "chunks/board.js": CHART },
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			forbid: ["chart.js"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			kind: "forbidden",
			pkg: "chart.js",
		});
	});

	it("passes when it is only in a chunk loaded on demand, which is how the chat already loads it", () => {
		const { manifest, readChunk } = app({
			manifest: {
				"src/lib/components/chat/Chart.svelte": {
					file: "chunks/chart.js",
					isDynamicEntry: true,
				},
				"src/lib/components/artifacts/canvas/CanvasEditor.svelte": {
					file: "chunks/canvas-editor.js",
					name: "CanvasEditor",
					src: "src/lib/components/artifacts/canvas/CanvasEditor.svelte",
					isDynamicEntry: true,
					imports: ["_shared", "_board"],
					dynamicImports: ["src/lib/components/chat/Chart.svelte"],
				},
			},
			texts: { "chunks/chart.js": CHART },
		});
		const result = checkArtifactChunks({
			manifest,
			readChunk,
			name: "CanvasEditor",
			confine: ["@xyflow"],
			forbid: ["chart.js", "maplibre-gl"],
		});
		expect(result.ok).toBe(true);
	});

	it("throws for a package it has no fingerprint for, rather than vouching for it", () => {
		const { manifest, readChunk } = app();
		expect(() =>
			checkArtifactChunks({
				manifest,
				readChunk,
				name: "CanvasEditor",
				confine: ["@xyflow"],
				forbid: ["left-pad"],
			}),
		).toThrow(/left-pad/);
	});
});

describe("the chat route's first paint", () => {
	const APP = `export const dictionary = {
		"/(app)": [3,[2]],
		"/(app)/chat": [~4,[2]],
		"/(app)/chat/[conversationId]": [5,[2]],
		"/login": [9]
	};`;

	it("finds a route's page, its layouts and the root layout in the generated route table", () => {
		expect(parseRouteNodes(APP, "/(app)/chat/[conversationId]")).toEqual([
			0, 2, 5,
		]);
		expect(parseRouteNodes(APP, "/(app)/chat")).toEqual([0, 2, 4]);
		expect(parseRouteNodes(APP, "/login")).toEqual([0, 9]);
		expect(parseRouteNodes(APP, "/nowhere")).toBeNull();
	});

	/**
	 * A build with three route nodes, the chunks they import statically, and the
	 * heavy libraries and the lazy editor the chat page reaches only by import().
	 */
	function build(
		overrides: {
			texts?: Record<string, string>;
			manifest?: Record<string, Chunk>;
		} = {},
	) {
		const manifest: Record<string, Chunk> = {
			".svelte-kit/generated/client-optimized/nodes/0.js": {
				file: "nodes/0.js",
				isEntry: true,
				imports: ["_shared"],
			},
			".svelte-kit/generated/client-optimized/nodes/2.js": {
				file: "nodes/2.js",
				isEntry: true,
				imports: ["_shared"],
			},
			".svelte-kit/generated/client-optimized/nodes/5.js": {
				file: "nodes/5.js",
				isEntry: true,
				imports: ["_shared", "_chat"],
				dynamicImports: [
					"src/lib/components/artifacts/canvas/CanvasEditor.svelte",
					"chart",
					"map",
					"diagram",
					"document",
				],
			},
			"src/lib/components/artifacts/canvas/CanvasEditor.svelte": {
				file: "chunks/editor.js",
				name: "CanvasEditor",
				src: "src/lib/components/artifacts/canvas/CanvasEditor.svelte",
				isDynamicEntry: true,
				imports: ["_shared"],
			},
			chart: { file: "chunks/chart.js", isDynamicEntry: true },
			map: { file: "chunks/map.js", isDynamicEntry: true },
			diagram: { file: "chunks/diagram.js", isDynamicEntry: true },
			document: { file: "chunks/document.js", isDynamicEntry: true },
			_shared: { file: "chunks/shared.js" },
			_chat: { file: "chunks/chat.js" },
			...overrides.manifest,
		};
		const texts: Record<string, string> = {
			"nodes/0.js": "root ".repeat(500),
			"nodes/2.js": "layout ".repeat(500),
			"nodes/5.js": "page ".repeat(500),
			"chunks/shared.js": "shared ".repeat(2000),
			"chunks/chat.js": "chat ".repeat(500),
			"chunks/editor.js": `editor ${FLOW} `.repeat(2000),
			// The libraries the chat loads on demand: each in a chunk of its own.
			"chunks/chart.js": "…$chartjs…_adapters…",
			"chunks/map.js": "…maplibregl-canvas…maplibregl-map…",
			"chunks/diagram.js": "…No diagram type detected…UnknownDiagramError…",
			"chunks/document.js":
				"…ProseMirror-hideselection…ProseMirror-selectednode… Invalid content for node …Unknown node type…[tiptap error]…",
			...overrides.texts,
		};
		return { manifest, readChunk: (chunk: Chunk) => texts[chunk.file] ?? "" };
	}
	const nodes = [0, 2, 5];
	const HEAVY = [
		"chart.js",
		"maplibre-gl",
		"mermaid",
		"@xyflow",
		"prosemirror-view",
		"prosemirror-model",
		"@tiptap/core",
	];

	it("passes when every heavy library is in a chunk loaded on demand, and reports the size as information", () => {
		const { manifest, readChunk } = build();
		const result = checkChatRoute({
			manifest,
			readChunk,
			nodes,
			forbid: HEAVY,
			editorName: "CanvasEditor",
		});
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
		// The route's own first load: its three nodes, the shared chunk and its own.
		expect(result.chunks).toBe(5);
		expect(result.gzipBytes).toBeGreaterThan(0);
		// No budget: nothing in the result names a baseline or a tolerance.
		expect(result).not.toHaveProperty("baseline");
		// What is on demand is counted nowhere in it, however big.
		expect(result.gzipBytes).toBeLessThan(2_000);
		// Each library is found in the build (so a green line is not a blind one) and not with the route.
		for (const pkg of HEAVY.filter((name) => name !== "@xyflow")) {
			const found = result.packages.find(
				(entry: { pkg: string }) => entry.pkg === pkg,
			);
			expect(found.chunks.length, pkg).toBeGreaterThan(0);
			expect(found.loadedWithRoute, pkg).toEqual([]);
		}
	});

	it("does not hold the size: a heavier chat route still passes while nothing heavy is in it", () => {
		const { manifest, readChunk } = build({
			texts: {
				"chunks/chat.js": "a different, much longer chat chunk ".repeat(
					200_000,
				),
			},
		});
		const result = checkChatRoute({
			manifest,
			readChunk,
			nodes,
			forbid: HEAVY,
			editorName: "CanvasEditor",
		});
		expect(result.ok).toBe(true);
		expect(result.gzipBytes).toBeGreaterThan(0);
	});

	// One heavy library per row: the fingerprint each is found by in a built chunk.
	const FOUND_BY: Record<string, string> = {
		"chart.js": "…$chartjs…_adapters…",
		"maplibre-gl": "…maplibregl-canvas…maplibregl-map…",
		mermaid: "…No diagram type detected…UnknownDiagramError…",
		"@xyflow": FLOW,
		"prosemirror-view": "…ProseMirror-hideselection…ProseMirror-selectednode…",
		"prosemirror-model": "…Invalid content for node …Unknown node type…",
		"@tiptap/core": "…[tiptap error]: Invalid JSON content…",
	};

	for (const pkg of HEAVY) {
		it(`FAILS when ${pkg} is in a chunk the route's own page imports statically`, () => {
			const { manifest, readChunk } = build({
				texts: { "chunks/chat.js": FOUND_BY[pkg] },
			});
			const result = checkChatRoute({
				manifest,
				readChunk,
				nodes,
				forbid: [pkg],
			});
			expect(result.ok).toBe(false);
			expect(result.violations).toHaveLength(1);
			expect(result.violations[0]).toMatchObject({
				kind: "forbidden",
				pkg,
				file: "chunks/chat.js",
			});
			expect(result.violations[0].message).toContain(pkg);
			expect(result.violations[0].message).toContain("chunks/chat.js");
		});
	}

	it("FAILS when the library is in a chunk the route's layouts share, not only its page", () => {
		const { manifest, readChunk } = build({
			texts: { "chunks/shared.js": `shared ${FOUND_BY["chart.js"]}` },
		});
		const result = checkChatRoute({
			manifest,
			readChunk,
			nodes,
			forbid: ["chart.js"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			kind: "forbidden",
			file: "chunks/shared.js",
		});
	});

	it("FAILS when the page imports the library's chunk statically instead of with import()", () => {
		// The chat's real mistake: `import Chart from "chart.js/auto"` in a component.
		const { manifest, readChunk } = build({
			manifest: {
				".svelte-kit/generated/client-optimized/nodes/5.js": {
					file: "nodes/5.js",
					isEntry: true,
					imports: ["_shared", "_chat", "chart"],
				},
			},
		});
		const result = checkChatRoute({
			manifest,
			readChunk,
			nodes,
			forbid: ["chart.js", "mermaid"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations.map((v: { pkg: string }) => v.pkg)).toEqual([
			"chart.js",
		]);
	});

	it("does not take a chunk that has only some of a package's fingerprints for the package", () => {
		const { manifest, readChunk } = build({
			texts: { "chunks/chat.js": "…$chartjs… but not the other mark…" },
		});
		expect(
			checkChatRoute({ manifest, readChunk, nodes, forbid: ["chart.js"] }).ok,
		).toBe(true);
	});

	it("FAILS when the Canvas editor's own entry is imported statically by the route", () => {
		const { manifest, readChunk } = build({
			manifest: {
				".svelte-kit/generated/client-optimized/nodes/5.js": {
					file: "nodes/5.js",
					isEntry: true,
					imports: [
						"_shared",
						"_chat",
						"src/lib/components/artifacts/canvas/CanvasEditor.svelte",
					],
				},
			},
		});
		const result = checkChatRoute({
			manifest,
			readChunk,
			nodes,
			forbid: [],
			editorName: "CanvasEditor",
		});
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			kind: "editor",
			file: "chunks/editor.js",
		});
	});

	it("passes when the editor's entry is only reached by import(), which is how the panel loads it", () => {
		const { manifest, readChunk } = build();
		expect(
			checkChatRoute({
				manifest,
				readChunk,
				nodes,
				forbid: [],
				editorName: "CanvasEditor",
			}).ok,
		).toBe(true);
	});

	it("throws for a package it has no fingerprint for, rather than vouching for it", () => {
		const { manifest, readChunk } = build();
		expect(() =>
			checkChatRoute({ manifest, readChunk, nodes, forbid: ["left-pad"] }),
		).toThrow(/left-pad/);
	});

	it("says so, and fails, when a route node is not in the build", () => {
		const { manifest, readChunk } = build();
		const result = checkChatRoute({
			manifest,
			readChunk,
			nodes: [0, 2, 99],
			forbid: HEAVY,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("99");
	});
});

describe("the chat route's report", () => {
	it("names the size as information and each guarded library where it lives", () => {
		const lines = formatChatReport("/(app)/chat/[conversationId]", {
			ok: true,
			chunks: 79,
			gzipBytes: 543_859,
			violations: [],
			packages: [
				{
					pkg: "chart.js",
					chunks: ["_app/immutable/chunks/chart.js"],
					loadedWithRoute: [],
				},
				{ pkg: "mermaid", chunks: [], loadedWithRoute: [] },
			],
			message: "79 chunk(s), 543859 bytes gzip (information only, no budget)",
		});
		expect(lines).toContain("chat route /(app)/chat/[conversationId]");
		expect(lines).toContain("79 chunk(s), 543859 bytes gzip");
		expect(lines).toMatch(/information only|no budget/);
		expect(lines).toContain("chart.js: _app/immutable/chunks/chart.js");
		expect(lines).toMatch(/mermaid: not in this build/);
		expect(lines).not.toContain("FAIL");
	});

	it("prints a FAIL line for each library the route loads statically", () => {
		const lines = formatChatReport("/(app)/chat/[conversationId]", {
			ok: false,
			chunks: 5,
			gzipBytes: 1_000,
			violations: [
				{
					kind: "forbidden",
					pkg: "chart.js",
					file: "chunks/chat.js",
					message:
						"chart.js is in chunks/chat.js, which the chat route loads statically",
				},
			],
			packages: [
				{
					pkg: "chart.js",
					chunks: ["chunks/chat.js"],
					loadedWithRoute: ["chunks/chat.js"],
				},
			],
			message: "",
		});
		expect(lines).toContain("FAIL (chat-route)");
		expect(lines).toContain("chart.js is in chunks/chat.js");
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
