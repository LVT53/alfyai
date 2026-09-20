import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedChatTurnRequest } from "./types";

const mocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	assertPromptReadyAttachments: vi.fn(),
	isAttachmentReadinessError: vi.fn(),
	addConversationLinkedContextSources: vi.fn(),
	isLinkedContextSourceError: vi.fn(),
	resolvePendingSkillApplication: vi.fn(),
	resolveReasoningDepthSelection: vi.fn(),
	getExtractionJobsForArtifacts: vi.fn(),
	getExtractionJobForArtifact: vi.fn(),
	waitForExtractionJobVerdict: vi.fn(),
	getExtractionConfig: vi.fn(),
}));

vi.mock("$lib/server/services/extraction", () => ({
	getExtractionConfig: mocks.getExtractionConfig,
	getExtractionJobsForArtifacts: mocks.getExtractionJobsForArtifacts,
	getExtractionJobForArtifact: mocks.getExtractionJobForArtifact,
	waitForExtractionJobVerdict: mocks.waitForExtractionJobVerdict,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		composerCommandRegistryEnabled: true,
	})),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: mocks.getConversation,
}));

vi.mock("$lib/server/services/knowledge", () => ({
	assertPromptReadyAttachments: mocks.assertPromptReadyAttachments,
	isAttachmentReadinessError: mocks.isAttachmentReadinessError,
}));

vi.mock("$lib/server/services/linked-context-sources", () => ({
	addConversationLinkedContextSources:
		mocks.addConversationLinkedContextSources,
	isLinkedContextSourceError: mocks.isLinkedContextSourceError,
}));

vi.mock("$lib/server/services/skills/prompt-context", () => ({
	resolvePendingSkillApplication: mocks.resolvePendingSkillApplication,
}));

vi.mock("./depth-selection", () => ({
	resolveReasoningDepthSelection: mocks.resolveReasoningDepthSelection,
}));

function makeRequest(
	overrides: Partial<ParsedChatTurnRequest> = {},
): ParsedChatTurnRequest {
	return {
		conversationId: "conv-1",
		normalizedMessage: "Compare the migration paths.",
		modelId: "model1",
		modelDisplayName: "Model One",
		providerDisplayName: "Provider One",
		attachmentIds: [],
		linkedSources: [],
		pendingSkill: null,
		reasoningDepth: "thorough",
		thinkingMode: "auto",
		forceWebSearch: false,
		skipPersistUserMessage: false,
		atlasMode: false,
		atlasProfile: null,
		atlasAction: "create",
		parentAtlasId: null,
		clientAtlasTurnId: null,
		...overrides,
	};
}

function makeHeavyRequest(): ParsedChatTurnRequest {
	return makeRequest({
		attachmentIds: ["attachment-1"],
		linkedSources: [
			{
				displayArtifactId: "display-artifact-1",
				promptArtifactId: "prompt-artifact-1",
				familyArtifactIds: ["family-artifact-1"],
				name: "Architecture notes",
				type: "document",
				mimeType: "text/markdown",
			},
		],
		pendingSkill: {
			id: "skill-1",
			ownership: "user",
			displayName: "Research Skill",
		},
	});
}

function resetPreflightMocks() {
	vi.clearAllMocks();
	mocks.getConversation.mockResolvedValue({
		id: "conv-1",
		userId: "user-1",
		title: "Conversation",
	});
	mocks.assertPromptReadyAttachments.mockResolvedValue(undefined);
	mocks.isAttachmentReadinessError.mockReturnValue(false);
	mocks.getExtractionJobsForArtifacts.mockResolvedValue([]);
	mocks.getExtractionJobForArtifact.mockResolvedValue(null);
	mocks.waitForExtractionJobVerdict.mockResolvedValue({
		settled: false,
		job: null,
	});
	mocks.getExtractionConfig.mockReturnValue({ preflightWaitMs: 2500 });
	mocks.addConversationLinkedContextSources.mockResolvedValue([]);
	mocks.isLinkedContextSourceError.mockReturnValue(false);
	mocks.resolvePendingSkillApplication.mockResolvedValue({ ok: false });
	mocks.resolveReasoningDepthSelection.mockResolvedValue({
		metadata: {
			requested: "thorough",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
			modelId: "model1",
			modelDisplayName: "Model One",
			providerDisplayName: "Provider One",
		},
	});
}

