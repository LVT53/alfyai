import { describe, expect, it, vi } from "vitest";
import {
	card as imageCard,
	take as imageTake,
} from "$lib/components/artifacts/image/image-card-fixtures.test-helpers";
import type { ComposerMarks } from "$lib/components/chat/composer-pictures";
import type { I18nKey } from "$lib/i18n";
import type { PendingWrite } from "$lib/server/services/connections/pending-write-dto";
import type { ConversationDraft } from "$lib/server/services/conversations";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { PendingAttachment } from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { SkillDraftProposal } from "$lib/server/services/skills/types";
import type { AskAnswer, AskQuestionDto } from "$lib/shared/ask-user";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import {
	addComposerPicture,
	appendTokenChunkToMessageList,
	applyResponseActivityEntryToMessageList,
	applyToolCallUpdateToMessageList,
	arrivalDraftOf,
	attachUnassignedFileProductionJobsToAssistant,
	attachUnassignedPendingWritesToAssistant,
	awaitOpenStepSave,
	buildPendingFileProductionJobPlaceholder,
	cloneSendPayload,
	composerMarksFromSend,
	composerPicturesFromSend,
	composerPlaceholderKey,
	countLaterReplies,
	createAssistantPlaceholder,
	dropPendingFileProductionJobs,
	editResendPictures,
	FILE_LIST_RETRY_DELAYS_MS,
	failPendingFileProductionJobPlaceholder,
	filesWaitingForTheList,
	finalizeStreamingMessageList,
	findLiveDocumentAlfyActivity,
	getWorkspacePresentationAfterDocumentOpen,
	type HeldComposer,
	hasActiveFileProductionJobs,
	isConversationReadOnly,
	isPendingSkillUnavailableError,
	isQuestionOpen,
	joinDraftText,
	joinRestoredPayload,
	liveDocumentAlfyActivityExcluding,
	markPendingSkillUnavailable,
	marksOutdated,
	mergeFileProductionJob,
	patchInstructionSuggestionInMessageList,
	patchSkillDraftInMessageList,
	pictureOrderFromSend,
	type SendPayload,
	shouldHydrateArtifactsOnToolCall,
	shouldHydrateFileProductionJobsOnToolCall,
	shouldPollImageCards,
	toFriendlySendError,
	withinOrNull,
	withQuestionAnswering,
	withQuestionStamped,
} from "./_helpers";

function makeJob(
	id: string,
	status: FileProductionJob["status"],
): FileProductionJob {
	return {
		id,
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: id,
		status,
		stage: null,
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		sourceMode: null,
	};
}

function makeUnassignedJob(
	id: string,
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
	return {
		...makeJob(id, "succeeded"),
		assistantMessageId: null,
		...overrides,
	};
}

function makeUnassignedWrite(
	id: string,
	overrides: Partial<PendingWrite> = {},
): PendingWrite {
	return {
		id,
		conversationId: "conv-1",
		assistantMessageId: null,
		status: "pending",
		provider: "nextcloud",
		createdAt: 1,
		preview: {
			title: id,
			detail: "files.put — /AlfyAI/note.txt",
			reversible: true,
			destructive: false,
			withinAllowlist: true,
			warnings: [],
		},
		...overrides,
	};
}

describe("toFriendlySendError", () => {
	const translate = (key: I18nKey) => `translated:${key}`;

	it("uses localized messages for known stream error codes", () => {
		const error = new Error("Stream error") as Error & { code?: string };
		error.code = "timeout";

		expect(toFriendlySendError(error, translate)).toBe(
			"translated:chat.error.timeout",
		);
	});

	it("maps unknown generation failures to the descriptive backend message", () => {
		expect(toFriendlySendError(new Error("provider down"), translate)).toBe(
			"translated:chat.error.backend",
		);
	});

	it("uses provider-neutral fallback text for unknown generation failures", () => {
		const message = toFriendlySendError(new Error("provider down"));

		expect(message).toContain("model provider");
		expect(message).not.toMatch(/Langflow/i);
	});

	it("maps missing linked source preflight failures to a specific localized message", () => {
		const error = new Error("Linked source is no longer available") as Error & {
			code?: string;
		};
		error.code = "linked_source_not_found";

		expect(toFriendlySendError(error, translate)).toBe(
			"translated:chat.error.linkedSourceNotFound",
		);
	});

	// E2 — every known StreamErrorCode is a plain code -> i18n-key lookup now,
	// not a re-derivation of the same classification via message text.
	it.each([
		["timeout", "chat.error.timeout"],
		["network", "chat.error.network"],
		["backend_failure", "chat.error.backend"],
		["capacity_exceeded", "chat.error.capacity"],
		["file_too_large", "chat.error.fileTooLarge"],
		["message_too_long", "chat.error.messageTooLong"],
		["provider_tool_rounds", "chat.error.providerToolRounds"],
	] as const)("maps the %s code to %s via a direct lookup", (code, key) => {
		const error = new Error("irrelevant message text") as Error & {
			code?: string;
		};
		error.code = code;

		expect(toFriendlySendError(error, translate)).toBe(`translated:${key}`);
	});

	// E2 — the substring fallback (`message.toLowerCase().includes(...)`) is
	// gone: an error with no recognized `code` no longer gets reclassified by
	// scanning its message text for keywords like "network"/"capacity"/"file
	// too large". It always falls through to the generic backend message.
	it("translates a pending send-gate refusal per attachment", () => {
		// The 422 carries the rows; before this the composer echoed the
		// server's English sentence at a Hungarian user.
		const error = new Error(
			"One or more attached files are still being prepared for chat.",
		) as Error & { code?: string; attachmentExtraction?: unknown };
		error.code = "attachment_extraction_pending";
		error.attachmentExtraction = [
			{
				artifactId: "a1",
				name: "scan.pdf",
				status: "parsing",
				errorCode: null,
				retryable: false,
			},
			{
				artifactId: "a2",
				name: "notes.docx",
				status: "indexing",
				errorCode: null,
				retryable: false,
			},
		];

		expect(toFriendlySendError(error, translate)).toBe(
			"scan.pdf: translated:chat.extraction.parsing\n" +
				"notes.docx: translated:chat.extraction.indexing",
		);
	});

	it("names the reason, and points at Retry, for a failed attachment", () => {
		const error = new Error("English sentence") as Error & {
			code?: string;
			attachmentExtraction?: unknown;
		};
		error.code = "attachment_extraction_failed";
		error.attachmentExtraction = [
			{
				artifactId: "a1",
				name: "broken.pdf",
				status: "failed",
				errorCode: "max_attempts",
				retryable: true,
			},
			{
				artifactId: "a2",
				name: "empty.pdf",
				status: "failed",
				errorCode: "empty_result",
				retryable: false,
			},
		];

		expect(toFriendlySendError(error, translate)).toBe(
			"broken.pdf: translated:chat.extraction.failedRetry\n" +
				"empty.pdf: translated:chat.extraction.error.empty_result",
		);
	});

	// The last of the server's English readiness sentences. An
	// `attachment_not_ready` refusal has no ledger row by definition, so the
	// clause above cannot describe it -- it used to reach a Hungarian user
	// as the server's own English.
	it("translates a readiness refusal from its per-attachment reason codes", () => {
		const error = new Error(
			"One or more attached files are no longer available. Remove them and upload again.",
		) as Error & { code?: string; attachmentReadiness?: unknown };
		error.code = "attachment_not_ready";
		error.attachmentReadiness = [
			{ artifactId: "a1", name: "gone.pdf", reason: "not_available" },
			{ artifactId: "a2", name: "thin.txt", reason: "not_text_readable" },
		];

		expect(toFriendlySendError(error, translate)).toBe(
			"gone.pdf: translated:chat.attachmentReadiness.not_available\n" +
				"thin.txt: translated:chat.attachmentReadiness.not_text_readable",
		);
	});

	it("drops a readiness reason it does not recognise rather than printing it", () => {
		// A server newer than this client must never put a raw key, or its own
		// English, in front of a user through this path.
		const error = new Error("Server sentence.") as Error & {
			code?: string;
			attachmentReadiness?: unknown;
		};
		error.code = "attachment_not_ready";
		error.attachmentReadiness = [
			{ artifactId: "a1", name: "x.pdf", reason: "reason_from_the_future" },
		];

		expect(toFriendlySendError(error, translate)).toBe("Server sentence.");
	});

	it("keeps the server sentence when the refusal carries no rows", () => {
		// `attachment_not_ready` from a server that predates the reason codes,
		// and an older server that does not send extraction rows at all.
		const error = new Error(
			"Attached file is no longer available.",
		) as Error & {
			code?: string;
		};
		error.code = "attachment_not_ready";
		expect(toFriendlySendError(error, translate)).toBe(
			"Attached file is no longer available.",
		);

		const pendingWithoutRows = new Error("Still preparing.") as Error & {
			code?: string;
		};
		pendingWithoutRows.code = "attachment_extraction_pending";
		expect(toFriendlySendError(pendingWithoutRows, translate)).toBe(
			"Still preparing.",
		);
	});

	it("does not reclassify an uncoded error by scanning its message text", () => {
		const messages = [
			"network error while reaching example.com",
			"server at capacity right now",
			"file too large for this endpoint",
			"connection timeout somewhere upstream",
		];

		for (const message of messages) {
			expect(toFriendlySendError(new Error(message), translate)).toBe(
				"translated:chat.error.backend",
			);
		}
	});

	it("classifies a browser fetch() TypeError as a network failure via a structured signal, not message text", () => {
		// Browsers throw a plain TypeError (never carrying a `.code`) when
		// fetch() itself fails before reaching the server — this is the one
		// case still classified without a server-provided code, and it keys
		// off `instanceof TypeError` (a structured signal), not prose.
		const error = new TypeError("Failed to fetch");

		expect(toFriendlySendError(error, translate)).toBe(
			"translated:chat.error.network",
		);
	});

	it("never surfaces operator-only instructions in the fallback (no-translate) copy", () => {
		const backendMessage = toFriendlySendError(
			new Error("provider down") as Error & { code?: string },
		);
		const networkError = new Error("dropped") as Error & { code?: string };
		networkError.code = "network";
		const networkMessage = toFriendlySendError(networkError);

		for (const message of [backendMessage, networkMessage]) {
			expect(message).not.toMatch(/provider logs/i);
			expect(message).not.toMatch(/server connection/i);
		}
	});
});

describe("workspace presentation helpers", () => {
	it("defaults new document opens to the docked workspace from chat rows and cards", () => {
		expect(getWorkspacePresentationAfterDocumentOpen("expanded")).toBe(
			"docked",
		);
	});

	it("preserves expanded presentation for document opens initiated inside the workspace", () => {
		expect(
			getWorkspacePresentationAfterDocumentOpen("expanded", {
				preservePresentation: true,
			}),
		).toBe("expanded");
	});
});

