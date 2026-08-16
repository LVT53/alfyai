// The full conversation-detail read-model payload assembled by
// read-model.ts for `/api/conversations/[id]` GET responses and chat-page
// hydration. Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); this file carries no behavior change, only
// a new home.

import type {
	AtlasAvailability,
	AtlasJobCard,
} from "$lib/server/services/atlas/public-types";
import type { ContextCompressionMarker } from "$lib/server/services/context-compression";
import type { ConversationForkOrigin } from "$lib/server/services/conversation-forks";
import type {
	Conversation,
	ConversationDraft,
} from "$lib/server/services/conversations";
import type {
	ChatGeneratedFile,
	FileProductionJob,
} from "$lib/server/services/file-production/types";
import type {
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { ArtifactSummary } from "$lib/server/services/knowledge/types";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { SkillSession } from "$lib/server/services/skills/types";
import type { TaskState } from "$lib/server/services/task-state/types";

export interface ConversationDetail {
	conversation: Conversation;
	messages: ChatMessage[];
	/**
	 * O1 — `messages` is a bounded window of the most recent messages, not
	 * necessarily the full history. `true` when older messages exist beyond
	 * this window (see `getOlderConversationMessages` in the conversation
	 * detail read model for paging them in on demand).
	 */
	hasMoreMessages?: boolean;
	forkOrigin?: ConversationForkOrigin | null;
	attachedArtifacts?: ArtifactSummary[];
	activeWorkingSet?: ArtifactSummary[];
	contextStatus?: ConversationContextStatus | null;
	contextSources?: ContextSourcesState | null;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	draft?: ConversationDraft | null;
	bootstrap?: boolean;
	generatedFiles?: ChatGeneratedFile[];
	fileProductionJobs?: FileProductionJob[];
	atlasJobs?: AtlasJobCard[];
	atlasAvailability?: AtlasAvailability | null;
	contextCompressionSnapshots?: ContextCompressionMarker[];
	activeSkillSession?: SkillSession | null;
	totalCostUsdMicros?: number;
	totalTokens?: number;
	sidecarPending?: boolean;
}
