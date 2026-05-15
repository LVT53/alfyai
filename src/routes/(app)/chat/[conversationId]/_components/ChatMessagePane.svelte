<script lang="ts">
	import MessageArea from '$lib/components/chat/MessageArea.svelte';
	import type {
		ChatMessage,
		ContextDebugState,
		DeepResearchJob,
		DeepResearchReportIntent,
		DocumentWorkspaceItem,
		FileProductionJob,
		ConversationForkOrigin,
		TaskSteeringPayload
	} from '$lib/types';
	import type { MessageEditPayload, MessageRegeneratePayload } from '../_helpers';

	let {
		messages,
		conversationId,
		isThinkingActive,
		contextDebug,
		fileProductionJobs = [],
		deepResearchJobs = [],
		forkOrigin = null,
		forkOpening = false,
		forkingMessageId = null,
		readOnly = false,
		onOpenDocument,
		onRegenerate,
		onEdit,
		onFork,
		onSteer,
		canPublishSkillDrafts = false,
		skillDraftActionState = {},
		onSaveSkillDraft,
		onDismissSkillDraft,
		onPublishSkillDraft,
		onRetryFileProductionJob,
		onCancelFileProductionJob,
		onCancelDeepResearchJob,
		onEditDeepResearchPlan,
		onApproveDeepResearchPlan,
		onDiscussDeepResearchReport,
		onResearchFurtherFromDeepResearchReport,
		onAdvanceDeepResearchWorkflow,
	}: {
		messages: ChatMessage[];
		conversationId: string;
		isThinkingActive: boolean;
		contextDebug: ContextDebugState | null;
		fileProductionJobs?: FileProductionJob[];
		deepResearchJobs?: DeepResearchJob[];
		forkOrigin?: ConversationForkOrigin | null;
		forkOpening?: boolean;
		forkingMessageId?: string | null;
		readOnly?: boolean;
		onOpenDocument: (document: DocumentWorkspaceItem) => void;
		onRegenerate: (payload: MessageRegeneratePayload) => void;
		onEdit: (payload: MessageEditPayload) => void;
		onFork?: (payload: { messageId: string }) => void | Promise<void>;
		onSteer: (payload: TaskSteeringPayload) => void | Promise<void>;
		canPublishSkillDrafts?: boolean;
		skillDraftActionState?: Record<string, { busy?: boolean; error?: string | null }>;
		onSaveSkillDraft?: (payload: { messageId: string; draftId: string }) => void | Promise<void>;
		onDismissSkillDraft?: (payload: { messageId: string; draftId: string }) => void | Promise<void>;
		onPublishSkillDraft?: (payload: { messageId: string; draftId: string }) => void | Promise<void>;
		onRetryFileProductionJob?: (jobId: string) => void | Promise<void>;
		onCancelFileProductionJob?: (jobId: string) => void | Promise<void>;
		onCancelDeepResearchJob?: (jobId: string) => void | Promise<void>;
		onEditDeepResearchPlan?: (
			jobId: string,
			instructions: string,
			reportIntent?: DeepResearchReportIntent
		) => void | Promise<void>;
		onApproveDeepResearchPlan?: (jobId: string) => void | Promise<void>;
		onDiscussDeepResearchReport?: (jobId: string) => void | Promise<void>;
		onResearchFurtherFromDeepResearchReport?: (
			jobId: string,
			options?: { depth?: DeepResearchJob['depth'] }
		) => void | Promise<void>;
		onAdvanceDeepResearchWorkflow?: (jobId: string) => void | Promise<void>;
	} = $props();
</script>

<div
	class="message-layer message-layer-active flex min-h-0 flex-1"
	class:message-layer-fork-opening={forkOpening}
	data-fork-opening={forkOpening ? 'true' : undefined}
	aria-busy={forkOpening ? 'true' : undefined}
>
	<MessageArea
		{messages}
		{conversationId}
		{isThinkingActive}
		{contextDebug}
		{fileProductionJobs}
		{deepResearchJobs}
		{forkOrigin}
		{forkingMessageId}
		{readOnly}
		{onOpenDocument}
		{onRegenerate}
		{onEdit}
		{onFork}
		{onSteer}
		{canPublishSkillDrafts}
		{skillDraftActionState}
		{onSaveSkillDraft}
		{onDismissSkillDraft}
		{onPublishSkillDraft}
		{onRetryFileProductionJob}
		{onCancelFileProductionJob}
		{onCancelDeepResearchJob}
		{onEditDeepResearchPlan}
		{onApproveDeepResearchPlan}
		{onDiscussDeepResearchReport}
		{onResearchFurtherFromDeepResearchReport}
		{onAdvanceDeepResearchWorkflow}
	/>
</div>

<style>
	.message-layer {
		opacity: 0;
		transform: translateY(18px);
		pointer-events: none;
		transition:
			opacity 220ms cubic-bezier(0.22, 1, 0.36, 1),
			transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.message-layer-active {
		opacity: 1;
		transform: translateY(0);
		pointer-events: auto;
	}

	.message-layer-fork-opening {
		animation: forkPaneOpen 260ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@keyframes forkPaneOpen {
		from {
			opacity: 0.72;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.message-layer,
		.message-layer-fork-opening {
			animation: none;
			transition: none;
			transform: none;
		}
	}
</style>