describe("send payload helpers", () => {
	it("marks stale pending skills unavailable while preserving the draft payload", () => {
		const error = new Error(
			"Selected skill is no longer available.",
		) as Error & { code?: string };
		error.code = "pending_skill_unavailable";
		const payload = markPendingSkillUnavailable({
			message: "Use this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pendingSkill: {
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Pack variant",
				baseSkillId: "system:pack",
				baseSkillDisplayName: "Pack",
			},
		});

		expect(isPendingSkillUnavailableError(error)).toBe(true);
		expect(payload).toEqual(
			expect.objectContaining({
				message: "Use this",
				pendingSkill: expect.objectContaining({
					id: "variant-1",
					skillKind: "skill_variant",
					baseSkillDisplayName: "Pack",
					unavailable: true,
				}),
			}),
		);
	});

	it("clones normal queued turns without removed research fields", () => {
		const removedDepthKey = ["deep", "Research", "Depth"].join("");
		const cloned = cloneSendPayload({
			message: "Summarize battery recycling",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			conversationId: "conv-1",
			forceWebSearch: true,
		});

		expect(cloned).toEqual(
			expect.objectContaining({
				message: "Summarize battery recycling",
				forceWebSearch: true,
			}),
		);
		expect(cloned).not.toHaveProperty(removedDepthKey);
	});

	it("preserves enabledConnectionCapabilities on cloned queued turns (Issue 7.2)", () => {
		const cloned = cloneSendPayload({
			message: "What's on my calendar?",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			conversationId: "conv-1",
			enabledConnectionCapabilities: ["files", "calendar"],
		});

		expect(cloned.enabledConnectionCapabilities).toEqual(["files", "calendar"]);
	});
});

describe("Skill Draft message helpers", () => {
	function makeSkillDraft(
		overrides: Partial<SkillDraftProposal> = {},
	): SkillDraftProposal {
		return {
			id: "draft-1",
			status: "proposed",
			displayName: "Meeting critic",
			description: "Review meeting notes.",
			instructions: "Find missing owners.",
			activationExamples: [],
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			...overrides,
		};
	}

	it("patches the matching assistant Skill Draft without replacing unrelated messages", () => {
		const userMessage: ChatMessage = {
			id: "user-1",
			role: "user",
			content: "Review this.",
			timestamp: 1,
		};
		const assistantMessage: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "I can make this reusable.",
			timestamp: 2,
			skillDrafts: [makeSkillDraft()],
		};
		const updatedDraft = makeSkillDraft({ status: "saved" });

		expect(
			patchSkillDraftInMessageList([userMessage, assistantMessage], {
				messageId: "assistant-1",
				draft: updatedDraft,
			}),
		).toEqual([
			userMessage,
			{
				...assistantMessage,
				skillDrafts: [updatedDraft],
			},
		]);
	});

	it("does not patch a same-id draft on a different assistant message", () => {
		const firstMessage: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "First",
			timestamp: 1,
			skillDrafts: [makeSkillDraft()],
		};
		const secondMessage: ChatMessage = {
			id: "assistant-2",
			role: "assistant",
			content: "Second",
			timestamp: 2,
			skillDrafts: [makeSkillDraft()],
		};
		const updatedDraft = makeSkillDraft({ status: "dismissed" });

		expect(
			patchSkillDraftInMessageList([firstMessage, secondMessage], {
				messageId: "assistant-2",
				draft: updatedDraft,
			}),
		).toEqual([
			firstMessage,
			{
				...secondMessage,
				skillDrafts: [updatedDraft],
			},
		]);
	});
});

describe("countLaterReplies", () => {
	const turn = (n: number) => [
		{ id: `u${n}`, role: "user" as const },
		{ id: `a${n}`, role: "assistant" as const },
	];

	it("counts the replies after the edited message's own", () => {
		const list = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];

		expect(countLaterReplies(list, "u1")).toBe(3);
		expect(countLaterReplies(list, "u2")).toBe(2);
		expect(countLaterReplies(list, "u3")).toBe(1);
	});

	it("is 0 for the last turn: only its own reply goes, and that one comes back", () => {
		const list = [...turn(1), ...turn(2)];

		expect(countLaterReplies(list, "u2")).toBe(0);
	});

	it("is never below 0 when the edited message has no reply yet", () => {
		const list = [...turn(1), { id: "u2", role: "user" as const }];

		expect(countLaterReplies(list, "u2")).toBe(0);
	});

	it("does not count the person's own later messages, only replies", () => {
		const list = [
			...turn(1),
			{ id: "u2", role: "user" as const },
			{ id: "u3", role: "user" as const },
			{ id: "a3", role: "assistant" as const },
		];

		expect(countLaterReplies(list, "u1")).toBe(1);
	});

	it("counts every reply after a message that never got one of its own", () => {
		// A failed turn leaves its message without a reply, and the person asks
		// again: editing the failed one deletes that next answer too.
		const list = [{ id: "u1", role: "user" as const }, ...turn(2)];

		expect(countLaterReplies(list, "u1")).toBe(1);
	});

	it("is 0 for a message the list does not hold", () => {
		expect(countLaterReplies([...turn(1), ...turn(2)], "missing")).toBe(0);
	});
});

describe("Ask me first: the page's question helpers", () => {
	const OWN_WORDS: AskAnswer = {
		kind: "answered",
		answers: [{ picked: [], ownWords: "Somewhere by the lake" }],
	};

	function askedQuestion(
		overrides: Partial<AskQuestionDto> = {},
	): AskQuestionDto {
		return {
			id: "q-1",
			conversationId: "conv-1",
			assistantMessageId: "a-1",
			toolCallId: "call-ask-1",
			questions: [
				{
					question: "Which way should we take it?",
					options: [
						{ label: "A party at home", recommended: true },
						{ label: "Dinner out" },
					],
				},
			],
			status: "waiting",
			answer: null,
			createdAt: 1_000,
			...overrides,
		};
	}

	it("opens a waiting question and gives the composer back while its answer is out", () => {
		const waiting = askedQuestion();

		expect(isQuestionOpen([], {})).toBe(false);
		expect(isQuestionOpen([waiting], {})).toBe(true);
		// The answer is out: the person may queue a message behind the resume, and
		// the page's guards are the running turn's from there.
		expect(isQuestionOpen([waiting], { "q-1": { busy: true } })).toBe(false);
		// It did not go through: busy came off, the question waits again, and is open.
		expect(isQuestionOpen([waiting], { "q-1": { busy: false } })).toBe(true);
		// Only that question's own state counts.
		expect(isQuestionOpen([waiting], { "q-2": { busy: true } })).toBe(true);
		// Not before its segment is saved: the stream that asked it still runs, and if it
		// fails before it pauses the question is never saved, which must not leave the
		// box off with no card to answer.
		expect(
			isQuestionOpen([askedQuestion({ assistantMessageId: null })], {}),
		).toBe(false);
		// A question that no longer waits holds nothing back.
		for (const status of ["answering", "answered", "closed"] as const) {
			expect(isQuestionOpen([askedQuestion({ status })], {})).toBe(false);
		}
		// One open question is enough.
		expect(
			isQuestionOpen(
				[askedQuestion({ id: "q-0", status: "answered" }), waiting],
				{},
			),
		).toBe(true);
	});

	it("folds a question locally once its answer is accepted, and wakes it once stamped", () => {
		const unstamped = askedQuestion({ assistantMessageId: null });
		const other = askedQuestion({ id: "q-2", assistantMessageId: "a-2" });

		// The pause says which saved row asked: the card wakes (a card is off until its
		// segment is saved). Nothing else changes, and the list it came from is not touched.
		const stamped = withQuestionStamped([unstamped, other], "q-1", "a-1");
		expect(stamped).toEqual([
			{ ...unstamped, assistantMessageId: "a-1" },
			other,
		]);
		expect(stamped[1]).toBe(other);
		expect(unstamped.assistantMessageId).toBeNull();
		// A stamp the server already gave stays, and a question the list lacks is no one's.
		const alreadyStamped = askedQuestion({ assistantMessageId: "a-1" });
		expect(withQuestionStamped([alreadyStamped], "q-1", "a-9")[0]).toBe(
			alreadyStamped,
		);
		expect(withQuestionStamped([other], "q-1", "a-1")).toEqual([other]);

		// The answer is taken up: the question is answering, with the answer given, which
		// is what its folded line shows until the page reads it again.
		const folded = withQuestionAnswering(stamped, "q-1", OWN_WORDS);
		expect(folded[0]).toEqual({
			...stamped[0],
			status: "answering",
			answer: OWN_WORDS,
		});
		expect(folded[1]).toBe(other);
		expect(stamped[0].status).toBe("waiting");
		// A question that is answered already is not taken back to answering.
		const answered = askedQuestion({ status: "answered", answer: OWN_WORDS });
		expect(withQuestionAnswering([answered], "q-1", OWN_WORDS)[0]).toBe(
			answered,
		);
		expect(withQuestionAnswering([other], "q-9", OWN_WORDS)).toEqual([other]);
	});
});

describe("conversation read-only helpers", () => {
	it("treats sealed conversations as read-only for chat input", () => {
		expect(isConversationReadOnly({ status: "sealed" })).toBe(true);
		expect(isConversationReadOnly({ status: "open" })).toBe(false);
		expect(isConversationReadOnly({ status: undefined })).toBe(false);
	});
});

