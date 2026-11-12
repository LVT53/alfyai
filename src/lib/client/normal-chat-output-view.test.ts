import { describe, expect, it } from "vitest";
import { placeReplySegments } from "$lib/components/chat/reply-segments";
import {
	createNormalChatOutputAccumulator,
	type NormalChatOutputEvent,
} from "$lib/shared/normal-chat-output";
import {
	finalizeStreamingMessageList,
	landedAssistantRow,
} from "../../routes/(app)/chat/[conversationId]/_helpers";
import {
	applyNormalChatOutputView,
	type NormalChatOutputMessage,
	normalChatOutputView,
	showsProvisionalPreview,
} from "./normal-chat-output-view";

const scope = {
	version: 1,
	turnId: "t",
	segmentId: "s",
	attemptId: "a",
	stepId: "w",
	phase: "working",
} as const;
const events: NormalChatOutputEvent[] = [
	{
		...scope,
		sequence: 0,
		type: "block_start",
		blockId: "b",
		nativeId: "native",
		kind: "text",
		role: "provisional",
	},
	{
		...scope,
		sequence: 1,
		type: "block_delta",
		blockId: "b",
		text: "Working <img src=x>",
	},
];
const row = (id: string, content: string): NormalChatOutputMessage => ({
	id,
	role: "assistant",
	timestamp: 1,
	content,
});
describe("browser output view", () => {
	it.each([
		"saved",
		"live",
	] as const)("overlays late finalization on the same %s journal without rewriting model truth", (mode) => {
		const completion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "closing",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "tool_budget",
			closingAttempted: true,
		} as const;
		const journal: NormalChatOutputEvent[] = [
			...events,
			{ ...scope, sequence: 2, type: "completion", completion },
		];
		const message: NormalChatOutputMessage = {
			...row("saved", "  Canonical answer\n"),
			normalChatOutput: { version: 1, events: journal },
		};
		const before = normalChatOutputView(message);
		if (mode === "live") message.normalChatOutputView = before;
		message.normalChatFinalization = {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped: false,
		};
		const after = normalChatOutputView(message);
		expect(after?.completion?.outcome).toBe("failed");
		expect(after?.modelCompletion).toBe(completion);
		expect(after?.normalChatFinalization).toEqual(
			message.normalChatFinalization,
		);
		expect(after?.activity).toBe(before?.activity);
		expect(before?.completion?.outcome).toBe("answered");
		expect(message.content).toBe("  Canonical answer\n");
		expect(journal.at(-1)).toMatchObject({
			completion: { outcome: "answered" },
		});
	});

	it("recognizes a saved terminal activity-only reply as landed for polling", () => {
		const completion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "working",
			outcome: "incomplete",
			stopCause: "stream_end",
			workingStopCause: "stream_end",
			closingAttempted: false,
		} as const;
		const message = {
			...row("saved", ""),
			normalChatOutput: {
				version: 1 as const,
				events: [
					...events,
					{ ...scope, sequence: 2, type: "completion" as const, completion },
				],
			},
		};
		expect(landedAssistantRow(message, [])).toBe(true);
	});
	it("retains ordinary interrupted activity after reload without replacing finalized saved answer", () => {
		const message = {
			...row("saved", "Final [citation]"),
			normalChatOutput: { version: 1 as const, events },
		};
		const view = normalChatOutputView(message);
		expect(view?.answer).toBe("");
		expect(view?.activity[0]).toMatchObject({
			blockId: "b",
			nativeId: "native",
			text: "Working <img src=x>",
		});
		expect(message.content).toBe("Final [citation]");
		expect(normalChatOutputView(message)).toBe(view);
	});
	it("finalizes a structural stop with activity but no fabricated answer", () => {
		const accumulator = createNormalChatOutputAccumulator();
		for (const event of events) accumulator.apply(event);
		const live = applyNormalChatOutputView(
			[row("p", "")],
			"p",
			accumulator.getProjection(),
		);
		const [saved] = finalizeStreamingMessageList(live, {
			placeholderId: "p",
			clientUserMessageId: null,
			metadata: { wasStopped: true },
		});
		expect(saved.content).toBe("");
		expect(normalChatOutputView(saved)?.activity[0].text).toBe(
			"Working <img src=x>",
		);
	});
	it("uses finalContent on stopped closing answers and preserves earlier canonical segment text once", () => {
		const messages = [
			row("first", "Earlier answer"),
			{ ...row("p", "raw"), continuesMessageId: "first" },
		];
		const saved = finalizeStreamingMessageList(messages, {
			placeholderId: "p",
			clientUserMessageId: null,
			metadata: { wasStopped: true, finalContent: "Partial [fixed]" },
		});
		expect(saved[1].content).toBe("Partial [fixed]");
		expect(placeReplySegments(saved, [], null).get(saved[1].id)?.copyText).toBe(
			"Earlier answer\n\nPartial [fixed]",
		);
	});
});

