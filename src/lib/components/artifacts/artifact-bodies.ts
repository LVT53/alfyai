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
import type { DocumentAlfyActivity } from "$lib/components/artifacts/document/alfy-activity";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export interface ArtifactBodyProps {
	artifactId: string;
	kind: ArtifactKind;
	title: string;
	body: string | null;
	/** The conversation the panel is showing; bodies pass it to `fetchArtifact` and any other artifact route so an incognito conversation's artifacts resolve, and it is null outside a conversation. */
	conversationId?: string | null;
	/**
	 * The latest Alfy tool-call activity (`create_artifact`/`edit_artifact`)
	 * the chat page knows about, derived from the stream's own tool-call
	 * parts — regardless of which artifact it targets. Only the Document body
	 * interprets it today (T8 live: the "Alfy is writing" shimmer, change
	 * marks and refusal notice); every other kind ignores it. `null`/absent
	 * when nothing is happening.
	 */
	alfyActivity?: DocumentAlfyActivity | null;
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
	document: () => import("./document/DocumentBody.svelte"),
	app: () => import("./app/AppBody.svelte"),
};