describe("file production chat helpers", () => {
	it("detects only queued and running jobs as active polling candidates", () => {
		expect(hasActiveFileProductionJobs([makeJob("queued", "queued")])).toBe(
			true,
		);
		expect(hasActiveFileProductionJobs([makeJob("running", "running")])).toBe(
			true,
		);
		expect(
			hasActiveFileProductionJobs([
				makeJob("succeeded", "succeeded"),
				makeJob("failed", "failed"),
				makeJob("cancelled", "cancelled"),
			]),
		).toBe(false);
	});

	describe("a file the chat shows a card for that is not yet in the panel's list", () => {
		const NOW = 1_000_000;
		const madeFile = (artifactId: string | null) => ({
			id: `file-${artifactId ?? "none"}`,
			filename: "plan.pdf",
			mimeType: "application/pdf",
			sizeBytes: 100,
			downloadUrl: "/api/chat/files/file-1/download",
			previewUrl: null,
			artifactId,
		});
		const done = (
			overrides: Partial<FileProductionJob> = {},
		): FileProductionJob => ({
			...makeJob("job-1", "succeeded"),
			updatedAt: NOW - 5_000,
			files: [madeFile("artifact-1")],
			...overrides,
		});

		it("waits for a succeeded job of a reply whose file is not a row yet", () => {
			expect(filesWaitingForTheList([done()], new Set(), NOW)).toBe(true);
		});

		it("is done once the list has the file, or the reader deleted it", () => {
			expect(
				filesWaitingForTheList([done()], new Set(["artifact-1"]), NOW),
			).toBe(false);
		});

		it("does not wait for a job that is still running, failed, or belongs to no reply", () => {
			expect(
				filesWaitingForTheList([done({ status: "running" })], new Set(), NOW),
			).toBe(false);
			expect(
				filesWaitingForTheList([done({ status: "failed" })], new Set(), NOW),
			).toBe(false);
			// An export, and any job the server has not given to a reply: listed nowhere by design.
			expect(
				filesWaitingForTheList(
					[done({ assistantMessageId: null })],
					new Set(),
					NOW,
				),
			).toBe(false);
		});

		it("does not wait for a dismissed job, a deleted file or a file with no row of its own", () => {
			expect(
				filesWaitingForTheList([done({ dismissed: true })], new Set(), NOW),
			).toBe(false);
			expect(
				filesWaitingForTheList(
					[done({ filesDeleted: { canRegenerate: true } })],
					new Set(),
					NOW,
				),
			).toBe(false);
			expect(
				filesWaitingForTheList(
					[done({ files: [madeFile(null)] })],
					new Set(),
					NOW,
				),
			).toBe(false);
		});

		it("does not make the page ask on every visit about an old job", () => {
			expect(
				filesWaitingForTheList(
					[done({ updatedAt: NOW - 10 * 60_000 })],
					new Set(),
					NOW,
				),
			).toBe(false);
		});

		it("asks soon, then less often, and stops", () => {
			expect(FILE_LIST_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(500);
			expect([...FILE_LIST_RETRY_DELAYS_MS]).toEqual(
				[...FILE_LIST_RETRY_DELAYS_MS].sort((a, b) => a - b),
			);
			const total = FILE_LIST_RETRY_DELAYS_MS.reduce(
				(sum, delay) => sum + delay,
				0,
			);
			expect(total).toBeGreaterThanOrEqual(10_000);
			expect(total).toBeLessThanOrEqual(30_000);
		});
	});

	it("merges an updated job into the existing chat state without duplicating cards", () => {
		const current = [makeJob("job-1", "running"), makeJob("job-2", "queued")];
		const merged = mergeFileProductionJob(current, {
			...makeJob("job-1", "failed"),
			error: {
				code: "renderer_timeout",
				message: "Renderer timed out.",
				retryable: true,
			},
		});

		expect(merged).toHaveLength(2);
		expect(merged[0]).toMatchObject({
			id: "job-1",
			status: "failed",
			error: {
				code: "renderer_timeout",
			},
		});
		expect(merged[1].id).toBe("job-2");
	});

	it("hydrates file-production jobs once the produce_file tool call has created a job", () => {
		expect(
			shouldHydrateFileProductionJobsOnToolCall("produce_file", "done"),
		).toBe(true);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("file_production", "done"),
		).toBe(true);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("produce_file", "running"),
		).toBe(false);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("web_search", "done"),
		).toBe(false);
	});

	it("also hydrates on a completed connection tool call (Issue 7.5 — picks up a mid-turn pending write)", () => {
		expect(shouldHydrateFileProductionJobsOnToolCall("files", "done")).toBe(
			true,
		);
		expect(shouldHydrateFileProductionJobsOnToolCall("calendar", "done")).toBe(
			true,
		);
		expect(shouldHydrateFileProductionJobsOnToolCall("email", "done")).toBe(
			true,
		);
		expect(shouldHydrateFileProductionJobsOnToolCall("photos", "done")).toBe(
			true,
		);
		expect(shouldHydrateFileProductionJobsOnToolCall("files", "running")).toBe(
			false,
		);
	});

	// E1/E2 — "failed" also concludes the call (same as "done"): the
	// conversation still needs re-hydrating so a failed job/write shows up.
	it("also hydrates on a failed produce_file or connection tool call", () => {
		expect(
			shouldHydrateFileProductionJobsOnToolCall("produce_file", "failed"),
		).toBe(true);
		expect(shouldHydrateFileProductionJobsOnToolCall("files", "failed")).toBe(
			true,
		);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("web_search", "failed"),
		).toBe(false);
	});

	// Wave 2.5 review (F2): the in-chat card's version/pending-review pill
	// went stale after a live edit because nothing hydrated `artifacts` on a
	// create_artifact/edit_artifact call — see shouldHydrateArtifactsOnToolCall's
	// own doc comment.
	it("hydrates on a concluded make_image call, so its card shows the landed picture as the reply says so", () => {
		expect(shouldHydrateArtifactsOnToolCall("make_image", "done")).toBe(true);
		expect(shouldHydrateArtifactsOnToolCall("make_image", "running")).toBe(
			false,
		);
	});

	it("hydrates on a concluded create_artifact/edit_artifact call, and no other tool", () => {
		expect(shouldHydrateArtifactsOnToolCall("create_artifact", "done")).toBe(
			true,
		);
		expect(shouldHydrateArtifactsOnToolCall("edit_artifact", "done")).toBe(
			true,
		);
		expect(shouldHydrateArtifactsOnToolCall("edit_artifact", "failed")).toBe(
			true,
		);
		expect(shouldHydrateArtifactsOnToolCall("create_artifact", "running")).toBe(
			false,
		);
		expect(shouldHydrateArtifactsOnToolCall("produce_file", "done")).toBe(
			false,
		);
		expect(shouldHydrateArtifactsOnToolCall("web_search", "done")).toBe(false);
	});

	// Item 6 (UX-speed plan) — a produce_file tool call shows a "queued"
	// FileProductionCard the instant it starts, via a client-only
	// placeholder job built here and adopted into the same fileProduction-
	// Jobs array real jobs live in (see +page.svelte's addFileProduction-
	// JobPlaceholder / failFileProductionJobPlaceholder adapters).
	describe("produce_file placeholder job", () => {
		it("builds a queued placeholder titled from the tool input", () => {
			const job = buildPendingFileProductionJobPlaceholder({
				id: "pending:call-1",
				conversationId: "conv-1",
				input: { requestTitle: "Quarterly report" },
				now: 1000,
			});

			expect(job).toMatchObject({
				id: "pending:call-1",
				conversationId: "conv-1",
				assistantMessageId: null,
				title: "Quarterly report",
				status: "queued",
				createdAt: 1000,
				updatedAt: 1000,
				files: [],
				warnings: [],
				dismissed: false,
			});
		});

		it("falls back from requestTitle to title to filename, then a generic label", () => {
			expect(
				buildPendingFileProductionJobPlaceholder({
					id: "pending:1",
					conversationId: "conv-1",
					input: { title: "Draft" },
					now: 1,
				}).title,
			).toBe("Draft");
			expect(
				buildPendingFileProductionJobPlaceholder({
					id: "pending:2",
					conversationId: "conv-1",
					input: { filename: "report.pdf" },
					now: 1,
				}).title,
			).toBe("report.pdf");
			expect(
				buildPendingFileProductionJobPlaceholder({
					id: "pending:3",
					conversationId: "conv-1",
					input: {},
					now: 1,
				}).title,
			).toBe("Preparing your file…");
		});

		it("prefers a translated fallback title when a translate function is given", () => {
			const job = buildPendingFileProductionJobPlaceholder({
				id: "pending:1",
				conversationId: "conv-1",
				input: {},
				now: 1,
				translate: (key: I18nKey) =>
					key === "fileProduction.placeholderTitle" ? "Előkészítés…" : key,
			});

			expect(job.title).toBe("Előkészítés…");
		});

		it("turns a placeholder into a non-retryable failed job", () => {
			const placeholder = buildPendingFileProductionJobPlaceholder({
				id: "pending:call-1",
				conversationId: "conv-1",
				input: { title: "Report" },
				now: 1000,
			});

			const failed = failPendingFileProductionJobPlaceholder(placeholder, {
				message: "Renderer timed out",
				now: 2000,
			});

			expect(failed).toMatchObject({
				id: "pending:call-1",
				status: "failed",
				updatedAt: 2000,
				error: {
					code: "tool_failed",
					message: "Renderer timed out",
					retryable: false,
				},
			});
		});

		it("falls back to a generic message when the tool call carries none", () => {
			const placeholder = buildPendingFileProductionJobPlaceholder({
				id: "pending:call-1",
				conversationId: "conv-1",
				input: {},
				now: 1000,
			});

			const failed = failPendingFileProductionJobPlaceholder(placeholder, {
				message: null,
				now: 2000,
			});

			expect(failed.error?.message).toBe(
				"The file request failed before it could start.",
			);
		});

		it("drops every pending-prefixed job, leaving real jobs untouched", () => {
			const jobs = [
				buildPendingFileProductionJobPlaceholder({
					id: "pending:call-1",
					conversationId: "conv-1",
					input: {},
					now: 1,
				}),
				makeJob("job-1", "succeeded"),
			];

			expect(dropPendingFileProductionJobs(jobs)).toEqual([jobs[1]]);
		});
	});

	it("keeps produce_file events out of visible thinking segments", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "produce_file",
			input: { requestTitle: "Quarterly report" },
			status: "running",
		});
		const done = applyToolCallUpdateToMessageList(running, {
			placeholderId: "assistant-1",
			name: "produce_file",
			input: {},
			status: "done",
		});

		expect(done[0].thinkingSegments).toBeUndefined();
	});

	it("merges response activity entries by id without capping the row count", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const withRows = Array.from({ length: 12 }, (_, index) => ({
			id: `activity-${index}`,
			kind: "context" as const,
			status: "running" as const,
			detail: `Context ${index}`,
		})).reduce(
			(current, entry) =>
				applyResponseActivityEntryToMessageList(current, "assistant-1", entry),
			list,
		);

		const updated = applyResponseActivityEntryToMessageList(
			withRows,
			"assistant-1",
			{
				id: "activity-5",
				kind: "context",
				status: "done",
				detail: "Context ready",
			},
		);

		expect(updated[0].responseActivity).toHaveLength(12);
		expect(updated[0].responseActivity?.[5]).toMatchObject({
			id: "activity-5",
			status: "done",
			detail: "Context ready",
		});
	});

	it("preserves sanitized context preparation classes when placeholder activity updates merge", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyResponseActivityEntryToMessageList(
			list,
			"assistant-1",
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "context-retrieval",
			},
		);
		const updated = applyResponseActivityEntryToMessageList(
			running,
			"assistant-1",
			{
				id: "context-preparing",
				kind: "context",
				status: "running",
				count: 2,
			},
		);

		expect(updated[0].responseActivity).toEqual([
			expect.objectContaining({
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "context-retrieval",
				count: 2,
			}),
		]);
	});

	it("projects existing tool-call events into live tool and source activity rows", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1", sourceType: "web" },
		});
		const done = applyToolCallUpdateToMessageList(running, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: {},
			status: "done",
			details: {
				callId: "tool-call-1",
				sourceType: "web",
				outputSummary: "Found 3 sources",
				candidates: [
					{
						id: "source-1",
						title: "SvelteKit docs",
						url: "https://svelte.dev/docs/kit",
						sourceType: "web",
					},
					{
						id: "source-2",
						title: "Svelte docs",
						url: "https://svelte.dev/docs/svelte",
						sourceType: "web",
					},
					{
						id: "source-3",
						title: "Vitest docs",
						url: "https://vitest.dev",
						sourceType: "web",
					},
				],
			},
		});

		expect(done[0].responseActivity).toEqual([
			expect.objectContaining({
				id: "tool:tool-call-1",
				kind: "tool",
				status: "done",
				toolName: "research_web",
				sourceType: "web",
				detail: "Found 3 sources",
			}),
			expect.objectContaining({
				id: "source:tool-call-1:source-1",
				kind: "source",
				status: "done",
				title: "SvelteKit docs",
				url: "https://svelte.dev/docs/kit",
			}),
			expect.objectContaining({
				id: "source:tool-call-1:source-2",
				kind: "source",
				status: "done",
				title: "Svelte docs",
				url: "https://svelte.dev/docs/svelte",
			}),
			expect.objectContaining({
				id: "source:tool-call-1:source-3",
				kind: "source",
				status: "done",
				title: "Vitest docs",
				url: "https://vitest.dev",
			}),
		]);
	});

	it("keeps non-file tool calls visible in thinking segments", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const updated = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "web_search",
			input: { query: "Svelte docs" },
			status: "running",
		});

		expect(updated[0].thinkingSegments).toEqual([
			{
				type: "tool_call",
				name: "web_search",
				input: { query: "Svelte docs" },
				status: "running",
			},
		]);
	});

	it("coalesces duplicate running tool-call updates with the same call id", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const firstRunning = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1" },
		});
		const duplicateRunning = applyToolCallUpdateToMessageList(firstRunning, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1" },
		});
		const done = applyToolCallUpdateToMessageList(duplicateRunning, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: {},
			status: "done",
			details: {
				callId: "tool-call-1",
				sourceType: "web",
				outputSummary: "Found sources",
			},
		});

		expect(done[0].thinkingSegments).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				type: "tool_call",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
	});

	// E1/E2 — "failed" is a genuine terminal outcome distinct from "done": the
	// running segment must transition to "failed", not get collapsed into
	// "done" the way it did before E1 widened ToolCallEntry/ThinkingSegment.
	it("transitions a running tool call to failed status, distinct from done", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1" },
		});
		const failed = applyToolCallUpdateToMessageList(running, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: {},
			status: "failed",
			details: {
				callId: "tool-call-1",
				metadata: { errorCode: "network" },
			},
		});

		expect(failed[0].thinkingSegments).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				type: "tool_call",
				name: "research_web",
				status: "failed",
				metadata: { errorCode: "network" },
			}),
		]);
		expect(failed[0].responseActivity).toEqual([
			expect.objectContaining({
				id: "tool:tool-call-1",
				kind: "tool",
				status: "error",
			}),
		]);
	});

	it("closes stale running tool rows when the stream finalizes", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
		});

		const finalized = finalizeStreamingMessageList(running, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].thinkingSegments).toEqual([
			expect.objectContaining({
				type: "tool_call",
				name: "research_web",
				status: "done",
			}),
		]);
	});

	// E1/E2 — completionWarningCodes ride data-stream-metadata and must land on
	// the finalized message even when the body is empty (truncation /
	// content-filter), so MessageBubble has something to show instead of a
	// silent blank response.
	it("carries completionWarningCodes onto the finalized message, even with an empty body", () => {
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				completionWarningCodes: ["output_truncated"],
			},
		});

		expect(finalized[0].content).toBe("");
		expect(finalized[0].completionWarningCodes).toEqual(["output_truncated"]);
	});

	// P3d (ADR-0056) — the terminal data-stream-metadata frame now also
	// carries thoughtSteps (mirroring completionWarningCodes above), so the
	// completed step-rail populates in the same session, without a reload.
	it("carries thoughtSteps onto the finalized message at completion, without a reload", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const thoughtSteps = [
			{
				id: "step-1",
				source: "classified" as const,
				activityClass: "understanding-request",
				impliesExternalAction: false,
				anchor: { start: 0, end: 12 },
				createdAt: 1000,
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				thoughtSteps,
			},
		});

		expect(finalized[0].thoughtSteps).toEqual(thoughtSteps);
	});

	it("falls back to the message's prior thoughtSteps when the terminal frame carries none", () => {
		const priorThoughtSteps = [
			{
				id: "step-1",
				source: "classified" as const,
				activityClass: "understanding-request",
				impliesExternalAction: false,
				anchor: { start: 0, end: 12 },
				createdAt: 1000,
			},
		];
		const list = [
			{
				...createAssistantPlaceholder("assistant-1"),
				thoughtSteps: priorThoughtSteps,
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].thoughtSteps).toEqual(priorThoughtSteps);
	});

	// Owner idea (variant A) — the terminal data-stream-metadata frame also
	// carries followUps (mirroring thoughtSteps above), so the action row's
	// chips populate in the same session, without a reload.
	it("carries followUps onto the finalized message at completion, without a reload", () => {
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				followUps: ["What about the sequel?", "Any similar examples?"],
			},
		});

		expect(finalized[0].followUps).toEqual([
			"What about the sequel?",
			"Any similar examples?",
		]);
	});

	// The Info popover's instruction row reads this same record, so it also
	// rides the terminal frame — otherwise the row would only appear after a
	// reload, which is exactly when the reader is no longer asking why.
	it("carries instructionsApplied onto the finalized message at completion, without a reload", () => {
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				instructionsApplied: { personal: true, projectId: "project-1" },
			},
		});

		expect(finalized[0].instructionsApplied).toEqual({
			personal: true,
			projectId: "project-1",
		});
	});

	// Slice F — the model tells the user in prose that it offered a standing
	// instruction, so the Review/Dismiss row has to be there in the session that
	// produced it. The frame is built from the same tool-call records finalize
	// persists the row from (stream-completion.ts), so the live row and the
	// reloaded one cannot disagree.
	it("carries instructionSuggestions onto the finalized message at completion, without a reload", () => {
		const suggestion = makeSuggestion();
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				instructionSuggestions: [suggestion],
			},
		});

		expect(finalized[0].instructionSuggestions).toEqual([suggestion]);
	});

	it("leaves the finalized message with no instructionSuggestions when the turn offered none", () => {
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].instructionSuggestions).toBeUndefined();
	});

	// A drafting turn shows the Skill Draft Card instead of the standing-
	// instruction row, and the card has to be on screen in the session that
	// produced it: the terminal frame carries the drafts the same way it
	// carries instructionSuggestions (stream-completion.ts), and the server
	// sends no offer on a drafting turn, so the two never appear together.
	it("carries skillDrafts onto the finalized message at completion, without a reload", () => {
		const draft: SkillDraftProposal = {
			id: "draft-1",
			status: "proposed",
			displayName: "Weekly status",
			description: "Writes a short weekly status update.",
			instructions: "Ask for the period, then write one paragraph.",
			activationExamples: ["Write my weekly status."],
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
		};
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				skillDrafts: [draft],
			},
		});

		expect(finalized[0].skillDrafts).toEqual([draft]);
	});

	it("falls back to the message's prior followUps when the terminal frame carries none", () => {
		const priorFollowUps = ["What about the sequel?"];
		const list = [
			{
				...createAssistantPlaceholder("assistant-1"),
				followUps: priorFollowUps,
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].followUps).toEqual(priorFollowUps);
	});

	// The user's per-turn choices (see $lib/message-user-intent.ts) — a terminal
	// frame that names the persisted assistant message is the server's complete
	// statement and replaces the optimistic record outright; only a frame-less
	// finalize keeps what the placeholder was stamped with at send.
	it("takes the terminal frame's userIntent over the optimistic one", () => {
		const list = [
			{
				...createAssistantPlaceholder("assistant-1"),
				userIntent: { skill: { id: "skill-1", displayName: "invoice" } },
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				userIntent: {
					skill: { id: "skill-1", displayName: "Invoice reply" },
					webSearch: true,
				},
			},
		});

		expect(finalized[0].userIntent).toEqual({
			skill: { id: "skill-1", displayName: "Invoice reply" },
			webSearch: true,
		});
	});

	// A regenerate stamps its placeholder with the record of the message it
	// replaces, and the server silently drops a recorded skill that no longer
	// resolves (services/chat-turn/retry.ts). The terminal frame then carries no
	// record at all, and the inherited chip has to go with it — otherwise the
	// finished answer claims a skill that was never applied.
	it("clears the optimistic userIntent when the terminal frame carries none", () => {
		const list = [
			{
				...createAssistantPlaceholder("assistant-1"),
				userIntent: { skill: { id: "skill-1", displayName: "Meeting critic" } },
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].userIntent).toBeUndefined();
	});

	// The same regenerate, but the user had also forced `/web`: that survives,
	// so the frame carries the smaller record and only the skill chip goes.
	it("takes a smaller terminal-frame record over the inherited one", () => {
		const list = [
			{
				...createAssistantPlaceholder("assistant-1"),
				userIntent: {
					skill: { id: "skill-1", displayName: "Meeting critic" },
					webSearch: true as const,
				},
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				userIntent: { webSearch: true },
			},
		});

		expect(finalized[0].userIntent).toEqual({ webSearch: true });
	});

	// No terminal frame reached the client (dropped stream), so there is nothing
	// authoritative to replace the optimistic stamp with.
	it("keeps the optimistic userIntent when no terminal frame arrives", () => {
		const list = [
			{
				...createAssistantPlaceholder("assistant-1"),
				userIntent: { webSearch: true as const },
			},
		];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
		});

		expect(finalized[0].userIntent).toEqual({ webSearch: true });
	});

	// Finding 4 (web-citation auto-repair) — the raw model text was already
	// streamed into the bubble, so the terminal frame carries the repaired,
	// persisted text as `finalContent` and it replaces what was streamed.
	it("replaces the streamed text with the terminal frame's repaired finalContent", () => {
		const list = appendTokenChunkToMessageList(
			[createAssistantPlaceholder("assistant-1")],
			"assistant-1",
			"See [wrong page](https://example.com/product/old).",
		);

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				finalContent: "See [wrong page](https://example.com/product/price).",
			},
		});

		expect(finalized[0].content).toBe(
			"See [wrong page](https://example.com/product/price).",
		);
	});

	it("keeps the streamed text when the terminal frame carries no finalContent", () => {
		const list = appendTokenChunkToMessageList(
			[createAssistantPlaceholder("assistant-1")],
			"assistant-1",
			"See [official page](https://example.com/product).",
		);

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].content).toBe(
			"See [official page](https://example.com/product).",
		);
	});

	it("clears live response activity when the streaming placeholder finalizes", () => {
		const list = applyResponseActivityEntryToMessageList(
			[createAssistantPlaceholder("assistant-1")],
			"assistant-1",
			{
				id: "drafting",
				kind: "drafting",
				status: "running",
			},
		);

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].responseActivity).toBeUndefined();
	});

	it("copies streamed Depth Metadata onto the finalized assistant message", () => {
		const list = [createAssistantPlaceholder("assistant-placeholder")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-placeholder",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				depthMetadata: {
					requested: "thorough",
					appliedProfile: "maximum",
					fallback: false,
					modelId: "model1",
					modelDisplayName: "Model 1",
				},
			},
		});

		expect(finalized[0]).toMatchObject({
			id: "server-assistant-1",
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model 1",
			},
		});
	});

	// stopped-marker — a stopped response must carry wasStopped into the LIVE
	// session's finalized message, not just after a reload (server persistence
	// already round-trips it; this closes the gap for the current tab).
	it("marks the finalized message as wasStopped when the terminal metadata says the stream stopped early", () => {
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				wasStopped: true,
			},
		});

		expect(finalized[0].wasStopped).toBe(true);
	});

	it("leaves wasStopped unset on the finalized message for a normally completed stream", () => {
		const list = [createAssistantPlaceholder("assistant-1")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
			},
		});

		expect(finalized[0].wasStopped).toBeUndefined();
	});

	it("keeps newly produced files attached when the streaming placeholder becomes the server assistant message", () => {
		const jobs = [
			makeUnassignedJob("job-new"),
			makeUnassignedJob("job-other-conversation", { conversationId: "conv-2" }),
			makeJob("job-existing", "succeeded"),
		];

		const attached = attachUnassignedFileProductionJobsToAssistant(jobs, {
			conversationId: "conv-1",
			assistantMessageId: "assistant-server",
		});

		expect(attached).toEqual([
			expect.objectContaining({
				id: "job-new",
				assistantMessageId: "assistant-server",
			}),
			expect.objectContaining({
				id: "job-other-conversation",
				assistantMessageId: null,
			}),
			expect.objectContaining({
				id: "job-existing",
				assistantMessageId: "assistant-1",
			}),
		]);
	});

	// Friction audit F1: every job of the conversation that hung from no reply was
	// stamped on the reply that finished, so a job an earlier Download had left came
	// back as a card of a reply that never made it. The turn's own jobs are the ones
	// made since it began.
	it("stamps only the jobs made since the turn began, never one that hung from no reply before it", () => {
		const turnBegan = 1_000_000;
		const jobs = [
			makeUnassignedJob("job-before-the-turn", {
				createdAt: turnBegan - 60_000,
			}),
			makeUnassignedJob("job-this-turn", { createdAt: turnBegan + 2_000 }),
		];

		const attached = attachUnassignedFileProductionJobsToAssistant(jobs, {
			conversationId: "conv-1",
			assistantMessageId: "assistant-server",
			createdSince: turnBegan - 30_000,
		});

		expect(attached).toEqual([
			expect.objectContaining({
				id: "job-before-the-turn",
				assistantMessageId: null,
			}),
			expect.objectContaining({
				id: "job-this-turn",
				assistantMessageId: "assistant-server",
			}),
		]);
	});

	it("keeps a newly proposed pending write attached when the streaming placeholder becomes the server assistant message (Issue 7.5)", () => {
		const writes = [
			makeUnassignedWrite("pw-new"),
			makeUnassignedWrite("pw-other-conversation", {
				conversationId: "conv-2",
			}),
			makeUnassignedWrite("pw-already-assigned", {
				assistantMessageId: "assistant-1",
			}),
		];

		const attached = attachUnassignedPendingWritesToAssistant(writes, {
			conversationId: "conv-1",
			assistantMessageId: "assistant-server",
		});

		expect(attached).toEqual([
			expect.objectContaining({
				id: "pw-new",
				assistantMessageId: "assistant-server",
			}),
			expect.objectContaining({
				id: "pw-other-conversation",
				assistantMessageId: null,
			}),
			expect.objectContaining({
				id: "pw-already-assigned",
				assistantMessageId: "assistant-1",
			}),
		]);
	});
});

