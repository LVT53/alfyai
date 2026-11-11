import {
	containsToolCallMarkup,
	createInlineThinkingState,
	flushInlineThinkingState,
	processInlineThinkingChunk,
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

/**
 * Compact snapshots retain one delta per scoped block, with its original first
 * sequence. Live transport still receives the untouched incremental events.
 * Never append a compact snapshot to a live reducer: adopt it as a fresh view.
 */
export function createNormalChatOutputJournal(
	initial: readonly NormalChatOutputEvent[] = [],
) {
	const events: NormalChatOutputEvent[] = [];
	const deltas = new Map<
		string,
		Extract<NormalChatOutputEvent, { type: "block_delta" }>
	>();
	const seen = new Set<string>();
	const append = (event: NormalChatOutputEvent) => {
		const identity = JSON.stringify([
			event.turnId,
			event.segmentId,
			event.attemptId,
			event.sequence,
		]);
		if (seen.has(identity)) return;
		seen.add(identity);
		if (event.type === "block_delta") {
			const key = JSON.stringify([
				event.turnId,
				event.segmentId,
				event.attemptId,
				event.stepId,
				event.blockId,
			]);
			const prior = deltas.get(key);
			if (prior) {
				prior.text += event.text;
				return;
			}
			const copy = { ...event };
			deltas.set(key, copy);
			events.push(copy);
		} else events.push({ ...event });
	};
	for (const event of initial) append(event);
	return { events, append };
}

/** Legacy rows use the same compact representation as newly saved snapshots. */
export function compactNormalChatOutputEvents(
	events: readonly NormalChatOutputEvent[],
): NormalChatOutputEvent[] {
	return createNormalChatOutputJournal(events).events;
}

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
	flushInlineThinkingState(state, emit, { preserveIncompleteVisibleTag: true });
	return containsToolCallMarkup(result) ? "" : result;
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
	const settlements = new Map<
		string,
		{ sequence: number; role: "activity" | "answer" }
	>();
	const pending = new Map<string, NormalChatOutputEvent[]>();
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
	const apply = (event: NormalChatOutputEvent): boolean => {
		const identity = JSON.stringify([
			event.turnId,
			event.segmentId,
			event.attemptId,
			event.sequence,
		]);
		if (seen.has(identity)) return false;
		const scopedStep = stepKey(event);
		const key =
			"blockId" in event ? JSON.stringify([scopedStep, event.blockId]) : "";
		if (
			(event.type === "block_delta" || event.type === "block_end") &&
			!byId.has(key)
		) {
			const waiting = pending.get(key) ?? [];
			if (!waiting.some((item) => item.sequence === event.sequence))
				waiting.push(event);
			pending.set(key, waiting);
			return false;
		}
		seen.add(identity);
		if (event.type === "block_start" && !byId.has(key)) {
			const block: NormalChatOutputBlock = {
				version: event.version,
				turnId: event.turnId,
				segmentId: event.segmentId,
				attemptId: event.attemptId,
				stepId: event.stepId,
				phase: event.phase,
				blockId: event.blockId,
				nativeId: event.nativeId,
				kind: event.kind,
				role:
					event.kind === "text"
						? (settlements.get(scopedStep)?.role ?? event.role)
						: event.role,
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
			const waiting = pending.get(key);
			pending.delete(key);
			for (const deferred of waiting?.sort((a, b) => a.sequence - b.sequence) ??
				[])
				apply(deferred);
		}
		if (event.type === "block_delta") {
			const block = byId.get(key);
			if (block) {
				block.text += event.text;
				activityDirty = true;
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
			const prior = settlements.get(scopedStep);
			if (prior && prior.sequence > event.sequence) return true;
			settlements.set(scopedStep, {
				sequence: event.sequence,
				role: event.role,
			});
			for (const block of byStep.get(scopedStep) ?? [])
				if (block.kind === "text") block.role = event.role;
			answerDirty = true;
			answerOrderDirty = true;
			activityDirty = true;
		}
		if (event.type === "completion") completion = event.completion;
		return true;
	};
	return {
		apply,
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
					(b) => b.kind === "text" && b.role !== "answer" && b.text.length > 0,
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
