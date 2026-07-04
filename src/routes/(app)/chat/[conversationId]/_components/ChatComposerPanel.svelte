<script lang='ts'>
import type { Snippet } from "svelte";
import ErrorMessage from "$lib/components/chat/ErrorMessage.svelte";
import MessageInput from "$lib/components/chat/MessageInput.svelte";
import type {
	ArtifactSummary,
	AtlasAvailability,
	AtlasProfile,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	LinkedContextSource,
	ModelId,
	PendingAttachment,
	PendingSkillSelection,
	ReasoningDepth,
} from "$lib/types";
import type { DraftChangePayload, SendPayload } from "../_helpers";

let {
	sendError,
	onRetry,
	onErrorClose,
	onSend,
	onQueue,
	onStop,
	onDraftChange,
	onEditQueuedMessage,
	onDeleteQueuedMessage,
	onCompact,
	onManageEvidence,
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
	contextSources = null,
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
	atlasAvailability = null,
	personalityProfiles,
	selectedPersonalityId,
	onPersonalityChange,
	onModelChange,
	reasoningDepth,
	onReasoningDepthChange,
	children,
}: {
	sendError: string | null;
	onRetry: () => void;
	onErrorClose: () => void;
	onSend: (payload: SendPayload) => void;
	onQueue: (payload: SendPayload) => void;
	onStop: () => void;
	onDraftChange: (payload: DraftChangePayload) => void;
	onEditQueuedMessage: () => void;
	onDeleteQueuedMessage: () => void;
	onCompact: () => void;
	onManageEvidence?: (() => void) | undefined;
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
	contextSources?: ContextSourcesState | null;
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
	children?: Snippet;
} = $props();

// The soft-keyboard offset is handled natively by the browser via the
// `interactive-widget=resizes-content` viewport directive (see src/app.html):
// when the keyboard opens the layout viewport shrinks, so the relative parent
// (`.chat-main`) resizes and this composer — anchored with `position: absolute;
// bottom: 0` — rides up with it. No manual keyboard-offset math required.
</script>

<div class='composer-layer'>
	<div class='composer-shell mx-auto flex w-full max-w-[780px] flex-col gap-3'>
		{#if sendError}
			<ErrorMessage error={sendError} onRetry={onRetry} onClose={onErrorClose} />
		{/if}

		{@render children?.()}

		<MessageInput
			{onSend}
			{onQueue}
			{onStop}
			{onDraftChange}
			{onEditQueuedMessage}
			{onDeleteQueuedMessage}
			{onCompact}
			{onManageEvidence}
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
			{contextSources}
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
			{atlasAvailability}
			{personalityProfiles}
			{selectedPersonalityId}
			{onPersonalityChange}
			{onModelChange}
			{reasoningDepth}
			{onReasoningDepthChange}
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