function makeSuggestion(
	overrides: Partial<InstructionSuggestion> = {},
): InstructionSuggestion {
	return {
		id: "suggestion-1",
		status: "pending",
		text: "Only suggest trains, no flights.",
		scope: { kind: "personal" },
		createdAt: 1_770_000_000_000,
		...overrides,
	};
}

describe("patchInstructionSuggestionInMessageList", () => {
	it("swaps one suggestion's status and keeps the offered text as it was", () => {
		const userMessage: ChatMessage = {
			id: "user-1",
			role: "user",
			content: "From now on, only suggest trains.",
			timestamp: 1,
		};
		const assistantMessage: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "Understood.",
			timestamp: 2,
			instructionSuggestions: [makeSuggestion()],
		};

		expect(
			patchInstructionSuggestionInMessageList([userMessage, assistantMessage], {
				messageId: "assistant-1",
				suggestion: makeSuggestion({ status: "dismissed" }),
			}),
		).toEqual([
			userMessage,
			{
				...assistantMessage,
				instructionSuggestions: [makeSuggestion({ status: "dismissed" })],
			},
		]);
	});

	it("leaves a message whose suggestions do not hold that id untouched", () => {
		const assistantMessage: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "Understood.",
			timestamp: 2,
			instructionSuggestions: [makeSuggestion({ id: "suggestion-other" })],
		};

		expect(
			patchInstructionSuggestionInMessageList([assistantMessage], {
				messageId: "assistant-1",
				suggestion: makeSuggestion({ status: "reviewed" }),
			}),
		).toEqual([assistantMessage]);
	});
});

