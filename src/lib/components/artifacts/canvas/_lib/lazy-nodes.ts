/**
 * The loaders of the blocks made from the chat. The editor's first paint does not
 * need a File, an App or a map on the board, and each of them brings something
 * heavy (the App's frame and its storage bridge, the chat's map card), so none is
 * imported statically: `LazyNode` asks for one here when a block of its kind is on
 * the board, and the bundler splits each into a chunk of its own that loads then.
 * A kind the editor already draws (a note, a chart, a checklist) has no loader.
 */
import type { NodeTypes } from "@xyflow/svelte";

export type LazyNodeLoader = () => Promise<{ default: NodeTypes[string] }>;

const LOADERS = {
	file: () => import("../nodes/FileNode.svelte"),
	app: () => import("../nodes/AppNode.svelte"),
	map: () => import("../nodes/MapNode.svelte"),
} as const satisfies Record<string, LazyNodeLoader>;

/** The loader for a block kind, or null for a kind that is not loaded on demand. */
export function lazyNodeLoader(kind: string): LazyNodeLoader | null {
	return Object.hasOwn(LOADERS, kind)
		? LOADERS[kind as keyof typeof LOADERS]
		: null;
}
