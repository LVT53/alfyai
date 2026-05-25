<script lang="ts">
	import MessageInput from './MessageInput.svelte';
	import type {
		ContextDebugState,
		ConversationContextStatus,
		LinkedContextSource,
		TaskSteeringPayload,
	} from '$lib/types';

	let {
		maxLength = 10000,
		disabled = false,
		isGenerating = false,
		hasQueuedMessage = false,
		queuedMessagePreview = '',
		conversationId = null,
		attachmentsEnabled = false,
		contextStatus = null,
		contextDebug = null,
		ensureConversation = null,
		onSend = () => {},
		onQueue = () => {},
		onSteer = () => {},
		onManageEvidence = () => {},
		onEditQueuedMessage = () => {},
		onDeleteQueuedMessage = () => {},
		onCompact = () => {},
		onDraftChange = () => {}
	}: {
		maxLength?: number;
		disabled?: boolean;
		isGenerating?: boolean;
		hasQueuedMessage?: boolean;
		queuedMessagePreview?: string;
		conversationId?: string | null;
		attachmentsEnabled?: boolean;
		contextStatus?: ConversationContextStatus | null;
		contextDebug?: ContextDebugState | null;
		ensureConversation?: (() => Promise<string>) | null;
		onSend?: (message: string) => void;
		onQueue?: (message: string) => void;
		onSteer?: (payload: TaskSteeringPayload) => void;
		onManageEvidence?: () => void;
		onEditQueuedMessage?: () => void;
		onDeleteQueuedMessage?: () => void;
		onCompact?: () => void;
		onDraftChange?: (payload: {
			conversationId: string | null;
			draftText: string;
			selectedAttachmentIds: string[];
			selectedLinkedSources: LinkedContextSource[];
		}) => void;
	} = $props();

	function handleSend(payload: { message: string }) {
		onSend(payload.message);
	}

	function handleQueue(payload: { message: string }) {
		onQueue(payload.message);
	}

	function handleSteer(payload: TaskSteeringPayload) {
		onSteer(payload);
	}

	function handleDraftChange(payload: {
		conversationId: string | null;
		draftText: string;
		selectedAttachmentIds: string[];
		selectedLinkedSources: LinkedContextSource[];
	}) {
		onDraftChange(payload);
	}
</script>

<MessageInput
	{maxLength}
	{disabled}
	{isGenerating}
	{hasQueuedMessage}
	{queuedMessagePreview}
	{conversationId}
	{attachmentsEnabled}
	{ensureConversation}
	{contextStatus}
	{contextDebug}
	onSend={handleSend}
	onQueue={handleQueue}
	onSteer={handleSteer}
	{onManageEvidence}
	{onEditQueuedMessage}
	{onDeleteQueuedMessage}
	{onCompact}
	onDraftChange={handleDraftChange}
/>