describe("findLiveDocumentAlfyActivity", () => {
	it("returns null with no tool-call segments at all", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		expect(findLiveDocumentAlfyActivity(list)).toBeNull();
	});

	it("finds an in-flight edit_artifact call targeting a document", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "doc-1", summary: "Add packing list", patches: [] },
			status: "running",
			details: { callId: "call-1" },
		});

		const activity = findLiveDocumentAlfyActivity(list);
		expect(activity).toEqual(
			expect.objectContaining({
				artifactId: "doc-1",
				status: "running",
				label: "Add packing list",
			}),
		);
	});

	it("ignores a tool call for a kind the panel has no live edit for", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "app-1", patches: [] },
			status: "running",
			details: { callId: "call-1" },
		});
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "app-1", patches: [] },
			status: "done",
			details: {
				callId: "call-1",
				metadata: { ok: true, artifactId: "app-1", artifactKind: "app" },
			},
		});

		expect(findLiveDocumentAlfyActivity(list)).toBeNull();
	});

	// F6 (ruling 77): the browser hears nothing of an edit call until the model has
	// written all of it, so a Document Alfy has READ in a turn that is still running is
	// "being worked on" for as long as the turn runs.
	describe("a Document the running turn has read", () => {
		function readOf(
			list: ChatMessage[],
			kind: string,
			status: "running" | "done",
		) {
			return applyToolCallUpdateToMessageList(list, {
				placeholderId: "assistant-1",
				name: "read_artifact",
				input: { artifactId: "doc-1", detail: "blocks" },
				status,
				details:
					status === "done"
						? {
								callId: "call-read",
								metadata: { ok: true, artifactId: "doc-1", artifactKind: kind },
							}
						: { callId: "call-read" },
			});
		}

		it("is being worked on from the read until the turn ends, and nothing else", () => {
			let list = [createAssistantPlaceholder("assistant-1")];
			// The read itself, still running: nothing yet (the kind is not known).
			list = readOf(list, "document", "running");
			expect(findLiveDocumentAlfyActivity(list)).toBeNull();

			list = readOf(list, "document", "done");
			expect(findLiveDocumentAlfyActivity(list)).toEqual(
				expect.objectContaining({
					key: "read:call-read",
					artifactId: "doc-1",
					toolName: "read_artifact",
					status: "running",
					label: null,
					appliedCount: 0,
				}),
			);

			// The stream is over (stopped, failed or finished): nothing is handed on.
			expect(
				findLiveDocumentAlfyActivity(
					list.map((message) => ({ ...message, isStreaming: false })),
				),
			).toBeNull();
		});

		it("gives way to the edit call once there is one, running and settled", () => {
			let list = readOf(
				[createAssistantPlaceholder("assistant-1")],
				"document",
				"done",
			);
			list = applyToolCallUpdateToMessageList(list, {
				placeholderId: "assistant-1",
				name: "edit_artifact",
				input: {
					artifactId: "doc-1",
					summary: "Shorten Saturday",
					patches: [],
				},
				status: "running",
				details: { callId: "call-edit" },
			});
			expect(findLiveDocumentAlfyActivity(list)).toEqual(
				expect.objectContaining({
					key: "call-edit",
					status: "running",
					label: "Shorten Saturday",
				}),
			);
		});

		it("is not a board's or an App's to show", () => {
			for (const kind of ["canvas", "app", "file"]) {
				const list = readOf(
					[createAssistantPlaceholder("assistant-1")],
					kind,
					"done",
				);
				expect(findLiveDocumentAlfyActivity(list)).toBeNull();
			}
		});
	});

	// F2 (ruling 77): an App is changed from the chat, and the open panel is told.
	it("finds a rebuild of an App by its instruction, running and landed", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "app-1", instruction: "Add a Reset button." },
			status: "running",
			details: { callId: "call-app" },
		});
		expect(findLiveDocumentAlfyActivity(list)).toEqual(
			expect.objectContaining({
				artifactId: "app-1",
				key: "call-app",
				status: "running",
			}),
		);

		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "app-1", instruction: "Add a Reset button." },
			status: "done",
			details: {
				callId: "call-app",
				metadata: {
					ok: true,
					artifactId: "app-1",
					artifactKind: "app",
					versionId: "version-2",
				},
			},
		});
		expect(findLiveDocumentAlfyActivity(list)).toEqual(
			expect.objectContaining({
				artifactId: "app-1",
				key: "call-app",
				status: "applied",
				versionId: "version-2",
			}),
		);
	});

	it("finds an in-flight edit of a board by its ops, before the server has said what it is", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: {
				artifactId: "board-1",
				summary: "Planned Sunday",
				ops: [{ op: "move", id: "note-1", to: { x: 1, y: 2 } }],
			},
			status: "running",
			details: { callId: "call-board" },
		});

		const activity = findLiveDocumentAlfyActivity(list);
		expect(activity).toEqual(
			expect.objectContaining({
				artifactId: "board-1",
				status: "running",
				label: "Planned Sunday",
				ops: [{ op: "move", id: "note-1", to: { x: 1, y: 2 } }],
			}),
		);
	});

	it("finds a settled edit of a board with the ops it made and the ones it left alone", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		const input = {
			artifactId: "board-1",
			ops: [
				{ op: "move", id: "note-1", to: { x: 1, y: 2 } },
				{ op: "move", id: "gone", to: { x: 3, y: 4 } },
			],
		};
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input,
			status: "running",
			details: { callId: "call-board" },
		});
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input,
			status: "done",
			details: {
				callId: "call-board",
				metadata: {
					ok: true,
					artifactId: "board-1",
					artifactKind: "canvas",
					appliedCount: 1,
					refusedBlocksJson: JSON.stringify([
						{ blockId: "gone", reason: "unknown_id", opIndex: 1 },
					]),
				},
			},
		});

		const activity = findLiveDocumentAlfyActivity(list);
		expect(activity).toMatchObject({
			artifactId: "board-1",
			key: "call-board",
			status: "refused",
			appliedCount: 1,
		});
		expect(activity?.ops).toHaveLength(2);
		expect(activity?.refusedBlocks).toEqual([
			{ blockId: "gone", reason: "unknown_id", opIndex: 1 },
		]);
	});

	it("ignores unrelated tool calls (e.g. research_web) even when present", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "Vienna" },
			status: "done",
		});

		expect(findLiveDocumentAlfyActivity(list)).toBeNull();
	});

	it("picks the MOST RECENT Document call across the whole message list", () => {
		let list = [
			createAssistantPlaceholder("assistant-1"),
			createAssistantPlaceholder("assistant-2"),
		];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "doc-old", patches: [] },
			status: "done",
			details: {
				callId: "call-old",
				metadata: { ok: true, artifactId: "doc-old", artifactKind: "document" },
			},
		});
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-2",
			name: "edit_artifact",
			input: { artifactId: "doc-new", patches: [] },
			status: "running",
			details: { callId: "call-new" },
		});

		expect(findLiveDocumentAlfyActivity(list)?.artifactId).toBe("doc-new");
	});
});

