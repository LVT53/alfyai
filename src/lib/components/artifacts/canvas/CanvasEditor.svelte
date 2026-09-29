<script lang="ts">
/**
 * The Canvas's panel body (Feature 2 · Artifacts, Slice 3): what the artifact
 * panel mounts for a board. It loads the stored board, draws it with
 * `CanvasBoard`, and saves what the reader does; the shell around it (eyebrow,
 * title, version pill, actions) is the panel's own.
 *
 * Persistence is the Document's, deliberately: one debounced autosave loop
 * (`createDocumentAutosave`, which saves any string), one write route
 * (`saveArtifactBody`, with the version and body hash it last saw, so a second
 * writer is refused with a 409 rather than overwritten), one Versions sheet. The
 * board hands over whole steps only; a bare pan never reaches it, so looking
 * around a board never mints a version.
 *
 * Every version the server reports is announced by the client API module, and the
 * header reads it from there. Nothing here prints a version or an "edited" time.
 */
import { SvelteFlowProvider } from "@xyflow/svelte";
import { onDestroy, untrack } from "svelte";
import { fetchArtifact, saveArtifactBody } from "$lib/client/api/artifacts";
import { ApiError } from "$lib/client/api/http";
import type { ArtifactPanelBodyActions } from "$lib/components/artifacts/artifact-bodies";
import {
	createDocumentAutosave,
	type DocumentAutosaveResult,
} from "$lib/components/artifacts/document/document-autosave";
import VersionsSheet from "$lib/components/artifacts/document/VersionsSheet.svelte";
import { t } from "$lib/i18n";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import {
	boardJson,
	emptyCanvasBody,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import CanvasBoard from "./CanvasBoard.svelte";

interface Props {
	artifactId: string;
	kind?: string;
	title?: string;
	body?: string | null;
	/** The conversation the PANEL is showing (ruling 51): passed to every artifact route this body calls, so an incognito conversation's own board resolves. */
	conversationId?: string | null;
	/** Hands the panel header its Versions trigger. Download joins it with the PNG export. */
	registerPanelActions?: (actions: ArtifactPanelBodyActions) => void;
	onDirtyChange?: (dirty: boolean) => void;
	onBodyChange?: (body: string) => void;
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
}

let {
	artifactId,
	conversationId = null,
	registerPanelActions,
	onDirtyChange,
	onBodyChange,
	currentUser = null,
}: Props = $props();

type Phase = "loading" | "ready" | "load_error" | "no_access";
type SaveState =
	| "idle"
	| "saving"
	| "saved"
	| "offline"
	| "failed"
	| "conflict"
	| "deleted"
	| "tooLarge";

/** How long "Saved" stays up after a save lands. */
const SAVED_MS = 2500;

let phase = $state<Phase>("loading");
let saveState = $state<SaveState>("idle");
let boardBody = $state.raw<CanvasBody>(emptyCanvasBody());
/** Bumped to draw a different board (a load, a reload, a restore): the board is mounted afresh, never re-seeded. */
let boardKey = $state(0);
let droppedCount = $state(0);
let noticeDismissed = $state(false);
let versionsOpen = $state(false);

let versionNumber: number | null = null;
let knownBodyHash: string | null = null;
let latestJson = "";
let loadToken = 0;
let savedTimer: ReturnType<typeof setTimeout> | null = null;
let boardApi = $state<{ flush: () => CanvasBody } | null>(null);
let lastDropped = 0;

const autosave = createDocumentAutosave({
	save: async (json) => {
		const result = await saveArtifactBody(
			artifactId,
			json,
			versionNumber ?? undefined,
			conversationId,
			undefined,
			{ baseHash: knownBodyHash ?? undefined },
		);
		lastDropped = result.ok
			? (result.dropped?.nodes ?? 0) +
				(result.dropped?.edges ?? 0) +
				(result.dropped?.annotations ?? 0)
			: 0;
		return result;
	},
	onResult: handleSaveResult,
});

function clearSavedTimer(): void {
	if (savedTimer) clearTimeout(savedTimer);
	savedTimer = null;
}

function handleSaveResult(result: DocumentAutosaveResult, json: string): void {
	if (result.ok) {
		if (typeof result.version === "number") versionNumber = result.version;
		if (typeof result.bodyHash === "string") knownBodyHash = result.bodyHash;
		const dirty = json !== latestJson;
		onDirtyChange?.(dirty);
		onBodyChange?.(json);
		if (lastDropped > 0) {
			droppedCount = lastDropped;
			noticeDismissed = false;
		}
		if (dirty) {
			saveState = "saving";
			return;
		}
		saveState = "saved";
		clearSavedTimer();
		savedTimer = setTimeout(() => {
			if (saveState === "saved") saveState = "idle";
		}, SAVED_MS);
		return;
	}
	clearSavedTimer();
	switch (result.reason) {
		case "not_found":
			saveState = "deleted";
			autosave.stop();
			break;
		case "too_large":
			saveState = "tooLarge";
			break;
		case "version_conflict":
		case "stale":
			// The reader's own steps stay on screen until they choose to reload.
			saveState = "conflict";
			autosave.stop();
			break;
		case "offline":
			saveState = "offline";
			break;
		default:
			saveState = "failed";
	}
}

function handleBoardChange(next: CanvasBody): void {
	if (autosave.stopped) return;
	latestJson = boardJson(next);
	saveState = "saving";
	onDirtyChange?.(true);
	autosave.schedule(latestJson);
}

/** Puts a save that could not reach the server (or was refused as broken) back in the queue. */
function retrySave(): void {
	if (autosave.stopped || latestJson === "") return;
	if (saveState !== "offline" && saveState !== "failed") return;
	saveState = "saving";
	autosave.schedule(latestJson);
}

async function load(id: string): Promise<void> {
	const token = ++loadToken;
	clearSavedTimer();
	phase = "loading";
	try {
		const detail = await fetchArtifact(id, conversationId);
		if (token !== loadToken) return;
		const stored = detail.artifact.body;
		const parsed: unknown = stored?.trim() ? JSON.parse(stored) : {};
		const read = normalizeCanvasBody(parsed);
		boardBody = read.body;
		droppedCount =
			read.dropped.nodes.length +
			read.dropped.edges.length +
			read.dropped.annotations.length;
		noticeDismissed = false;
		versionNumber = detail.artifact.versionNumber;
		knownBodyHash = detail.artifact.bodyHash;
		latestJson = boardJson(read.body);
		saveState = "idle";
		autosave.resume();
		onDirtyChange?.(false);
		boardKey += 1;
		phase = "ready";
	} catch (error) {
		if (token !== loadToken) return;
		phase =
			error instanceof ApiError && error.status === 404
				? "no_access"
				: "load_error";
	}
}

$effect(() => {
	const id = artifactId;
	untrack(() => void load(id));
});

// The header's Versions button opens the shared sheet, which lives in this body.
$effect(() => {
	registerPanelActions?.({ openVersions: () => (versionsOpen = true) });
});

$effect(() => {
	const listener = () => retrySave();
	window.addEventListener("online", listener);
	return () => window.removeEventListener("online", listener);
});

onDestroy(() => {
	loadToken += 1;
	clearSavedTimer();
	// The board's last step may still be inside its settle delay.
	boardApi?.flush();
	void autosave.flush();
	autosave.stop();
});

let boardReadonly = $derived(
	saveState === "conflict" || saveState === "deleted",
);
let showDroppedNotice = $derived(droppedCount > 0 && !noticeDismissed);
let banner = $derived(
	saveState === "offline"
		? "offline"
		: saveState === "failed"
			? "failed"
			: saveState === "conflict"
				? "conflict"
				: saveState === "tooLarge"
					? "tooLarge"
					: null,
);
</script>

<div class="canvas-editor" data-testid="canvas-editor">
	{#if phase === "loading"}
		<div class="canvas-editor__skeleton" role="status" aria-busy="true" data-testid="canvas-loading">
			<span class="sr-only">{$t("artifacts.canvas.loading")}</span>
			<span class="skeleton-card skeleton-card--a" aria-hidden="true"></span>
			<span class="skeleton-card skeleton-card--b" aria-hidden="true"></span>
			<span class="skeleton-card skeleton-card--c" aria-hidden="true"></span>
		</div>
	{:else if phase === "load_error"}
		<div class="canvas-editor__state" role="alert" data-testid="canvas-load-error">
			<p>{$t("artifacts.canvas.loadFailed")}</p>
			<button type="button" class="btn-secondary" onclick={() => load(artifactId)}>
				{$t("artifacts.canvas.retry")}
			</button>
		</div>
	{:else if phase === "no_access"}
		<div class="canvas-editor__state" role="status" data-testid="canvas-no-access">
			<p>{$t("artifacts.canvas.noAccess")}</p>
		</div>
	{:else if saveState === "deleted"}
		<div class="canvas-editor__state" role="alert" data-testid="canvas-deleted">
			<p>{$t("artifacts.canvas.deletedWhileOpen")}</p>
		</div>
	{:else}
		{#key boardKey}
			<SvelteFlowProvider>
				<CanvasBoard
					bind:this={boardApi}
					body={boardBody}
					readonly={boardReadonly}
					onchange={handleBoardChange}
				/>
			</SvelteFlowProvider>
		{/key}

		<div class="canvas-editor__notices">
			{#if showDroppedNotice}
				<div class="notice notice--warning" role="status" data-testid="canvas-dropped-notice">
					<span>{$t("artifacts.canvas.blockDropped", { count: droppedCount })}</span>
					<button type="button" class="notice__button" onclick={() => (noticeDismissed = true)}>
						{$t("artifacts.canvas.dismiss")}
					</button>
				</div>
			{/if}
			{#if banner === "offline"}
				<div class="notice notice--warning" role="alert" data-testid="canvas-offline">
					<span>{$t("artifacts.canvas.offline")}</span>
				</div>
			{:else if banner === "failed"}
				<div class="notice notice--warning" role="alert" data-testid="canvas-save-failed">
					<span>{$t("artifacts.canvas.saveFailed")}</span>
					<button type="button" class="notice__button" onclick={retrySave}>
						{$t("artifacts.canvas.retry")}
					</button>
				</div>
			{:else if banner === "conflict"}
				<div class="notice notice--warning" role="alert" data-testid="canvas-conflict">
					<span>{$t("artifacts.canvas.saveConflict")}</span>
					<button type="button" class="notice__button" onclick={() => load(artifactId)}>
						{$t("artifacts.canvas.reload")}
					</button>
				</div>
			{:else if banner === "tooLarge"}
				<div class="notice notice--warning" role="alert" data-testid="canvas-too-large">
					<span>{$t("artifacts.canvas.tooLarge")}</span>
				</div>
			{/if}
		</div>

		<p class="canvas-editor__status" role="status" aria-live="polite" data-testid="canvas-save-status">
			{#if saveState === "saving"}
				{$t("artifacts.canvas.saving")}
			{:else if saveState === "saved"}
				{$t("artifacts.canvas.saved")}
			{/if}
		</p>
	{/if}

	{#if versionsOpen}
		<VersionsSheet
			{artifactId}
			{conversationId}
			onClose={() => (versionsOpen = false)}
			onRestored={() => {
				versionsOpen = false;
				void load(artifactId);
			}}
			currentUserId={currentUser?.id ?? null}
			currentUserName={currentUser?.displayName ?? null}
			currentUserProfilePicture={currentUser?.profilePicture ?? null}
		/>
	{/if}
</div>

<style>
	.canvas-editor {
		position: relative;
		isolation: isolate;
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}

	.canvas-editor__state {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		padding: var(--space-lg);
		text-align: center;
		color: var(--text-secondary);
	}

	.canvas-editor__state p {
		margin: 0;
		max-width: 28rem;
	}

	/* Three cards on the board's dot grid, no spinner. */
	.canvas-editor__skeleton {
		position: relative;
		flex: 1 1 auto;
		min-height: 320px;
		background-color: var(--surface-page);
		background-image: radial-gradient(
			color-mix(in srgb, var(--text-primary) 15%, transparent) 1px,
			transparent 1px
		);
		background-size: 18px 18px;
	}

	.skeleton-card {
		position: absolute;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-elevated);
		animation: canvas-skeleton-pulse 1.4s ease-in-out infinite;
	}

	.skeleton-card--a {
		top: 12%;
		left: 8%;
		width: 34%;
		height: 22%;
	}

	.skeleton-card--b {
		top: 18%;
		left: 52%;
		width: 30%;
		height: 30%;
		animation-delay: 0.2s;
	}

	.skeleton-card--c {
		top: 56%;
		left: 20%;
		width: 40%;
		height: 20%;
		animation-delay: 0.4s;
	}

	@keyframes canvas-skeleton-pulse {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton-card {
			animation: none;
		}
	}

	.canvas-editor__notices {
		position: absolute;
		top: 10px;
		left: 50%;
		z-index: var(--artifact-overlay-z);
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: center;
		width: max-content;
		max-width: calc(100% - 24px);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.notice {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 6px 10px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		color: var(--text-primary);
		font-size: var(--text-sm);
		pointer-events: auto;
	}

	.notice--warning {
		border-color: color-mix(in srgb, var(--warning) 45%, transparent);
		background: color-mix(in srgb, var(--warning-tint) 100%, var(--surface-page));
		color: var(--warning-text);
	}

	.notice__button {
		flex: none;
		padding: 2px 8px;
		border: 1px solid currentColor;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.notice__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	/* Top-left: the toolbar, the overview, the zoom and the library's own
	   attribution have the bottom edge. */
	.canvas-editor__status {
		position: absolute;
		top: 10px;
		left: 12px;
		z-index: var(--artifact-overlay-z);
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
		pointer-events: none;
	}
</style>