it("projects marker-only rows without fabricating model completion or IDs", () => {
	const message = {
		...row("untracked", "  Canonical answer\n"),
		normalChatFinalization: {
			version: 1,
			status: "failed",
			cause: "file_association_failed",
			wasStopped: false,
		},
	} as const;
	const view = normalChatOutputView(message);
	expect(view?.normalChatFinalization).toEqual(message.normalChatFinalization);
	expect(view?.answer).toBe(message.content);
	expect(view?.completion).toBeUndefined();
	expect(view?.modelCompletion).toBeUndefined();
	expect(view?.blocks).toEqual([]);
});

// The provisional preview is the text of the step being written. A browser that
// only polls reads no frames of the reply, so the step it last saw may have called
// a tool since, which would have withdrawn the text (review 2, finding 2.5).
describe("showsProvisionalPreview", () => {
	const streaming = (
		extra: Partial<NormalChatOutputMessage> = {},
	): NormalChatOutputMessage => ({
		...row("live", ""),
		isStreaming: true,
		...extra,
	});

	it.each([
		[undefined, true],
		["preparing", true],
		["generating", true],
		["finalizing", false],
		["polling", false],
	] as const)("for a reply in the phase %s: %s", (runtimePhase, shown) => {
		expect(showsProvisionalPreview(streaming({ runtimePhase }))).toBe(shown);
	});

	it("is drawn again when frames resume after the browser only polled", () => {
		const polled = streaming({ runtimePhase: "polling" });
		expect(showsProvisionalPreview(polled)).toBe(false);
		expect(
			showsProvisionalPreview({ ...polled, runtimePhase: "generating" }),
		).toBe(true);
	});

	it("is not drawn for a reply that is no longer being written", () => {
		expect(showsProvisionalPreview(row("done", "Final answer"))).toBe(false);
		expect(
			showsProvisionalPreview({
				...row("stopped", ""),
				isStreaming: false,
				wasStopped: true,
			}),
		).toBe(false);
	});

	it("counts a reply that is only thinking as still being written", () => {
		expect(
			showsProvisionalPreview({
				...row("thinking", ""),
				isThinkingStreaming: true,
			}),
		).toBe(true);
	});

	it("is not drawn once the turn has a completion", () => {
		const completion = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			phase: "working",
			outcome: "answered",
			stopCause: "natural_stop",
			workingStopCause: "natural_stop",
			closingAttempted: false,
		} as const;
		const settled = streaming({
			normalChatOutput: {
				version: 1,
				events: [
					...events,
					{ ...scope, sequence: 2, type: "completion", completion },
				],
			},
		});
		expect(showsProvisionalPreview(settled)).toBe(false);
		expect(
			showsProvisionalPreview(
				streaming({ normalChatOutput: { version: 1, events } }),
			),
		).toBe(true);
	});
});