describe("liveDocumentAlfyActivityExcluding", () => {
	// `applyToolCallUpdateToMessageList`'s "done"/"failed" branch only
	// UPDATES an existing "running" segment for the same callId (see its own
	// `lastRunningIndex` search) — it never creates one from a bare "done"
	// call, matching how a real stream always runs "running" before "done".
	// A test fixture that skips the "running" step silently produces no
	// tool_call segment at all, so this seeds both steps.
	function seedDoneEditArtifactCall(
		list: ChatMessage[],
		placeholderId: string,
		callId: string,
		artifactId: string,
	): ChatMessage[] {
		let next = applyToolCallUpdateToMessageList(list, {
			placeholderId,
			name: "edit_artifact",
			input: { artifactId, patches: [] },
			status: "running",
			details: { callId },
		});
		next = applyToolCallUpdateToMessageList(next, {
			placeholderId,
			name: "edit_artifact",
			input: { artifactId, patches: [] },
			status: "done",
			details: {
				callId,
				metadata: { ok: true, artifactId, artifactKind: "document" },
			},
		});
		return next;
	}

	// RV-1B: a page reload re-fetches the WHOLE conversation history fresh —
	// including a Document edit that already settled (and may already have
	// been Kept/Undone by the user) in a PREVIOUS session. Without exclusion,
	// re-observing that same history for the first time this session would
	// make `findLiveDocumentAlfyActivity` report it as brand new, and
	// `DocumentBody.svelte` would replay its Keep/Undo mark and refusal
	// notice as if Alfy had just made the change.
	it("suppresses exactly the key that was already there when first observed", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = seedDoneEditArtifactCall(
			list,
			"assistant-1",
			"call-historical",
			"doc-1",
		);

		// The FIRST observation of this history (a fresh page load) captures
		// "call-historical" as the key to suppress.
		const suppressKey = findLiveDocumentAlfyActivity(list)?.key ?? null;
		expect(suppressKey).toBe("call-historical");

		// Re-observing the SAME (unchanged) history must not report it live.
		expect(liveDocumentAlfyActivityExcluding(list, suppressKey)).toBeNull();
	});

	it("still reports a NEW call that settles after the suppressed snapshot", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = seedDoneEditArtifactCall(
			list,
			"assistant-1",
			"call-historical",
			"doc-1",
		);
		const suppressKey = findLiveDocumentAlfyActivity(list)?.key ?? null;

		// A live edit happens WHILE this page is open — a fresh callId, never
		// seen in the suppressed snapshot.
		list = [...list, createAssistantPlaceholder("assistant-2")];
		list = seedDoneEditArtifactCall(list, "assistant-2", "call-live", "doc-1");

		const activity = liveDocumentAlfyActivityExcluding(list, suppressKey);
		expect(activity?.key).toBe("call-live");
	});

	it("does not suppress anything when there was nothing to suppress (suppressKey null)", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = seedDoneEditArtifactCall(list, "assistant-1", "call-1", "doc-1");

		expect(liveDocumentAlfyActivityExcluding(list, null)?.key).toBe("call-1");
	});

	it("passes through a running call even if its eventual key happens to match (a running call never has a settled key to collide with)", () => {
		let list = [createAssistantPlaceholder("assistant-1")];
		list = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "edit_artifact",
			input: { artifactId: "doc-1", summary: "In progress", patches: [] },
			status: "running",
			details: { callId: "call-1" },
		});

		// Nothing to suppress yet (no prior settled activity in this session).
		const activity = liveDocumentAlfyActivityExcluding(list, null);
		expect(activity?.status).toBe("running");
	});
});

