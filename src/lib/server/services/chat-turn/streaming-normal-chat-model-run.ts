import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import type { UserPicturesMetadata } from "$lib/shared/artifacts/image-body";
import type { InstructionScopeApplication } from "$lib/shared/instructions";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "../knowledge/context-types";
import type { ToolCallEntry } from "../messages-types";
import type { NormalChatContextPreparationStageTiming } from "../normal-chat-context-preparation";
import type { StreamingNormalChatModelRunEvent } from "../normal-chat-model";
import type { TurnAsk } from "../normal-chat-tools/ask-user";
import type { TaskState } from "../task-state/types";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import type { DepthMetadata } from "./depth-metadata-types";
import { prepareNormalChatTurn } from "./prepared-normal-chat-turn";
import type { NormalChatSendModelBaseParams } from "./shared-normal-chat-model-run-helpers";
export type StreamingNormalChatSendModelParams = Omit<
	NormalChatSendModelBaseParams,
	"disableTools" | "forceProduceFileTool" | "canPause"
>;
export type StreamingNormalChatPreparedContext = {
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
	// Full-prompt estimate (system prompt + final packet + tool schemas) for
	// the context usage ring when the provider reports no input tokens.
	estimatedPromptTokens?: number;
	// Which instruction scopes the prepared system prompt carried. It rides
	// this snapshot rather than being re-derived at completion: the record has
	// to describe the prompt the model got, and the orchestrator's completion
	// step runs long after context preparation.
	instructionsApplied?: InstructionScopeApplication;
	// What the user message keeps of the pictures beside its uploads.
	userPictures?: UserPicturesMetadata;
};

export type StreamingNormalChatSendModelResult = {
	prepared: StreamingNormalChatPreparedContext;
	completionTurn?: import("./prepared-normal-chat-turn").CompletionReceipt;
	modelId: ModelId;
	modelDisplayName: string;
	providerIconUrl?: string | null;
	resolvedProviderId: string;
	stream: AsyncIterable<StreamingNormalChatModelRunEvent>;
	prefetchedToolCalls: ToolCallEntry[];
	getNormalChatToolCalls: () => ToolCallEntry[];
	getToolCalls: () => ToolCallEntry[];
	depthMetadata?: DepthMetadata;
	/** What this turn asked the person with `ask_user`, once the tool recorded it; null until then. */
	getTurnAsk: () => TurnAsk | null;
	/**
	 * Everything the run has said and read, as of the last step that finished
	 * (the SDK's cumulative `response.messages`, tool results whole). Read it when
	 * the stream sends `finish`: the SDK has finished that step's callback by then.
	 */
	getResponseMessages: () => ModelMessage[];
	/**
	 * What the model was given after the person's message, as messages: the page the
	 * server fetched before it ran and, on a resume, the continuation it carried on
	 * from.
	 */
	continuationGiven: ModelMessage[];
};

export async function runStreamingNormalChatSendModel(
	params: StreamingNormalChatSendModelParams,
): Promise<StreamingNormalChatSendModelResult> {
	const run = await prepareNormalChatTurn({
		...params,
		canPause: true,
		disableTools: false,
		forceProduceFileTool: false,
	});
	return run.stream();
}
