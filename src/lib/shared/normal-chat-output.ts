import {
	createInlineThinkingState,
	flushInlineThinkingState,
	processInlineThinkingChunk,
	startsWithToolCallMarkup,
	stripCompleteSkillControlEnvelopeBlocks,
} from "$lib/services/stream-protocol";
import type { NormalChatCompletion } from "./normal-chat-completion";

export type NormalChatOutputPhase = "working" | "closing";
export type NormalChatOutputRole = "provisional" | "activity" | "answer";
export type NormalChatOutputScope = {
	version: 1;
	turnId: string;
	segmentId: string;
	attemptId: string;
	stepId: string;
	phase: NormalChatOutputPhase;
};
export type NormalChatOutputBlock = NormalChatOutputScope & {
	blockId: string;
	nativeId: string;
	kind: "text" | "reasoning";
	role: NormalChatOutputRole;
	text: string;
	ended: boolean;
};
export type NormalChatOutputEvent = NormalChatOutputScope & {
	sequence: number;
} & (
		| {
				type: "block_start";
				blockId: string;
				nativeId: string;
				kind: "text" | "reasoning";
				role: NormalChatOutputRole;
		  }
		| { type: "block_delta"; blockId: string; text: string }
		| { type: "block_end"; blockId: string }
		| { type: "step_start" }
		| { type: "step_end"; finishReason: string | null; toolAttempted: boolean }
		| {
				type: "step_settled";
				role: "activity" | "answer";
				finishReason: string | null;
		  }
		| { type: "completion"; completion: NormalChatCompletion }
	);

/** Strip explicit control syntax only. Ordinary narration is never classified or removed. */
export function sanitizeNormalChatAnswer(text: string): string {
	const state = createInlineThinkingState();
	let result = "";
	const emit = {
		onVisible: (chunk: string) => {
			result += chunk;
			return true;
		},
		onThinking: () => true,
	};
	processInlineThinkingChunk(
		state,
		stripCompleteSkillControlEnvelopeBlocks(text).visibleText,
		emit,
	);
	flushInlineThinkingState(state, emit);
	return startsWithToolCallMarkup(result) ? "" : result;
}

export type NormalChatOutputProjection = {
	answer: string;
	activity: NormalChatOutputBlock[];
	blocks: NormalChatOutputBlock[];
	completion?: NormalChatCompletion;
};
export type NormalChatOutputAccumulator = {
	apply(event: NormalChatOutputEvent): boolean;
	getProjection(): NormalChatOutputProjection;
};

/** Retain this reducer for live deltas. No event history is rescanned or retained. */
export function createNormalChatOutputAccumulator(): NormalChatOutputAccumulator {
	const byId = new Map<string, NormalChatOutputBlock>();
	const byStep = new Map<string, NormalChatOutputBlock[]>();
	const ordered: NormalChatOutputBlock[] = [];
	const seen = new Set<string>();
	let completion: NormalChatCompletion | undefined;
	let answer = "";
	let answerRaw = "";
	let answerOrderDirty = false;
	let answerNeedsSanitizer = false;
	let answerPrefix = "";
	let lastAnswerBlock: NormalChatOutputBlock | undefined;
	let answerDirty = false;
	let activity: NormalChatOutputBlock[] = [];
	let activityDirty = false;
	const stepKey = (e: NormalChatOutputScope) =>
		JSON.stringify([e.turnId, e.segmentId, e.attemptId, e.stepId]);
	return {
		apply(event) {
			const identity = JSON.stringify([
				event.turnId,
				event.segmentId,
				event.sequence,
			]);
			if (seen.has(identity)) return false;
			seen.add(identity);
			const scopedStep = stepKey(event);
			const key =
				"blockId" in event ? JSON.stringify([scopedStep, event.blockId]) : "";
			if (event.type === "block_start" && !byId.has(key)) {
				const block: NormalChatOutputBlock = {
					...event,
					text: "",
					ended: false,
				};
				byId.set(key, block);
				ordered.push(block);
				if (block.kind === "text" && block.role === "answer")
					lastAnswerBlock = block;
				const stepBlocks = byStep.get(scopedStep) ?? [];
				stepBlocks.push(block);
				byStep.set(scopedStep, stepBlocks);
				activityDirty = true;
			}
			if (event.type === "block_delta") {
				const block = byId.get(key);
				if (block) {
					block.text += event.text;
					if (block.kind === "text" && block.role === "answer") {
						if (block === lastAnswerBlock && !answerOrderDirty) {
							answerRaw += event.text;
							answerNeedsSanitizer ||= event.text.includes("<");
							if (answerPrefix.length < 3)
								answerPrefix = (answerPrefix + event.text.trimStart()).slice(
									0,
									3,
								);
							answerNeedsSanitizer ||= answerPrefix === "```";
						} else answerOrderDirty = true;
						answerDirty = true;
					}
				}
			}
			if (event.type === "block_end") {
				const block = byId.get(key);
				if (block) block.ended = true;
			}
			if (event.type === "step_settled") {
				for (const block of byStep.get(scopedStep) ?? [])
					if (block.kind === "text") block.role = event.role;
				answerDirty = true;
				answerOrderDirty = true;
				activityDirty = true;
			}
			if (event.type === "completion") completion = event.completion;
			return true;
		},
		// Views belong to the accumulator; consumers read, never mutate them.
		getProjection() {
			if (answerDirty) {
				if (answerOrderDirty) {
					const answers = ordered.filter(
						(b) => b.kind === "text" && b.role === "answer",
					);
					answerRaw = answers.map((b) => b.text).join("");
					lastAnswerBlock = answers.at(-1);
					answerPrefix = answerRaw.trimStart().slice(0, 3);
					answerNeedsSanitizer =
						answerRaw.includes("<") || answerPrefix === "```";
					answerOrderDirty = false;
				}
				// Ordinary append-only answer text needs no full block join or syntax scan.
				answer = answerNeedsSanitizer
					? sanitizeNormalChatAnswer(answerRaw)
					: answerRaw;
				answerDirty = false;
			}
			if (activityDirty) {
				activity = ordered.filter(
					(b) => b.kind === "text" && b.role !== "answer",
				);
				activityDirty = false;
			}
			return {
				answer,
				activity,
				blocks: ordered,
				...(completion ? { completion } : {}),
			};
		},
	};
}

/** Replay uses the same incremental role owner as the live client. */
export function projectNormalChatOutput(
	events: readonly NormalChatOutputEvent[],
): NormalChatOutputProjection {
	const accumulator = createNormalChatOutputAccumulator();
	for (const event of events) accumulator.apply(event);
	return accumulator.getProjection();
}
