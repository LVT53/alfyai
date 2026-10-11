/**
 * The per-kind preview registry of History mode (ruling 76, versioning.md §5.4,
 * §10). History's shell (rail, toolbar, layouts, restore, naming) is the same for
 * every kind; what differs is how one stored version is shown read-only, with
 * its changes marked: a Document's words, a board, an App. A kind adds ONE entry
 * here and a component that takes `HistoryPreviewProps`: the Document's is
 * `DocumentVersionPreview.svelte`; the Canvas's is the lazy entry
 * `canvas/history-parts.ts`, reached through the editor module (it draws a board
 * with the editor's own board); the App's is `AppVersionPreview.svelte`.
 *
 * Loaders, never static imports: a preview carries what only History needs (a
 * Markdown renderer, a board, a sandbox frame), and must never enter the chat
 * page's first load or an editor's.
 */
import type { Component } from "svelte";
import type { MomentAuthor } from "$lib/shared/artifacts/history";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

/** Which comparison the preview's marks show: what the selected version did to its parent, or what Restore would change. */
export type HistoryCompare = "step" | "now";

/** What a preview tells the shell once it has loaded the versions it needs. */
export interface HistoryPreviewState {
	status: "loading" | "ready" | "error" | "large";
	/** How many separate changes the preview marked (the stepper's total); 0 when nothing is marked. */
	changeCount: number;
}

export interface HistoryPreviewProps {
	artifactId: string;
	/** The conversation the panel shows, so an incognito chat's item stays in scope. */
	conversationId: string | null;
	/** The version to show. */
	versionId: string;
	/** What its changes are measured against, or `null` when there is nothing to compare (a first version). */
	baseVersionId: string | null;
	compare: HistoryCompare;
	/** Who made the change: the marks of Alfy's changes wear its colour, the reader's the neutral ink. */
	author: MomentAuthor;
	/** The newest version, and its hash: a body fetched for "compared with now" is fetched again when the hash moved (a typing burst saves into one version). */
	nowVersionId: string;
	nowHash: string;
	/** The preview region's accessible name: the version in words. */
	label: string;
	/** Step to a change: the stepper moves `index` through `0..changeCount-1`; `nonce` makes the same index scroll and flash again. */
	changeCursor: { index: number; nonce: number };
	onState: (state: HistoryPreviewState) => void;
}

export type HistoryPreviewLoader = () => Promise<{
	default: Component<HistoryPreviewProps>;
}>;

export const HISTORY_PREVIEWS: Partial<
	Record<ArtifactKind, HistoryPreviewLoader>
> = {
	document: () => import("./DocumentVersionPreview.svelte"),
	app: () => import("../app/AppVersionPreview.svelte"),
	// Through the editor module, which imports the preview (see `loadHistoryPreview`).
	canvas: () =>
		import("../canvas/CanvasEditor.svelte").then((editor) =>
			editor.loadHistoryPreview(),
		),
};

/**
 * Whether a kind's panel has a History mode. Reads the registry's own keys, so a
 * kind is added in one place: the panel shell asks this (it holds only this
 * module, whose loaders are dynamic imports) to decide whether its header button
 * opens History or the kind's own sheet, without loading any preview.
 */
export function kindHasHistory(kind: ArtifactKind | null | undefined): boolean {
	return kind != null && Object.hasOwn(HISTORY_PREVIEWS, kind);
}
