import type { ModelId } from "$lib/model-types";
import type { UserPicturesMetadata } from "$lib/shared/artifacts/image-body";
import type { InstructionScopeApplication } from "$lib/shared/instructions";
import type { ProviderUsageSnapshot } from "../analytics";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "../knowledge/context-types";
import type { ToolCallEntry } from "../messages-types";
import type { NormalChatContextPreparationStageTiming } from "../normal-chat-context-preparation";
import type { TaskState } from "../task-state/types";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import type { DepthMetadata } from "./depth-metadata-types";
import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";
import type { NormalChatSendModelBaseParams } from "./shared-normal-chat-model-run-helpers";
export type PlainNormalChatSendModelParams = NormalChatSendModelBaseParams & {
	// disableTools / forceProduceFileTool are inherited from the base type;
	// they are plain-only options but typed on the shared base so the shared
	// helpers can read them uniformly.
};

export type PlainNormalChatSendModelResult = {
	text: string;
	completionTurn?: import("./prepared-normal-chat-turn").CompletionReceipt;
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
	providerUsage?: ProviderUsageSnapshot | null;
	// Full-prompt estimate (system prompt + final packet + tool schemas) for
	// the context usage ring when the provider reports no input tokens.
	estimatedPromptTokens?: number;
	prefetchedToolCalls?: ToolCallEntry[];
	normalChatToolCalls?: ToolCallEntry[];
	toolCalls?: ToolCallEntry[];
	modelId: ModelId;
	modelDisplayName: string;
	resolvedProviderId: string;
	depthMetadata?: DepthMetadata;
	// Which instruction scopes the prepared system prompt carried, so the send
	// route persists what the model actually got instead of re-reading the
	// user's settings after the turn.
	instructionsApplied?: InstructionScopeApplication;
	// What the user message keeps of the pictures beside its uploads (card
	// pictures, the open picture, the marked copy), for finalize.
	userPictures?: UserPicturesMetadata;
};

export async function runPlainNormalChatSendModel(
	params: PlainNormalChatSendModelParams,
): Promise<PlainNormalChatSendModelResult> {
	return (await prepareNormalChatTurn(params)).runPlain();
}
