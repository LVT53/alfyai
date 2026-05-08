<script lang='ts'>
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import ErrorMessage from '$lib/components/chat/ErrorMessage.svelte';
	import MessageInput from '$lib/components/chat/MessageInput.svelte';
	import type {
		ArtifactSummary,
		ContextDebugState,
		ContextSourcesState,
		ConversationContextStatus,
		PendingAttachment,
		TaskState,
		TaskSteeringPayload,
		ThinkingMode,
	} from '$lib/types';
	import type { DraftChangePayload, SendPayload } from '../_helpers';

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
		disabled,
		isGenerating,
		hasQueuedMessage,
		queuedMessagePreview,
		maxLength,
		conversationId,
		contextStatus,
		attachedArtifacts,
		taskState,
		contextDebug,
		contextSources = null,
		draftText,
		draftAttachments,
		draftVersion,
		onSteer,
		onManageEvidence,
		onUploadReady,
		onUploadFiles,
		totalCostUsd,
		totalTokens,
		deepResearchEnabled,
		personalityProfiles,
		selectedPersonalityId,
		onPersonalityChange,
		thinkingMode,
		onThinkingModeChange,
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
		disabled: boolean;
		isGenerating: boolean;
		hasQueuedMessage: boolean;
		queuedMessagePreview: string;
		maxLength: number;
		conversationId: string;
		contextStatus: ConversationContextStatus | null;
		attachedArtifacts: ArtifactSummary[];
		taskState: TaskState | null;
		contextDebug: ContextDebugState | null;
		contextSources?: ContextSourcesState | null;
		draftText: string;
		draftAttachments: PendingAttachment[];
		draftVersion: number;
		onSteer: (payload: TaskSteeringPayload) => void | Promise<void>;
		onManageEvidence: () => void;
		onUploadReady?: ((uploadFn: (files: FileList | null) => Promise<void>) => void) | undefined;
		onUploadFiles?: ((payload: {
			files: File[];
			conversationId: string;
			done: (result:
				| { success: true; attachment: PendingAttachment }
				| { success: false; fileName: string; error: string }
			) => void;
		}) => void) | undefined;
		totalCostUsd?: number;
		totalTokens?: number;
		deepResearchEnabled?: boolean;
		personalityProfiles?: Array<{ id: string; name: string; description: string }>;
		selectedPersonalityId?: string | null;
		onPersonalityChange?: ((id: string | null) => void) | undefined;
		thinkingMode?: ThinkingMode;
		onThinkingModeChange?: ((mode: ThinkingMode) => void) | undefined;
	} = $props();

	// Dynamic keyboard detection using visualViewport API
	let keyboardOffset = $state(0);
	let isMobile = $state(false);

	function handleVisualViewportChange() {
		if (typeof window === 'undefined') return;

		const visualViewport = window.visualViewport;
		if (!visualViewport) return;

		// Calculate the offset between layout viewport height and visual viewport height
		// When keyboard opens, visual viewport height decreases
		const layoutHeight = window.innerHeight;
		const visualHeight = visualViewport.height;
		const visualTop = visualViewport.offsetTop;

		// The keyboard takes up the space between visualHeight and layoutHeight
		// We also need to account for any offset from the visual viewport top
		const keyboardHeight = Math.max(0, layoutHeight - visualHeight - visualTop);

		// Only add offset if it's significant (more than 50px to avoid false positives)
		keyboardOffset = keyboardHeight > 50 ? keyboardHeight : 0;
	}

	onMount(() => {
		// Detect if this is a mobile device
		isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

		// Listen for visualViewport changes (keyboard open/close)
		if (typeof window.visualViewport !== 'undefined') {
			window.visualViewport.addEventListener('resize', handleVisualViewportChange);
			window.visualViewport.addEventListener('scroll', handleVisualViewportChange);
		}

		// Fallback: listen for window resize
		window.addEventListener('resize', handleVisualViewportChange);

		// Initial calculation
		handleVisualViewportChange();
	});

	onDestroy(() => {
		if (!browser) return;
		if (typeof window.visualViewport !== 'undefined') {
			window.visualViewport.removeEventListener('resize', handleVisualViewportChange);
			window.visualViewport.removeEventListener('scroll', handleVisualViewportChange);
		}
		window.removeEventListener('resize', handleVisualViewportChange);
	});
</script>

<div
	class='composer-layer'
	style='padding-bottom: calc(0.35rem + env(safe-area-inset-bottom) + 8px + {keyboardOffset}px);'
>
	<div class='composer-shell mx-auto flex w-full max-w-[780px] flex-col gap-3'>
		{#if sendError}
			<ErrorMessage error={sendError} onRetry={onRetry} onClose={onErrorClose} />
		{/if}

		<MessageInput
			{onSend}
			{onQueue}
			{onStop}
			{onDraftChange}
			{onEditQueuedMessage}
			{onDeleteQueuedMessage}
			{disabled}
			{isGenerating}
			{hasQueuedMessage}
			{queuedMessagePreview}
			{maxLength}
			{conversationId}
			{contextStatus}
			{attachedArtifacts}
			{taskState}
			{contextDebug}
			{contextSources}
			{draftText}
			{draftAttachments}
			{draftVersion}
			attachmentsEnabled={true}
			{onSteer}
			onManageEvidence={onManageEvidence}
			{onUploadReady}
			{onUploadFiles}
			{totalCostUsd}
			{totalTokens}
			{deepResearchEnabled}
			{personalityProfiles}
			{selectedPersonalityId}
			{onPersonalityChange}
			{thinkingMode}
			{onThinkingModeChange}
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
		padding: 0.5rem 0.75rem;
		background: transparent;
		border: 0;
		box-shadow: none;
		isolation: isolate;
		/* Mobile: ensure content stays above keyboard */
		transition: padding-bottom 150ms ease;
	}

	.composer-shell {
		background: transparent;
		border: 0;
		box-shadow: none;
	}

	@media (max-width: 767px) {
		.composer-layer {
			padding-top: 0.4rem;
			padding-left: max(0.75rem, env(safe-area-inset-left));
			padding-right: max(0.75rem, env(safe-area-inset-right));
		}
	}
</style>
