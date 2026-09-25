/**
 * The type→body registry the panel's content area dispatches on (Slice 0
 * Task S5). A missing entry IS the File body: the panel already renders
 * produced files through its existing lazy preview stack, so "no loader"
 * means "keep doing that" — this is why the registry ships empty here and
 * every later slice adds exactly one line.
 *
 * Loader functions, never eager imports: a static import of a heavy editor
 * (Tiptap, Svelte Flow, …) would put it in every chat page's chunk, whether
 * or not that chat ever opens the type. `DocumentWorkspace.svelte` caches
 * each loader's promise the same way it already caches
 * `DocumentPreviewRenderer.svelte`'s, so a kind is imported at most once no
 * matter how many times its body is shown.
 */
import type { Component } from "svelte";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export interface ArtifactBodyProps {
	artifactId: string;
	kind: ArtifactKind;
	title: string;
	body: string | null;
	/** Fires when the body's own dirty state changes, so the panel can guard closing. */
	onDirtyChange?: (dirty: boolean) => void;
	/** The body hands its serialised form back for versions/refusal. Slice 1 first. */
	onBodyChange?: (body: string) => void;
}

export type ArtifactBodyLoader = () => Promise<{
	default: Component<ArtifactBodyProps>;
}>;

export const ARTIFACT_BODIES: Partial<
	Record<ArtifactKind, ArtifactBodyLoader>
> = {
	app: () => import("./app/AppBody.svelte"),
};
