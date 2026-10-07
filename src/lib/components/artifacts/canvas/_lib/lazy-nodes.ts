/**
 * The loaders of the blocks made from the chat. The editor's first paint does not
 * need a File, an App, a map, photos or live web on the board, and each of them brings
 * something heavy (the App's frame and its storage bridge, the chat's map card, the
 * chat's lightbox), so none is
 * imported statically: `LazyNode` asks for one here when a block of its kind is on
 * the board, and the bundler splits each into a chunk of its own that loads then.
 * A kind the editor already draws (a note) has no loader.
 *
 * What is loaded is the block's CONTENT, never its shell: `LazyNode` draws the
 * shell (the chrome, the anchors, the resize corners, the toolbar, the node's
 * accessible name) itself, from what is already in the editor. A loaded chunk
 * that imported the shell would pull the shell out of the editor's own chunk and
 * into a chunk the editor and the block share, which costs the editor's first
 * paint more than the block saves. So a block module has no import of
 * `NodeShell`, of the flow library, or of anything only the editor owns.
 */
import type { Component } from "svelte";
import type { CanvasChatContext } from "./chat-context";

/** What a block says about itself to the shell drawn around it. All optional: the shell falls back to the kind's own name. */
export interface LazyShell {
	/** A card's header title. */
	title?: string;
	/** The muted line at the header's right end. */
	meta?: string;
	/** What the block says, in a few words: the screen-reader name of the node. */
	summary?: string;
	/** Enter or F2 while the block itself has focus. */
	activate?: () => void;
	/** Opens what the block points at (a file, in the panel's viewer): a double-click anywhere on the block, Enter and an Open button in the toolbar do it. A click only picks the block, as it does for every block. */
	open?: () => void;
	/** The block has a form of its own (its title, a chart's and a diagram's source): the shell offers Edit, and Enter or F2 opens it when `activate` does not. The content is handed `editing` and `onclose`. */
	editable?: boolean;
}

/** What a block module gives `LazyNode`: its content, and how it dresses the shell. */
export interface LazyNodeModule {
	// biome-ignore lint/suspicious/noExplicitAny: each block's content has its own data prop
	default: Component<any>;
	shell?: (data: never, chat: CanvasChatContext) => LazyShell;
}

export type LazyNodeLoader = () => Promise<LazyNodeModule>;

// Each block module names its shell function after itself (`fileShell`, …): three
// modules exporting one name would be a duplicate export as far as the tooling that
// audits exports is concerned. The loader gives them the one shape `LazyNode` reads.
const LOADERS = {
	// A chart and a checklist are the board's own, but a board that has none never needs them.
	chart: () =>
		import("../nodes/ChartNode.svelte").then((module) => ({
			default: module.default,
			shell: module.chartShell,
		})),
	// A diagram is the chat's own Mermaid component, and Mermaid is the heaviest
	// thing the chat draws: a board with none never loads any of it.
	mermaid: () =>
		import("../nodes/MermaidNode.svelte").then((module) => ({
			default: module.default,
			shell: module.mermaidShell,
		})),
	checklist: () =>
		import("../nodes/ChecklistNode.svelte").then((module) => ({
			default: module.default,
			shell: module.checklistShell,
		})),
	file: () =>
		import("../nodes/FileNode.svelte").then((module) => ({
			default: module.default,
			shell: module.fileShell,
		})),
	app: () =>
		import("../nodes/AppNode.svelte").then((module) => ({
			default: module.default,
			shell: module.appShell,
		})),
	map: () =>
		import("../nodes/MapNode.svelte").then((module) => ({
			default: module.default,
			shell: module.mapShell,
		})),
	photo: () =>
		import("../nodes/PhotoNode.svelte").then((module) => ({
			default: module.default,
			shell: module.photoShell,
		})),
	liveweb: () =>
		import("../nodes/LiveWebNode.svelte").then((module) => ({
			default: module.default,
			shell: module.livewebShell,
		})),
} as const satisfies Record<string, LazyNodeLoader>;

/** The loader for a block kind, or null for a kind that is not loaded on demand. */
export function lazyNodeLoader(kind: string): LazyNodeLoader | null {
	return Object.hasOwn(LOADERS, kind)
		? LOADERS[kind as keyof typeof LOADERS]
		: null;
}
