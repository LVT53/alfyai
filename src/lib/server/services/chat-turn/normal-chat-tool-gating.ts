import type { createNormalChatTools } from "$lib/server/services/normal-chat-tools";

type NormalChatToolSet = ReturnType<typeof createNormalChatTools>["tools"];

// File-production tools are registered on every turn. They used to be gated
// by a message-pattern match, which made the tool set (and therefore the
// cached prompt prefix) change from turn to turn; the description now
// carries the "only when the user asks for a downloadable file" rule, and
// the turn guidance holds only the catalogue (ruling 5). So nothing below
// ever looks at the message: the set varies by conversation state (memory,
// skills, incognito), never by what was just said.
// `forceProduceFileTool` is kept for callers that force tool choice.
export function selectNormalChatToolsForRequest(
	tools: NormalChatToolSet,
	params: {
		message: string;
		forceProduceFileTool?: boolean;
		// Read-side memory master gate for this turn. Callers resolve
		// isMemoryActiveForConversation (the single source of truth: master
		// toggle AND non-incognito) and pass the result. Omitted/true keeps
		// today's behaviour; false withholds the memory_context recall tool so
		// an incognito or memory-disabled conversation is never offered memory
		// recall. Defaults to active when unspecified (fail open).
		memoryActive?: boolean;
		// Composer Command Registry master switch for this turn. The per-turn
		// skills catalogue (shared-normal-chat-model-run-helpers.ts) and the
		// explicit `$` selection (preflight.ts) are both gated on it, so the
		// `use_skill` tool has to be withheld with them — otherwise the model
		// keeps a live path into skill instructions for a feature the operator
		// switched off. Omitted/true keeps today's behaviour (fail open).
		skillsEnabled?: boolean;
		// Whether this conversation is incognito (isConversationIncognito).
		// Deliberately NOT folded into `memoryActive`: instructions apply in
		// incognito, so the two flags answer different questions. What incognito
		// withholds is the offer to *write* a standing instruction — an AI
		// suggestion is a learning-shaped surface, and incognito's promise is
		// that nothing is learned from the conversation. Incognito is one-way
		// for a conversation's whole life, so this gate never changes inside
		// one, which is what keeps the cached prefix stable.
		incognito?: boolean;
		// The person's own "Pictures and videos" switch (Settings > Profile),
		// resolved by the caller (images/picture-making.ts's isPictureMakingOnFor).
		// False withholds the two tools that make something to look at; finding
		// pictures (image_search), seeing the ones the person sends and asking
		// stay. Omitted/true keeps today's behaviour. It changes only when the
		// person flips it, so the cached prefix stays put between their turns.
		picturesAndVideos?: boolean;
	},
): Partial<NormalChatToolSet> {
	const selected: Partial<NormalChatToolSet> = { ...tools };
	if (params.memoryActive === false) {
		delete selected.memory_context;
	}
	if (params.skillsEnabled === false) {
		delete selected.use_skill;
	}
	if (params.incognito === true) {
		delete selected.suggest_instruction;
	}
	if (params.picturesAndVideos === false) {
		delete selected.make_image;
		delete selected.make_video;
	}
	return selected;
}