// RV-3 I2: what the chat page waits for before a turn starts, so the reader's last
// step on an open board is saved before Alfy may change the board.
describe("withinOrNull", () => {
	it("gives what the work gave", async () => {
		await expect(withinOrNull(Promise.resolve("read"), 2000)).resolves.toBe(
			"read",
		);
	});

	it("gives up with null when the work takes too long", async () => {
		vi.useFakeTimers();
		try {
			const waiting = withinOrNull(new Promise(() => {}), 2000);
			await vi.advanceTimersByTimeAsync(2000);
			await expect(waiting).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("awaitOpenStepSave", () => {
	it("goes straight on when the open item has nothing to save", async () => {
		await expect(awaitOpenStepSave(null, 2000)).resolves.toBeUndefined();
	});

	it("waits for the save to be answered", async () => {
		vi.useFakeTimers();
		try {
			let answered = false;
			const save = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						setTimeout(() => {
							answered = true;
							resolve();
						}, 300);
					}),
			);
			let settled = false;
			const waiting = awaitOpenStepSave(save, 2000).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(299);
			expect(save).toHaveBeenCalledTimes(1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await waiting;
			expect(answered).toBe(true);
			expect(settled).toBe(true);
			// It leaves nothing behind: the bound is not a timer that outlives the save.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not hold a message back for longer than the bound when the save never answers", async () => {
		vi.useFakeTimers();
		try {
			const save = vi.fn(() => new Promise<void>(() => {}));
			let settled = false;
			const waiting = awaitOpenStepSave(save, 2000).then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(1999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await waiting;
			expect(settled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never rejects: a save that fails, or throws, does not stop the message", async () => {
		await expect(
			awaitOpenStepSave(() => Promise.reject(new Error("offline")), 2000),
		).resolves.toBeUndefined();
		await expect(
			awaitOpenStepSave(() => {
				throw new Error("the body is gone");
			}, 2000),
		).resolves.toBeUndefined();
	});
});

describe("shouldPollImageCards", () => {
	it("polls while a take is queued or running", () => {
		expect(
			shouldPollImageCards([imageCard([imageTake({ status: "queued" })])], []),
		).toBe(true);
		expect(
			shouldPollImageCards([imageCard([imageTake({ status: "running" })])], []),
		).toBe(true);
	});

	it("polls for a make_image call still running in the streaming reply before its card exists", () => {
		expect(
			shouldPollImageCards([], [{ name: "make_image", status: "running" }]),
		).toBe(true);
	});

	it("keeps polling while a settled take is still held, so the card re-reads when the hold runs out", () => {
		// A turn that died with its automatic retry held: every take has settled,
		// but "checking again" and a disabled Use this must not stick until a reload.
		expect(
			shouldPollImageCards(
				[imageCard([imageTake({ status: "succeeded", held: true })])],
				[],
			),
		).toBe(true);
	});

	it("stops once every take has settled and no picture call runs", () => {
		expect(
			shouldPollImageCards(
				[imageCard([imageTake({ status: "succeeded" })])],
				[
					{ name: "make_image", status: "done" },
					{ name: "research_web", status: "running" },
				],
			),
		).toBe(false);
	});
});

describe("composerPlaceholderKey", () => {
	it("asks to change an open App or Image, and about anything else", async () => {
		const { get } = await import("svelte/store");
		const { t } = await import("$lib/i18n");
		const { uiLanguage } = await import("$lib/stores/settings");
		uiLanguage.set("en");
		expect(
			get(t)(composerPlaceholderKey("image"), { title: "Cosy room" }),
		).toBe("Ask Alfy to change Cosy room…");
		expect(composerPlaceholderKey("image")).toBe(
			"artifacts.chat.composerPlaceholderApp",
		);
		expect(composerPlaceholderKey("app")).toBe(
			"artifacts.chat.composerPlaceholderApp",
		);
		expect(composerPlaceholderKey("document")).toBe(
			"artifacts.chat.composerPlaceholder",
		);
		expect(composerPlaceholderKey(null)).toBe(
			"artifacts.chat.composerPlaceholder",
		);
	});
});

describe("composer pictures (plan 2b T5)", () => {
	it("adds a picture once: attaching the same file again changes nothing", () => {
		const first = addComposerPicture([], {
			imageFileId: "f1",
			name: "Red rug",
		});
		expect(first).toEqual([{ imageFileId: "f1", name: "Red rug" }]);
		expect(
			addComposerPicture(first, { imageFileId: "f1", name: "Red rug" }),
		).toBe(first);
		expect(
			addComposerPicture(first, { imageFileId: "f2", name: "Mug" }),
		).toEqual([
			{ imageFileId: "f1", name: "Red rug" },
			{ imageFileId: "f2", name: "Mug" },
		]);
	});

	it("keeps when a picture was made, so two versions of one item can be told apart", () => {
		expect(
			addComposerPicture([], { imageFileId: "f1", name: "Sunset", at: 100 }),
		).toEqual([{ imageFileId: "f1", name: "Sunset", at: 100 }]);
	});

	it("takes a queued turn's pictures back into the composer in their number order", () => {
		expect(
			composerPicturesFromSend({
				refs: [
					{ imageFileId: "f2", number: 2, name: "Mug" },
					{ imageFileId: "f1", number: 1, name: "Red rug" },
				],
				open: null,
				marks: null,
			}),
		).toEqual([
			{ imageFileId: "f1", name: "Red rug" },
			{ imageFileId: "f2", name: "Mug" },
		]);
		expect(composerPicturesFromSend(undefined)).toEqual([]);
	});

	it("keeps the pictures when a send payload is copied", () => {
		const cloned = cloneSendPayload({
			message: "Blend",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pictureRefs: [{ imageFileId: "f1", number: 1 }],
			pictures: {
				refs: [{ imageFileId: "f1", number: 1, name: "Red rug" }],
				open: null,
				marks: null,
			},
		});
		expect(cloned.pictureRefs).toEqual([{ imageFileId: "f1", number: 1 }]);
		expect(cloned.pictures?.refs[0].name).toBe("Red rug");
	});
});

describe("restoring a turn's picture order (plan 2b T5 fix round 1)", () => {
	it("reads the order from the saved numbers, refs and uploads together", () => {
		expect(
			pictureOrderFromSend({
				refs: [{ imageFileId: "f1", number: 1, name: "Red rug" }],
				uploads: [{ artifactId: "photo-1", number: 2 }],
				open: null,
				marks: null,
			}),
		).toEqual(["ref:f1", "upload:photo-1"]);
		expect(
			pictureOrderFromSend({
				refs: [{ imageFileId: "f1", number: 2, name: "Red rug" }],
				uploads: [{ artifactId: "photo-1", number: 1 }],
				open: null,
				marks: null,
			}),
		).toEqual(["upload:photo-1", "ref:f1"]);
		expect(pictureOrderFromSend(undefined)).toEqual([]);
	});
});

describe("marks left from an older picture (plan 2b T6, Review Focus 4)", () => {
	const held = {
		imageFileId: "file-2",
		marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 }],
		artifactId: "img-1",
		name: "Cosy room",
		version: 2,
	};

	it("keeps the marks while their item is open on the version they were drawn on, or the panel is shut", () => {
		expect(marksOutdated(held, { version: 2 })).toBe(false);
		expect(marksOutdated(held, { version: 2 })).toBe(false);
		expect(marksOutdated(held, { version: null })).toBe(false);
	});

	it("lets them go when their item gets a newer version, open or not", () => {
		expect(marksOutdated(held, { version: 3 })).toBe(true);
		expect(marksOutdated(held, { version: 3 })).toBe(true);
	});

	it("never lets them go on a version it cannot compare", () => {
		expect(marksOutdated({ ...held, version: null }, { version: 5 })).toBe(
			false,
		);
	});
});

describe("restoring a turn's marks (plan 2b T6)", () => {
	it("restores the marks with the version they were drawn on, so a newer one drops them (fix round 1, I2)", () => {
		const restored = composerMarksFromSend({
			imageMarks: {
				imageFileId: "file-2",
				marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 }],
			},
			markedPicture: {
				artifactId: "img-1",
				name: "Cosy room",
				addedRef: true,
				version: 2,
			},
		});
		expect(restored?.version).toBe(2);
		if (!restored) throw new Error("no marks");
		expect(marksOutdated(restored, { version: 3 })).toBe(true);
		expect(marksOutdated(restored, { version: 2 })).toBe(false);
	});

	const marks = [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 }];
	const pictures = {
		refs: [
			{ imageFileId: "f1", number: 1, name: "Red rug" },
			{ imageFileId: "file-2", number: 2, name: "Cosy room" },
		],
		open: null,
		marks: null,
	};

	it("brings the marks chip back from the turn, and only the attached pictures as picture chips", () => {
		const payload = {
			pictures,
			imageMarks: { imageFileId: "file-2", marks },
			markedPicture: {
				artifactId: "img-1",
				name: "Cosy room",
				addedRef: true,
				version: 2,
			},
		};
		expect(composerMarksFromSend(payload)).toEqual({
			imageFileId: "file-2",
			marks,
			artifactId: "img-1",
			name: "Cosy room",
			version: 2,
		});
		expect(
			composerPicturesFromSend(
				pictures,
				payload.markedPicture.addedRef ? "file-2" : null,
			),
		).toEqual([{ imageFileId: "f1", name: "Red rug" }]);
	});

	it("keeps a marked picture that was attached as its own chip", () => {
		expect(composerPicturesFromSend(pictures, null)).toHaveLength(2);
	});

	it("brings no marks back from a turn that had none", () => {
		expect(composerMarksFromSend({})).toBeNull();
		expect(
			composerMarksFromSend({
				imageMarks: { imageFileId: "file-2", marks: [] },
				markedPicture: {
					artifactId: "img-1",
					name: "Cosy room",
					addedRef: true,
					version: 2,
				},
			}),
		).toBeNull();
	});

	it("keeps the marks when a send payload is copied", () => {
		const cloned = cloneSendPayload({
			message: "Move A",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			imageMarks: { imageFileId: "file-2", marks },
			markedPicture: {
				artifactId: "img-1",
				name: "Cosy room",
				addedRef: true,
				version: 2,
			},
		});
		expect(cloned.imageMarks).toEqual({ imageFileId: "file-2", marks });
		expect(cloned.imageMarks?.marks[0]).not.toBe(marks[0]);
		expect(cloned.markedPicture).toEqual({
			artifactId: "img-1",
			name: "Cosy room",
			addedRef: true,
			version: 2,
		});
	});
});

describe("joining a restored turn into the draft the composer holds", () => {
	const chat = "conv-1";
	const facts = { conversationId: chat, updatedAt: 11 };
	const box = { letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 };
	const attachment = (id: string): PendingAttachment => ({
		artifact: {
			id,
			type: "source_document",
			retrievalClass: "durable",
			name: `${id}.pdf`,
			mimeType: "application/pdf",
			sizeBytes: 1,
			conversationId: chat,
			summary: null,
			createdAt: 1,
			updatedAt: 1,
		},
		promptReady: true,
	});
	const source = (id: string): LinkedContextSource => ({
		displayArtifactId: id,
		promptArtifactId: `${id}-prompt`,
		familyArtifactIds: [id, `${id}-prompt`],
		name: `${id}.pdf`,
		type: "document",
	});
	const skill = (id: string) => ({
		id,
		ownership: "user" as const,
		displayName: id,
	});
	const heldDraft = (
		overrides: Partial<ConversationDraft> = {},
	): ConversationDraft => ({
		conversationId: chat,
		draftText: "C typed since",
		selectedAttachmentIds: [],
		selectedAttachments: [],
		selectedLinkedSources: [],
		pendingSkill: null,
		updatedAt: 10,
		...overrides,
	});
	const payloadOf = (overrides: Partial<SendPayload> = {}): SendPayload => ({
		message: "B queued",
		attachmentIds: [],
		attachments: [],
		pendingAttachments: [],
		...overrides,
	});
	const nothingHeld: HeldComposer = { draft: null, pictures: [], marks: null };
	const holding = (
		draft: ConversationDraft | null,
		rest: Partial<HeldComposer> = {},
	): HeldComposer => ({ ...nothingHeld, draft, ...rest });

	describe("the words", () => {
		it("puts the restored words behind the held ones, with a blank line between", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft()),
				payloadOf(),
				facts,
			);
			expect(joined.draft?.draftText).toBe("C typed since\n\nB queued");
		});

		it("adds nothing when the composer is empty", () => {
			for (const held of [
				nothingHeld,
				holding(heldDraft({ draftText: "" })),
				holding(heldDraft({ draftText: "  \n " })),
			]) {
				expect(
					joinRestoredPayload(held, payloadOf(), facts).draft?.draftText,
				).toBe("B queued");
			}
		});

		it("joins nothing when the two are the same words once trimmed", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft({ draftText: "the same words " })),
				payloadOf({ message: "the same words" }),
				facts,
			);
			expect(joined.draft?.draftText).toBe("the same words ");
		});

		it("is the join an edit that leaves the chat makes", () => {
			expect(joinDraftText("held", "added")).toBe("held\n\nadded");
			expect(joinDraftText("", "added")).toBe("added");
			expect(joinDraftText("held", "")).toBe("held");
		});

		it("lands in the chat on screen, as a newer draft", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft()),
				payloadOf(),
				facts,
			);
			expect(joined.draft?.conversationId).toBe(chat);
			expect(joined.draft?.updatedAt).toBe(11);
		});
	});

	describe("files and linked sources", () => {
		it("keeps the held files and adds the restored ones, each once", () => {
			const joined = joinRestoredPayload(
				holding(
					heldDraft({
						selectedAttachmentIds: ["a1"],
						selectedAttachments: [attachment("a1")],
					}),
				),
				payloadOf({
					attachmentIds: ["a1", "a2"],
					pendingAttachments: [attachment("a1"), attachment("a2")],
				}),
				facts,
			);
			expect(joined.draft?.selectedAttachmentIds).toEqual(["a1", "a2"]);
			expect(
				joined.draft?.selectedAttachments.map((entry) => entry.artifact.id),
			).toEqual(["a1", "a2"]);
		});

		it("keeps the held linked sources and adds the restored ones, none twice", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft({ selectedLinkedSources: [source("s1")] })),
				payloadOf({ linkedSources: [source("s1"), source("s2")] }),
				facts,
			);
			expect(
				joined.draft?.selectedLinkedSources.map(
					(entry) => entry.displayArtifactId,
				),
			).toEqual(["s1", "s2"]);
		});

		it("keeps a held file with no words, the restored words joining it", () => {
			const joined = joinRestoredPayload(
				holding(
					heldDraft({
						draftText: "",
						selectedAttachmentIds: ["a1"],
						selectedAttachments: [attachment("a1")],
					}),
				),
				payloadOf(),
				facts,
			);
			expect(joined.draft?.draftText).toBe("B queued");
			expect(joined.draft?.selectedAttachmentIds).toEqual(["a1"]);
		});
	});

	describe("the skill and the Atlas mode", () => {
		const atlasPayload = payloadOf({
			pendingSkill: skill("restored"),
			atlasMode: true,
			atlasProfile: "in-depth",
			clientAtlasTurnId: "restored-turn",
		});

		it("stay the held draft's while it holds words", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft({ pendingSkill: skill("held") })),
				atlasPayload,
				facts,
			);
			expect(joined.draft?.pendingSkill?.id).toBe("held");
			expect(joined.draft?.atlasMode).toBeUndefined();

			const heldAtlas = joinRestoredPayload(
				holding(
					heldDraft({
						atlasMode: true,
						atlasProfile: "overview",
						clientAtlasTurnId: "held-turn",
					}),
				),
				atlasPayload,
				facts,
			);
			expect(heldAtlas.draft?.atlasProfile).toBe("overview");
			expect(heldAtlas.draft?.clientAtlasTurnId).toBe("held-turn");
		});

		it("come back from the restored turn when the composer is empty, as they always did", () => {
			const joined = joinRestoredPayload(nothingHeld, atlasPayload, facts);
			expect(joined.draft?.pendingSkill?.id).toBe("restored");
			expect(joined.draft?.atlasMode).toBe(true);
			expect(joined.draft?.atlasProfile).toBe("in-depth");
			expect(joined.draft?.clientAtlasTurnId).toBe("restored-turn");
		});
	});

	describe("the pictures", () => {
		const rug = { imageFileId: "f1", name: "Red rug" };
		const mug = { imageFileId: "f2", name: "Mug" };
		const pictures = {
			refs: [
				{ imageFileId: "f1", number: 1, name: "Red rug" },
				{ imageFileId: "f2", number: 2, name: "Mug" },
			],
			open: null,
			marks: null,
		};

		it("keep the held card pictures first and add the restored ones, each once", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft(), { pictures: [mug] }),
				payloadOf({ pictures }),
				facts,
			);
			expect(joined.pictures).toEqual([mug, rug]);
		});

		it("hand over the order the restored turn numbered its pictures in", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft(), { pictures: [mug] }),
				payloadOf({ pictures }),
				facts,
			);
			expect(joined.pictureOrder).toEqual(["ref:f1", "ref:f2"]);
		});
	});

	describe("the marks", () => {
		const marked = {
			imageMarks: { imageFileId: "f9", marks: [box] },
			markedPicture: {
				artifactId: "img-9",
				name: "Cosy room",
				addedRef: true,
				version: 2,
			},
			pictures: {
				refs: [{ imageFileId: "f9", number: 1, name: "Cosy room" }],
				open: null,
				marks: null,
			},
		};
		const heldMarks: ComposerMarks = {
			imageFileId: "f5",
			marks: [{ ...box, letter: "B" as const }],
			artifactId: "img-5",
			name: "Held room",
			version: 1,
		};

		it("come back from the restored turn when none are held, the picture as their chip", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft()),
				payloadOf(marked),
				facts,
			);
			expect(joined.marks?.imageFileId).toBe("f9");
			expect(joined.pictures).toEqual([]);
		});

		it("stay the held ones when there are any: the restored turn's boxes are let go, its picture comes back as a picture", () => {
			const joined = joinRestoredPayload(
				holding(heldDraft(), { marks: heldMarks }),
				payloadOf(marked),
				facts,
			);
			expect(joined.marks).toBe(heldMarks);
			expect(joined.pictures).toEqual([
				{ imageFileId: "f9", name: "Cosy room" },
			]);
		});
	});
});