describe("admitChatTurnStream", () => {
	beforeEach(() => {
		resetPreflightMocks();
	});

	it("admits a stream turn for an owned conversation", async () => {
		const { admitChatTurnStream } = await import("./preflight");
		const request = makeRequest();

		const result = await admitChatTurnStream({
			userId: "user-1",
			request,
		});

		expect(result).toEqual({
			ok: true,
			value: request,
		});
		expect(mocks.getConversation).toHaveBeenCalledWith("user-1", "conv-1");
	});

	it("rejects a stream turn when the conversation is missing or owned by someone else", async () => {
		const { admitChatTurnStream } = await import("./preflight");
		mocks.getConversation.mockResolvedValue(null);

		const result = await admitChatTurnStream({
			userId: "user-1",
			request: makeRequest(),
		});

		expect(result).toEqual({
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		});
	});

	it("does not run heavy turn-preparation dependencies during admission", async () => {
		const { admitChatTurnStream } = await import("./preflight");

		const result = await admitChatTurnStream({
			userId: "user-1",
			request: makeHeavyRequest(),
		});

		expect(result).toMatchObject({ ok: true });
		expect(mocks.assertPromptReadyAttachments).not.toHaveBeenCalled();
		expect(mocks.addConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mocks.resolvePendingSkillApplication).not.toHaveBeenCalled();
		expect(mocks.resolveReasoningDepthSelection).not.toHaveBeenCalled();
	});
});

describe("prepareAdmittedChatTurn", () => {
	beforeEach(() => {
		resetPreflightMocks();
	});

	it("prepares an admitted stream turn into the eager preflight turn shape", async () => {
		const { admitChatTurnStream, prepareAdmittedChatTurn } = await import(
			"./preflight"
		);
		mocks.resolvePendingSkillApplication.mockResolvedValue({
			ok: true,
			skillId: "skill-1",
			skillOwnership: "user",
			skillKind: "user_skill",
			displayName: "Research Skill",
			envelope:
				'Skill "Research Skill" instructions — apply these for the rest of this turn:\n\nUse the selected research process.',
		});
		const admitted = await admitChatTurnStream({
			userId: "user-1",
			request: makeRequest({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Skill",
				},
			}),
		});
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) return;

		const result = await prepareAdmittedChatTurn({
			userId: "user-1",
			admittedTurn: admitted.value,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				conversationId: "conv-1",
				normalizedMessage: "Compare the migration paths.",
				depthMetadata: {
					requested: "thorough",
					appliedProfile: "extended",
				},
				appliedSkill: {
					skillId: "skill-1",
					skillOwnership: "user",
					skillKind: "user_skill",
					skillDisplayName: "Research Skill",
					instructionsEnvelope: expect.stringContaining(
						"Use the selected research process.",
					),
				},
			},
		});
		expect(mocks.getConversation).toHaveBeenCalledTimes(1);
	});
});

describe("preflightChatTurn", () => {
	beforeEach(() => {
		resetPreflightMocks();
	});

	it("attaches resolved Reasoning Depth metadata to successful preflight turns", async () => {
		const { preflightChatTurn } = await import("./preflight");
		const request = makeRequest();

		const result = await preflightChatTurn({
			userId: "user-1",
			request,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				conversationId: "conv-1",
				depthMetadata: {
					requested: "thorough",
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
				},
				appliedSkill: null,
			},
		});
		expect(mocks.resolveReasoningDepthSelection).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			request: expect.objectContaining({
				normalizedMessage: "Compare the migration paths.",
				reasoningDepth: "thorough",
			}),
		});
	});

	it("forces the resolved skill's instructions into the turn when a pendingSkill is selected", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.resolvePendingSkillApplication.mockResolvedValue({
			ok: true,
			skillId: "skill-1",
			skillOwnership: "user",
			skillKind: "user_skill",
			displayName: "Research Skill",
			envelope:
				'Skill "Research Skill" instructions — apply these for the rest of this turn:\n\nUse the selected research process.',
		});

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Skill",
				},
			}),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				appliedSkill: {
					skillId: "skill-1",
					skillOwnership: "user",
					skillKind: "user_skill",
					skillDisplayName: "Research Skill",
				},
				depthMetadata: {
					requested: "thorough",
					appliedProfile: "extended",
				},
			},
		});
		expect(mocks.resolvePendingSkillApplication).toHaveBeenCalledWith({
			userId: "user-1",
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Research Skill",
			},
			requestText: "Compare the migration paths.",
		});
		// The catalogue still lists the skill this turn, so the forced envelope
		// has to say it is already loaded or the model calls use_skill again.
		const envelope =
			result.ok && result.value.appliedSkill?.instructionsEnvelope;
		expect(envelope).toContain("already loaded for this turn");
		expect(envelope).toContain("do not call use_skill for it");
		expect(envelope).toContain("Use the selected research process.");
	});

	it("rejects the turn when the pending skill is no longer available", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.resolvePendingSkillApplication.mockResolvedValue({ ok: false });

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Skill",
				},
			}),
		});

		expect(result).toEqual({
			ok: false,
			error: {
				status: 409,
				error: "Selected skill is no longer available.",
				code: "pending_skill_unavailable",
			},
		});
	});
});

