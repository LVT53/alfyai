<script lang="ts">
import MessageArea from "$lib/components/chat/MessageArea.svelte";
import type {
	AtlasAction,
	AtlasJobCard,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import type { ContextCompressionMarker } from "$lib/server/services/context-compression";
import type { ConversationForkOrigin } from "$lib/server/services/conversation-forks";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import type { MessageEditPayload, MessageRegeneratePayload } from "../_helpers";

let {
	messages,
	conversationId,
	isIncognito = false,
	isThinkingActive,
	modelIcons = {},
	fileProductionJobs = [],
	atlasJobs = [],
	pendingWrites = [],
	contextCompressionMarkers = [],
	forkOrigin = null,
	forkOpening = false,
	forkingMessageId = null,
	showingLinkedMessage = false,
	readOnly = false,
	onOpenDocument,
	onRegenerate,
	onSendFollowUp,
	onEdit,
	onFork,
	skillDraftActionState = {},
	onSaveSkillDraft,
	onDismissSkillDraft,
	instructionSuggestionActionState = {},
	onReviewInstructionSuggestion,
	onDismissInstructionSuggestion,
	onRetryFileProductionJob,
	onCancelFileProductionJob,
	onDismissFileProductionJob,
	onCancelAtlasJob,
	onAtlasLifecycleAction,
	writeActionState = {},
	onConfirmWrite = undefined,
	onCancelWrite = undefined,
}: {
	messages: ChatMessage[];
	conversationId: string;
	/** Renders the one-time "Off the record from here" opening mark. */
	isIncognito?: boolean;
	isThinkingActive: boolean;
	modelIcons?: Record<string, string | null | undefined>;
	fileProductionJobs?: FileProductionJob[];
	atlasJobs?: AtlasJobCard[];
	pendingWrites?: PendingWrite[];
	contextCompressionMarkers?: ContextCompressionMarker[];
	forkOrigin?: ConversationForkOrigin | null;
	forkOpening?: boolean;
	forkingMessageId?: string | null;
	/** See MessageArea's prop of the same name. */
	showingLinkedMessage?: boolean;
	readOnly?: boolean;
	onOpenDocument: (document: DocumentWorkspaceItem) => void;
	onRegenerate: (payload: MessageRegeneratePayload) => void;
	onSendFollowUp?: (payload: { text: string }) => void;
	onEdit: (payload: MessageEditPayload) => void;
	onFork?: (payload: { messageId: string }) => void | Promise<void>;
	skillDraftActionState?: Record<
		string,
		{ busy?: boolean; error?: string | null }
	>;
	onSaveSkillDraft?: (payload: {
		messageId: string;
		draftId: string;
	}) => void | Promise<void>;
	onDismissSkillDraft?: (payload: {
		messageId: string;
		draftId: string;
	}) => void | Promise<void>;
	instructionSuggestionActionState?: Record<
		string,
		{ busy?: boolean; error?: string | null }
	>;
	onReviewInstructionSuggestion?: (payload: {
		messageId: string;
		suggestion: InstructionSuggestion;
	}) => void | Promise<void>;
	onDismissInstructionSuggestion?: (payload: {
		messageId: string;
		suggestion: InstructionSuggestion;
	}) => void | Promise<void>;
	onRetryFileProductionJob?: (jobId: string) => void | Promise<void>;
	onCancelFileProductionJob?: (jobId: string) => void | Promise<void>;
	onDismissFileProductionJob?: (jobId: string) => void | Promise<void>;
	onCancelAtlasJob?: (jobId: string) => void | Promise<void>;
	onAtlasLifecycleAction?: (payload: {
		jobId: string;
		action: AtlasAction;
		message: string;
		profile: AtlasProfile;
	}) => void | Promise<void>;
	writeActionState?: Record<string, { busy?: boolean; error?: string | null }>;
	onConfirmWrite?: (writeId: string) => void | Promise<void>;
	onCancelWrite?: (writeId: string) => void | Promise<void>;
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
		{isIncognito}
		{isThinkingActive}
		{modelIcons}
		{fileProductionJobs}
		{atlasJobs}
		{pendingWrites}
		{contextCompressionMarkers}
		{forkOrigin}
		{forkingMessageId}
		{showingLinkedMessage}
		{readOnly}
		{onOpenDocument}
		{onRegenerate}
		{onSendFollowUp}
		{onEdit}
		{onFork}
		{skillDraftActionState}
		{onSaveSkillDraft}
		{onDismissSkillDraft}
		{instructionSuggestionActionState}
		{onReviewInstructionSuggestion}
		{onDismissInstructionSuggestion}
		{onRetryFileProductionJob}
		{onCancelFileProductionJob}
		{onDismissFileProductionJob}
		{onCancelAtlasJob}
		{onAtlasLifecycleAction}
		{writeActionState}
		{onConfirmWrite}
		{onCancelWrite}
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