describe("the pictures an edit's resend carries", () => {
	const box = { letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 };
	const rug = { imageFileId: "f1", number: 1, name: "Red rug" };
	const room = { imageFileId: "f2", number: 2, name: "Cosy room" };

	it("carries the card pictures under the numbers they had, and draws them in the new bubble", () => {
		const recorded = {
			refs: [room, { ...rug, open: true as const }],
			open: null,
			marks: null,
		};
		const sent = editResendPictures(recorded, []);
		expect(sent.pictureRefs).toEqual([
			{ imageFileId: "f2", number: 2 },
			{ imageFileId: "f1", number: 1 },
		]);
		// What the bubble draws from its first paint: the names and numbers, as the
		// composer's own send gives them (nothing of the panel or the marks).
		expect(sent.pictures).toEqual({
			refs: [room, rug],
			open: null,
			marks: null,
		});
		expect(sent.imageMarks).toBeUndefined();
	});

	it("shares nothing with the message's own record", () => {
		const recorded = { refs: [{ ...rug }], open: null, marks: null };
		const sent = editResendPictures(recorded, []);
		expect(sent.pictures?.refs[0]).not.toBe(recorded.refs[0]);
		expect(sent.pictureRefs?.[0]).not.toBe(recorded.refs[0]);
	});

	it("keeps the numbers of the photos it still carries, and leaves out those it does not", () => {
		const recorded = {
			refs: [rug],
			uploads: [
				{ artifactId: "photo-1", number: 2 },
				{ artifactId: "photo-gone", number: 3 },
			],
			open: null,
			marks: null,
		};
		expect(editResendPictures(recorded, ["photo-1"]).pictures).toEqual({
			refs: [rug],
			uploads: [{ artifactId: "photo-1", number: 2 }],
			open: null,
			marks: null,
		});
	});

	it("carries the photos' numbers of a message that had no card picture", () => {
		const recorded = {
			refs: [],
			uploads: [{ artifactId: "photo-1", number: 1 }],
			open: null,
			marks: null,
		};
		const sent = editResendPictures(recorded, ["photo-1"]);
		expect(sent.pictureRefs).toBeUndefined();
		expect(sent.pictures?.uploads).toEqual([
			{ artifactId: "photo-1", number: 1 },
		]);
	});

	it("carries the marks, rebuilt from their recorded boxes, with their card picture", () => {
		const recorded = {
			refs: [rug],
			open: null,
			marks: {
				imageFileId: "f1",
				markedFileId: "marked-1",
				letters: ["A" as const],
				boxes: [box],
			},
		};
		const sent = editResendPictures(recorded, []);
		expect(sent.imageMarks).toEqual({ imageFileId: "f1", marks: [box] });
		expect(sent.imageMarks?.marks[0]).not.toBe(box);
		// A client-only record of the marked item cannot be made from this one.
		expect(sent).not.toHaveProperty("markedPicture");
	});

	it("gives up marks on a picture that does not go along, as a regenerate does, and sends the rest", () => {
		const recorded = {
			refs: [rug],
			open: { imageFileId: "f-old-open", name: "Old" },
			marks: {
				imageFileId: "f-old-open",
				markedFileId: "marked-1",
				letters: ["A" as const],
				boxes: [box],
			},
		};
		const sent = editResendPictures(recorded, []);
		expect(sent.imageMarks).toBeUndefined();
		expect(sent.pictureRefs).toEqual([{ imageFileId: "f1", number: 1 }]);
	});

	it("carries marks on an uploaded photo while the message still carries the photo", () => {
		const recorded = {
			refs: [],
			uploads: [{ artifactId: "photo-1", number: 1 }],
			open: null,
			marks: {
				uploadArtifactId: "photo-1",
				markedFileId: "marked-1",
				letters: ["A" as const],
				boxes: [box],
			},
		};
		expect(editResendPictures(recorded, ["photo-1"]).imageMarks).toEqual({
			uploadArtifactId: "photo-1",
			marks: [box],
		});
		expect(editResendPictures(recorded, []).imageMarks).toBeUndefined();
	});

	it("carries nothing for a message that carried no pictures, or only the one open in the panel", () => {
		expect(editResendPictures(undefined, ["doc-1"])).toEqual({});
		expect(
			editResendPictures(
				{
					refs: [],
					open: { imageFileId: "f9", name: "Open one" },
					marks: null,
				},
				[],
			),
		).toEqual({});
	});
});

describe("the draft a chat is opened with", () => {
	const chat = "conv-1";
	const attachment = (id: string): PendingAttachment => ({
		artifact: {
			id,
			type: "source_document",
			retrievalClass: "durable",
			name: `${id}.pdf`,
			mimeType: "application/pdf",
			sizeBytes: 1,
			conversationId: chat,
			summary: null,
			createdAt: 1,
			updatedAt: 1,
		},
		promptReady: true,
	});
	const saved = (
		overrides: Partial<ConversationDraft> = {},
	): ConversationDraft => ({
		conversationId: chat,
		draftText: "What the server has",
		selectedAttachmentIds: [],
		selectedAttachments: [],
		selectedLinkedSources: [],
		pendingSkill: null,
		updatedAt: 5_000,
		...overrides,
	});
	const pendingWords = (
		overrides: Partial<NonNullable<Parameters<typeof arrivalDraftOf>[2]>> = {},
	) => ({
		conversationId: chat,
		draftText: "Words still being sent",
		selectedAttachmentIds: [],
		...overrides,
	});

	it("is the server's copy when this tab holds no words for the chat", () => {
		expect(arrivalDraftOf(chat, saved(), null)).toEqual(saved());
		expect(arrivalDraftOf(chat, null, null)).toBeNull();
	});

	it("is the words still being sent when the tab holds some, whatever the server has", () => {
		expect(arrivalDraftOf(chat, saved(), pendingWords())?.draftText).toBe(
			"Words still being sent",
		);
		expect(arrivalDraftOf(chat, null, pendingWords())).toMatchObject({
			conversationId: chat,
			draftText: "Words still being sent",
		});
	});

	it("is newer than the copy it replaces, so the composer takes it", () => {
		const arrival = arrivalDraftOf(
			chat,
			saved({ updatedAt: Date.now() + 60_000 }),
			pendingWords(),
		);

		expect(arrival?.updatedAt).toBe(Date.now() + 60_000 + 1);
	});

	it("keeps the files the held words were saved with, else the saved draft's by id", () => {
		const own = arrivalDraftOf(
			chat,
			saved(),
			pendingWords({
				selectedAttachmentIds: ["a1"],
				selectedAttachments: [attachment("a1")],
			}),
		);
		expect(own?.selectedAttachments.map((entry) => entry.artifact.id)).toEqual([
			"a1",
		]);

		const fromTheServer = arrivalDraftOf(
			chat,
			saved({
				selectedAttachmentIds: ["a1", "a2"],
				selectedAttachments: [attachment("a1"), attachment("a2")],
			}),
			pendingWords({ selectedAttachmentIds: ["a2"] }),
		);
		expect(
			fromTheServer?.selectedAttachments.map((entry) => entry.artifact.id),
		).toEqual(["a2"]);
		expect(fromTheServer?.selectedAttachmentIds).toEqual(["a2"]);
	});

	it("carries the skill and the Atlas mode of the held words", () => {
		const arrival = arrivalDraftOf(
			chat,
			null,
			pendingWords({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Skill",
				},
				atlasMode: true,
				atlasProfile: "overview",
				clientAtlasTurnId: "atlas-1",
			}),
		);

		expect(arrival).toMatchObject({
			pendingSkill: { id: "skill-1" },
			atlasMode: true,
			atlasProfile: "overview",
			clientAtlasTurnId: "atlas-1",
		});
	});
});
