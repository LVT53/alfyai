const defaultConversationFixture = {
	id: "conv-1",
	title: "Test",
	createdAt: 0,
	updatedAt: 0,
} as const;

export const missingPendingSkill = {
	available: false,
	availabilityReason: "not_found",
	id: "skill-1",
	ownership: "user",
	skillKind: null,
	displayName: null,
	description: null,
	effectiveInstructions: "",
	effectiveInstructionsHash: null,
	publicSummary: null,
	sourceIds: null,
} as const;

const testUserMessage = {
	id: "user-msg",
	role: "user" as const,
	content: "Hello",
	timestamp: 0,
};

const testAssistantMessage = {
	id: "assistant-msg",
	role: "assistant" as const,
	content: "Hello from AI!",
	timestamp: 0,
};

export const skillAwaitingUserOperation = {
	operationId: "ask-deadline",
	kind: "session_transition",
	transition: "awaiting_user",
} as const;

export const noteCreateDecisionOperation = {
	operationId: "note-create-1",
	kind: "note_intent",
	action: "create",
	title: "Decision",
	body: "Use the short plan.",
} as const;

export const baseSkillSummary = {
	id: "skill-1",
	ownership: "user" as const,
	displayName: "Interview coach",
};

export const baseUserSkillDefinition = {
	id: "skill-1",
	ownership: "user",
	displayName: "Interview coach",
	description: "Asks useful questions.",
	instructions: "Ask one concise follow-up before answering.",
	activationExamples: ["interview me first"],
	enabled: true,
	durationPolicy: "next_message",
	questionPolicy: "ask_when_needed",
	notesPolicy: "none",
	sourceScope: "selected_sources_only",
	creationSource: "user_created",
	version: 1,
	createdAt: 1,
	updatedAt: 2,
} as const;

export const baseResolvedSkillDefinition = {
	available: true,
	availabilityReason: "available",
	id: "skill-1",
	ownership: "user",
	skillKind: "user_skill",
	displayName: "Interview coach",
	description: "Asks useful questions.",
	effectiveInstructions: "Ask one concise follow-up before answering.",
	effectiveInstructionsHash: "test-hash",
	publicSummary: {
		id: "skill-1",
		ownership: "user",
		skillKind: "user_skill",
		baseSkillId: null,
		baseSkillVersion: null,
		displayName: "Interview coach",
		description: "Asks useful questions.",
		activationExamples: ["interview me first"],
		enabled: true,
		durationPolicy: "next_message",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "selected_sources_only",
		creationSource: "user_created",
		version: 1,
		createdAt: 1,
		updatedAt: 2,
	},
	durationPolicy: "next_message",
	questionPolicy: "ask_when_needed",
	notesPolicy: "none",
	sourceScope: "selected_sources_only",
	sourceIds: {
		skillId: "skill-1",
		skillVersion: 1,
		packSkillId: null,
		packSkillVersion: null,
		variantSkillId: null,
		variantSkillVersion: null,
	},
} as const;

export const baseSkillSession = {
	id: "session-1",
	userId: "user-1",
	conversationId: "conv-1",
	skillId: "skill-1",
	skillOwnership: "user",
	status: "active",
	pauseReason: null,
	endReason: null,
	skillDisplayName: "Interview coach",
	skillDescription: "Asks useful questions.",
	skillInstructions: "Ask one concise follow-up before answering.",
	activationExamples: [],
	durationPolicy: "session",
	questionPolicy: "none",
	notesPolicy: "create_private_notes",
	sourceScope: "selected_sources_only",
	skillVersion: 1,
	startedFrom: "pending_skill",
	startedAt: 1,
	updatedAt: 1,
	pausedAt: null,
	endedAt: null,
	milestones: [],
} as const;

export const linkedSourceFixture = {
	displayArtifactId: "display-1",
	promptArtifactId: "prompt-1",
	familyArtifactIds: ["display-1", "prompt-1"],
	name: "Linked source.pdf",
	type: "document" as const,
};

export const skillControlEnvelope = (operations: unknown[]) =>
	[
		"<skill_control_v1>",
		JSON.stringify({
			version: 1,
			operations,
		}),
		"</skill_control_v1>",
	].join("\n");

export function makeEvent(
	body: unknown,
	user = { id: "user-1", email: "test@example.com" },
): {
	request: Request;
	locals: { user: { id: string; email: string } };
	params: Record<string, never>;
	url: URL;
	route: { id: string };
} {
	return {
		request: new Request("http://localhost/api/chat/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/chat/send"),
		route: { id: "/api/chat/send" },
	};
}

function makeInvalidJsonEvent(body: string) {
	return {
		request: new Request("http://localhost/api/chat/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
		locals: { user: { id: "user-1" } },
		params: {},
		url: new URL("http://localhost/api/chat/send"),
		route: { id: "/api/chat/send" },
	};
}

export const buildInvalidJsonEvent = makeInvalidJsonEvent;

export function buildReasoningDepthMetadata(request: {
	reasoningDepth?: string | null;
	modelId?: string | null;
	modelDisplayName?: string | null;
	providerDisplayName?: string | null;
}) {
	return {
		requested: request.reasoningDepth ?? "auto",
		appliedProfile:
			request.reasoningDepth === "off"
				? "off"
				: request.reasoningDepth === "max"
					? "maximum"
					: "standard",
		fallback: false,
		modelId: request.modelId,
		modelDisplayName: request.modelDisplayName,
		providerDisplayName: request.providerDisplayName,
	};
}

export function seedConversation(
	mockGetConversation: (...args: unknown[]) => Promise<unknown>,
	overrides: Partial<typeof defaultConversationFixture> = {},
) {
	mockGetConversation.mockResolvedValue({
		...defaultConversationFixture,
		...overrides,
	});
}

export function seedDefaultConversationMessages(
	mockCreateMessage: (...args: unknown[]) => Promise<unknown>,
	input: {
		userMessage?: Partial<typeof testUserMessage>;
		assistantMessage?: Partial<typeof testAssistantMessage>;
		userMessageId?: string;
		assistantMessageId?: string;
	} = {},
) {
	mockCreateMessage
		.mockResolvedValueOnce({
			...testUserMessage,
			timestamp: Date.now(),
			id: input.userMessageId ?? testUserMessage.id,
			...input.userMessage,
		})
		.mockResolvedValueOnce({
			...testAssistantMessage,
			timestamp: Date.now(),
			id: input.assistantMessageId ?? testAssistantMessage.id,
			...input.assistantMessage,
		});
}

export function seedUserConversationMessage(
	mockCreateMessage: (...args: unknown[]) => Promise<unknown>,
	content: string,
	id = "user-msg",
) {
	mockCreateMessage.mockResolvedValueOnce({
		...testUserMessage,
		id,
		content,
		timestamp: Date.now(),
	});
}
