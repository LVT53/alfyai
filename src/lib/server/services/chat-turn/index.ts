// The single entrypoint into chat-turn (F1). Both transports — the `send`
// non-streaming route and the `stream` route (plus `retry`, which reuses the
// stream orchestrator) — drive a Normal Chat turn through this facade rather
// than importing individual chat-turn submodules directly. This is a facade
// *inside* the existing chat-turn/ module directory, not a new top-level
// `src/lib/server/services/*.ts` boundary — see AGENTS.md "What Not To
// Reintroduce".
//
// Internals (finalize-steps, stream sub-modules, depth/context helpers, ...)
// stay reachable only from other files inside chat-turn/; routes should not
// reach past this file into them.

export { checkStreamCapacity } from "./active-streams";
export type {
	FinalizeChatTurnDurableReceipt,
	FinalizeChatTurnParams,
	FinalizeChatTurnResult,
} from "./finalize";
export { finalizeChatTurn } from "./finalize";
export { normalizeAssistantOutputWithSkillControl } from "./normalizer";
export { runPlainNormalChatSendModel } from "./plain-normal-chat-model-run";
export {
	admitChatTurnStream,
	preflightAtlasTurnSources,
	preflightChatTurn,
	prepareAdmittedChatTurn,
} from "./preflight";
export { parseChatTurnRequest } from "./request";
export { prepareRetryChatTurn } from "./retry";
export {
	classifyStreamErrorCause,
	createStreamJsonErrorResponse,
} from "./stream";
export {
	runChatStreamOrchestrator,
	startStartedResetGenerationFact,
} from "./stream-orchestrator";
export type { ParsedChatTurnRequest } from "./types";
