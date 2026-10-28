<script lang='ts'>
import type { Snippet } from "svelte";
import ErrorMessage from "$lib/components/chat/ErrorMessage.svelte";
import type {
	ComposerMarks,
	ComposerPictureRef,
} from "$lib/components/chat/composer-pictures";
import MessageInput from "$lib/components/chat/MessageInput.svelte";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type {
	AtlasAvailability,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type {
	ArtifactSummary,
	PendingAttachment,
} from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import type { DraftChangePayload, SendPayload } from "../_helpers";

let {
	sendError,
	canRetry = true,
	onRetry,
	onErrorClose,
	onSend,
	onQueue,
	pictureRefs = [],
	onRemovePictureRef = undefined,
	draftPictureOrder = [],
	imageMarks = null,
	onClearMarks = undefined,
	focusRequest = 0,
	onStop,
	onDraftChange,
	onEditQueuedMessage,
	onDeleteQueuedMessage,
	onCompact,
	disabled,
	isGenerating,
	canStopStreaming,
	hasQueuedMessage,
	queuedMessagePreview,
	maxLength,
	conversationId,
	contextStatus,
	attachedArtifacts,
	contextDebug,
	draftText,
	draftAttachments,
	draftLinkedSources = [],
	draftPendingSkill = null,
	draftAtlasMode = false,
	draftAtlasProfile = null,
	draftClientAtlasTurnId = null,
	draftVersion,
	onUploadReady,
	onUploadFiles,
	totalCostUsd,
	lastTurnCostUsd = 0,
	totalTokens,
	composerCommandRegistryEnabled = false,
	onInstructionCommand,
	atlasAvailability = null,
	personalityProfiles,
	selectedPersonalityId,
	onPersonalityChange,
	onModelChange,
	reasoningDepth,
	onReasoningDepthChange,
	memoryIncognito = false,
	onMemoryIncognitoChange,
	activeCapabilities = $bindable(new Set<string>()),
	beforeSend = undefined,
	checkingCloudWarning = false,
	onCapabilitiesReady = undefined,
	children,
	placeholder = null,
	onLayerHeightChange = undefined,
}: {
	sendError: string | null;
	// R1 (ADR-0060) — defaults to true so existing callers that never show a
	// non-retryable error keep today's behaviour; the chat page always
	// passes the runtime's real value.
	canRetry?: boolean;
	onRetry: () => void;
	onErrorClose: () => void;
	onSend: (payload: SendPayload) => void;
	onQueue: (payload: SendPayload) => void;
	/** Card, strip and History pictures waiting in the message (Attach), numbered by the composer. */
	pictureRefs?: readonly ComposerPictureRef[];
	onRemovePictureRef?: ((imageFileId: string) => void) | undefined;
	/** The numbering order of a restored turn's pictures, applied with the draft. */
	draftPictureOrder?: readonly string[];
	/** The marks drawn on one picture in the panel (plan 2b T6): one chip, cleared by its x. */
	imageMarks?: ComposerMarks | null;
	onClearMarks?: (() => void) | undefined;
	/** Rises when a picture was just attached: the composer takes focus. */
	focusRequest?: number;
	onStop: () => void | Promise<void>;
	onDraftChange: (payload: DraftChangePayload) => void;
	onEditQueuedMessage: () => void;
	onDeleteQueuedMessage: () => void;
	onCompact: () => void;
	disabled: boolean;
	isGenerating: boolean;
	canStopStreaming?: boolean | undefined;
	hasQueuedMessage: boolean;
	queuedMessagePreview: string;
	maxLength: number;
	conversationId: string;
	contextStatus: ConversationContextStatus | null;
	attachedArtifacts: ArtifactSummary[];
	contextDebug: ContextDebugState | null;
	draftText: string;
	draftAttachments: PendingAttachment[];
	draftLinkedSources?: LinkedContextSource[];
	draftPendingSkill?: PendingSkillSelection | null;
	draftAtlasMode?: boolean;
	draftAtlasProfile?: AtlasProfile | null;
	draftClientAtlasTurnId?: string | null;
	draftVersion: number;
	onUploadReady?:
		| ((uploadFn: (files: FileList | null) => Promise<void>) => void)
		| undefined;
	onUploadFiles?:
		| ((payload: {
				files: File[];
				conversationId: string;
				done: (
					result:
						| { success: true; attachment: PendingAttachment }
						| { success: false; fileName: string; error: string },
				) => void;
		  }) => void)
		| undefined;
	totalCostUsd?: number;
	lastTurnCostUsd?: number;
	totalTokens?: number;
	composerCommandRegistryEnabled?: boolean;
	// `/instruction <text>` — the chat page owns the dialog, so it owns the
	// scopes it can offer (project scope only exists when the conversation has
	// a project). Pure pass-through, same shape as `onCompact`.
	onInstructionCommand?: ((text: string) => void) | undefined;
	atlasAvailability?: AtlasAvailability | null;
	personalityProfiles?: Array<{
		id: string;
		name: string;
		description: string;
	}>;
	selectedPersonalityId?: string | null;
	onPersonalityChange?: ((id: string | null) => void) | undefined;
	onModelChange?: ((modelId: ModelId) => void) | undefined;
	reasoningDepth?: ReasoningDepth;
	onReasoningDepthChange?: ((depth: ReasoningDepth) => void) | undefined;
	memoryIncognito?: boolean;
	onMemoryIncognitoChange?:
		| ((value: boolean, conversationId: string) => void)
		| undefined;
	// Issue 7.4 fix pass — pass-through to MessageInput. See its prop docs:
	// `activeCapabilities` lets the page (the single cloud-warning chokepoint)
	// read the composer's current capability selection for regenerate/edit/
	// retry gate checks; `beforeSend`/`checkingCloudWarning` let the page
	// drive the composer's own send + queued-after-upload send through that
	// same chokepoint.
	activeCapabilities?: Set<string>;
	beforeSend?: (() => Promise<boolean>) | undefined;
	checkingCloudWarning?: boolean;
	// Issue 7.4 race-fix follow-up — pass-through to MessageInput; see its
	// prop doc for the full race this closes.
	onCapabilitiesReady?:
		| ((ensureLoaded: () => Promise<void>) => void)
		| undefined;
	children?: Snippet;
	/**
	 * Redesign §9.2, Wave 2.5 Step 12: "composer placeholder names the open
	 * item" — the chat page passes the title of whichever document/app/etc.
	 * is currently open in the artifact panel. Unset (the ordinary chat
	 * placeholder) when nothing is open, exactly like MessageInput's own
	 * `placeholder` prop doc already describes for the project page.
	 */
	placeholder?: string | null;
	/** The rendered composer-layer height, for the jump-to-latest button above it. */
	onLayerHeightChange?: ((height: number) => void) | undefined;
} = $props();

// The soft-keyboard offset is handled natively by the browser via the
// `interactive-widget=resizes-content` viewport directive (see src/app.html):
// when the keyboard opens the layout viewport shrinks, so the relative parent
// (`.chat-main`) resizes and this composer — anchored with `position: absolute;
// bottom: 0` — rides up with it. No manual keyboard-offset math required.
let layerEl = $state<HTMLElement | null>(null);
let layerHeight = $state(0);
$effect(() => {
	const element = layerEl;
	if (!element || typeof ResizeObserver === "undefined") return;
	layerHeight = element.clientHeight;
	const observer = new ResizeObserver(() => {
		layerHeight = element.clientHeight;
	});
	observer.observe(element);
	return () => observer.disconnect();
});
$effect(() => {
	onLayerHeightChange?.(layerHeight);
});
</script>

<div class='composer-layer' bind:this={layerEl}>
	<div class='composer-shell mx-auto flex w-full max-w-[780px] flex-col gap-3'>
		{#if sendError}
			<ErrorMessage
				error={sendError}
				{canRetry}
				onRetry={onRetry}
				onClose={onErrorClose}
			/>
		{/if}

		{@render children?.()}

		<MessageInput
			{onSend}
			{onQueue}
			{pictureRefs}
			{onRemovePictureRef}
			{draftPictureOrder}
			{imageMarks}
			{onClearMarks}
			{focusRequest}
			{onStop}
			{onDraftChange}
			{onEditQueuedMessage}
			{onDeleteQueuedMessage}
			{onCompact}
			{disabled}
			{isGenerating}
			{canStopStreaming}
			{hasQueuedMessage}
			{queuedMessagePreview}
			{maxLength}
			{conversationId}
			{contextStatus}
			{attachedArtifacts}
			{contextDebug}
			{draftText}
			{draftAttachments}
			{draftLinkedSources}
			{draftPendingSkill}
			{draftAtlasMode}
			{draftAtlasProfile}
			{draftClientAtlasTurnId}
			{draftVersion}
			attachmentsEnabled={true}
			{onUploadReady}
			{onUploadFiles}
			{totalCostUsd}
			{lastTurnCostUsd}
			{totalTokens}
			{composerCommandRegistryEnabled}
			{onInstructionCommand}
			{atlasAvailability}
			{personalityProfiles}
			{selectedPersonalityId}
			{onPersonalityChange}
			{onModelChange}
			{reasoningDepth}
			{onReasoningDepthChange}
			{memoryIncognito}
			{onMemoryIncognitoChange}
			bind:activeCapabilities
			{beforeSend}
			{checkingCloudWarning}
			{onCapabilitiesReady}
			{placeholder}
		/>
	</div>
</div>

<style>
	.composer-layer {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 10;
		/* Static safe-area gap at the bottom; the keyboard is handled natively by
		   `interactive-widget=resizes-content` resizing the layout viewport, so no
		   dynamic offset or padding-bottom transition is needed. */
		padding: 0.5rem 0.75rem calc(0.35rem + env(safe-area-inset-bottom));
		background: transparent;
		border: 0;
		box-shadow: none;
		isolation: isolate;
		/* Pass mouse events through the transparent overlay to the scrollbar below.
		   Interactive children inside .composer-shell restore pointer-events: auto. */
		pointer-events: none;
	}

	.composer-shell {
		background: transparent;
		border: 0;
		box-shadow: none;
		pointer-events: auto;
	}

	@media (max-width: 767px) {
		.composer-layer {
			padding-top: 0.4rem;
			padding-left: max(0.75rem, env(safe-area-inset-left));
			padding-right: max(0.75rem, env(safe-area-inset-right));
		}
	}
</style>
