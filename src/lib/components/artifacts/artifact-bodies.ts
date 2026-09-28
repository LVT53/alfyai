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
	/**
	 * Wave 2.5 Step 3: `ArtifactPanelHeader.svelte`'s version button and
	 * Download action open sheets that live INSIDE the body (Document's own
	 * `VersionsSheet`/`DownloadSheet`, opened today through the toolbar's
	 * "history"/"download" actions, now removed from the toolbar — redesign
	 * §5.2: "there is one History entry … and it sits where the version is").
	 * A body that owns such a sheet calls this once its trigger functions are
	 * ready (an `$effect`, not a one-time `onMount`, so a body whose
	 * `artifactId` changes under it — the panel's rail can swap which item is
	 * open without remounting the body — re-registers for the NEW item rather
	 * than leaving the panel holding a closure over the old one); a kind with
	 * no such sheet (App, File) simply never calls it, and the header falls
	 * back to its plain-text version / the panel's own generic download link.
	 */
	registerPanelActions?: (actions: ArtifactPanelBodyActions) => void;
	/**
	 * Wave 2.5 Step 8: the live count behind the header's Comments button
	 * badge (Document only, today) — a plain reactive report, not a
	 * `registerPanelActions` field, because it changes continuously as
	 * comments load/resolve rather than being a one-time trigger a body hands
	 * up once. Fires from an `$effect` whenever the count changes; a kind
	 * with no comments (App, File) simply never calls it, and the header
	 * never shows the button at all.
	 */
	onCommentCountChange?: (openCount: number) => void;
}

/** See `ArtifactBodyProps.registerPanelActions`. Every field is optional: a body opts in to only the actions it actually owns a sheet for. */
export interface ArtifactPanelBodyActions {
	openVersions?: () => void;
	openDownload?: () => void;
	/** Wave 2.5 Step 8: opens the phone sheet / narrow-panel drawer holding the same rail `MarginPanel.svelte` renders inline at full width — see `CommentsSheet.svelte`. */
	openComments?: () => void;
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