describe("preflightChatTurn attachment send gate", () => {
	/**
	 * The readiness check classifies and phrases the refusal — it joins the
	 * ledger while it resolves the prompt artifacts. Preflight's job is the
	 * bounded wait and the transport of `code` + `items` to the client, so
	 * these fixtures speak the shape `AttachmentReadinessError` actually has.
	 */
	function readinessError(options: {
		code?: string;
		message?: string;
		attachmentIds?: string[];
		items?: Array<Record<string, unknown>>;
	}) {
		return {
			status: 422,
			message: options.message ?? "One or more attached files are not ready.",
			code: options.code ?? "attachment_not_ready",
			attachmentIds: options.attachmentIds ?? ["attachment-1"],
			items: options.items ?? [],
		};
	}

	function item(overrides: Record<string, unknown> = {}) {
		return {
			artifactId: "attachment-1",
			name: "Budget.pdf",
			status: "parsing",
			errorCode: null,
			retryable: false,
			...overrides,
		};
	}

	function job(overrides: Record<string, unknown> = {}) {
		return {
			id: "job-1",
			sourceArtifactId: "attachment-1",
			normalizedArtifactId: null,
			status: "parsing",
			intakeRoute: "mineru",
			fileName: "Budget.pdf",
			attemptCount: 1,
			maxAttempts: 3,
			retryable: false,
			cancelable: true,
			error: null,
			createdAt: 0,
			updatedAt: 0,
			startedAt: 0,
			legacy: false,
			...overrides,
		};
	}

	function pendingFailure(ids = ["attachment-1"]) {
		return readinessError({
			code: "attachment_extraction_pending",
			message: "Budget.pdf is still being prepared for chat.",
			attachmentIds: ids,
			items: ids.map((id) => item({ artifactId: id })),
		});
	}

	function requestWithAttachments(ids = ["attachment-1"]) {
		return makeRequest({ attachmentIds: ids });
	}

	beforeEach(() => {
		resetPreflightMocks();
		mocks.isAttachmentReadinessError.mockReturnValue(true);
	});

	it("sends without a word when every attachment is ready", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.isAttachmentReadinessError.mockReturnValue(false);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(result.ok).toBe(true);
		expect(mocks.getExtractionJobsForArtifacts).not.toHaveBeenCalled();
		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
	});

	it("waits briefly, then sends when the job settled inside the budget", async () => {
		// The whole point of D5: a file that was 300 ms from done must not cost
		// the user a second press of Send.
		const { preflightChatTurn } = await import("./preflight");
		mocks.assertPromptReadyAttachments
			.mockRejectedValueOnce(pendingFailure())
			.mockResolvedValue(undefined);
		mocks.getExtractionJobsForArtifacts.mockResolvedValue([job()]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(mocks.waitForExtractionJobVerdict).toHaveBeenCalledTimes(1);
		expect(mocks.waitForExtractionJobVerdict).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: expect.any(Number) }),
		);
		expect(result.ok).toBe(true);
	});

	it("answers 422 attachment_extraction_pending when the wait ran out", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.assertPromptReadyAttachments.mockRejectedValue(pendingFailure());
		mocks.getExtractionJobsForArtifacts.mockResolvedValue([
			job({ status: "indexing" }),
		]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(result).toEqual({
			ok: false,
			error: {
				status: 422,
				error: "Budget.pdf is still being prepared for chat.",
				code: "attachment_extraction_pending",
				attachmentIds: ["attachment-1"],
				attachmentExtraction: [
					{
						artifactId: "attachment-1",
						name: "Budget.pdf",
						status: "parsing",
						errorCode: null,
						retryable: false,
					},
				],
			},
		});
		// Pending is not failure: the sentence must not claim the file could
		// not be prepared.
		expect(result.ok === false && result.error.error).toMatch(
			/still being prepared/i,
		);
	});

	it("never waits on a mineru job that has not left the queue", async () => {
		// OQ1: nothing has been handed to a worker yet, so the budget would buy
		// nothing but a delay.
		const { preflightChatTurn } = await import("./preflight");
		mocks.assertPromptReadyAttachments.mockRejectedValue(pendingFailure());
		mocks.getExtractionJobsForArtifacts.mockResolvedValue([
			job({ status: "queued", intakeRoute: "mineru" }),
		]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			error: { code: "attachment_extraction_pending" },
		});
	});

	it("waits on a queued direct-text job, which settles in milliseconds", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.assertPromptReadyAttachments.mockRejectedValue(pendingFailure());
		mocks.getExtractionJobsForArtifacts.mockResolvedValue([
			job({ status: "queued", intakeRoute: "direct-text" }),
		]);

		await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(mocks.waitForExtractionJobVerdict).toHaveBeenCalledTimes(1);
	});

	it("skips the wait entirely for more than five pending attachments", async () => {
		const { preflightChatTurn } = await import("./preflight");
		const ids = Array.from({ length: 6 }, (_, index) => `attachment-${index}`);
		mocks.assertPromptReadyAttachments.mockRejectedValue(pendingFailure(ids));
		mocks.getExtractionJobsForArtifacts.mockResolvedValue(
			ids.map((id) => job({ id: `job-${id}`, sourceArtifactId: id })),
		);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(ids),
		});

		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			error: { code: "attachment_extraction_pending" },
		});
		expect(
			result.ok === false && result.error.attachmentExtraction,
		).toHaveLength(6);
	});

	it("answers 422 attachment_extraction_failed with the code and retryability", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.assertPromptReadyAttachments.mockRejectedValue(
			readinessError({
				code: "attachment_extraction_failed",
				message: "Budget.pdf: we could not read this file.",
				items: [
					item({
						status: "failed",
						errorCode: "max_attempts",
						retryable: true,
					}),
				],
			}),
		);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		// A failure never gets better by waiting, so the gate must not spend
		// the budget on it.
		expect(mocks.getExtractionJobsForArtifacts).not.toHaveBeenCalled();
		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			error: {
				status: 422,
				code: "attachment_extraction_failed",
				attachmentExtraction: [
					{
						artifactId: "attachment-1",
						status: "failed",
						errorCode: "max_attempts",
						retryable: true,
					},
				],
			},
		});
	});

	it("keeps the old refusal for an attachment the ledger knows nothing about", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.assertPromptReadyAttachments.mockRejectedValue(
			readinessError({ message: "Attached file is no longer available." }),
		);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(result).toEqual({
			ok: false,
			error: {
				status: 422,
				error: "Attached file is no longer available.",
				code: "attachment_not_ready",
				attachmentIds: ["attachment-1"],
			},
		});
		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
	});

	it("still refuses honestly when the ledger itself is unreachable", async () => {
		// The wait is the only thing that needs the ledger here; losing it must
		// not turn a pending attachment into a hard failure.
		const { preflightChatTurn } = await import("./preflight");
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mocks.assertPromptReadyAttachments.mockRejectedValue(pendingFailure());
		mocks.getExtractionJobsForArtifacts.mockRejectedValue(
			new Error("ledger down"),
		);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: false,
			error: { status: 422, code: "attachment_extraction_pending" },
		});
		consoleError.mockRestore();
	});

	it("does not wait when an admin has set the budget to zero", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.getExtractionConfig.mockReturnValue({ preflightWaitMs: 0 });
		mocks.assertPromptReadyAttachments.mockRejectedValue(pendingFailure());
		mocks.getExtractionJobsForArtifacts.mockResolvedValue([job()]);

		await preflightChatTurn({
			userId: "user-1",
			request: requestWithAttachments(),
		});

		expect(mocks.waitForExtractionJobVerdict).not.toHaveBeenCalled();
		expect(mocks.assertPromptReadyAttachments).toHaveBeenCalledTimes(1);
	});
});
