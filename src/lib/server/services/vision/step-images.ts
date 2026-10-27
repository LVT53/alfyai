import type { PrepareStepFunction, ToolSet } from "ai";
import {
	buildCurrentUserMessage,
	STRIPPED_IMAGE_NOTE,
	type TurnImage,
} from "./turn-images";

// Pictures a tool wants the model to see in the middle of a turn (the photos
// tool, for Immich thumbnails). The AI SDK turns a tool result into plain text,
// so the pixels cannot ride in the result: the tool queues them here, and the
// model run hands them over in a user message that follows the result, in the
// next step (vision/AGENTS.md).

/** Pictures a tool may show the model in one turn, in all the looks of the turn. */
export const STEP_IMAGE_TURN_BUDGET = 8;

/** What an attempt that may not have the names is told when an entry has no label of its own for it. */
const NAMELESS_FALLBACK_LABEL =
	"Thumbnails from the photos tool, in result order.";

/** One look: what the pictures are, and the pictures. */
export type StepImageEntry = {
	label: string;
	images: TurnImage[];
	/**
	 * The pictures were cleared for a model on the person's own box only, because
	 * the person keeps connector data local (local summarising on). The tool
	 * decided that for the model the turn started on; an attempt can be on another
	 * host (a failover to a cloud model that is ticked as seeing), and that attempt
	 * is sent neither the pictures nor the names (see `buildVisionPrepareStep`).
	 */
	localOnly?: true;
	/** The label with no file name in it: what an attempt that may not have the names is told. */
	labelWithoutNames?: string;
};

/** One turn's pictures between the tool that queues them and the step that sends them. */
export type StepImageQueue = {
	push(entry: StepImageEntry): void;
	/** Takes every queued entry, in the order they were pushed; the queue is empty after. */
	drain(): StepImageEntry[];
	/** How many more pictures the turn may show the model. */
	room(): number;
	/**
	 * Takes up to `wanted` pictures of what the turn has left, at once, and says
	 * how many it got. A look asks before it downloads anything, so two looks asked
	 * for in the same step share the turn's budget instead of each taking all of it.
	 */
	reserve(wanted: number): number;
	/** Gives back pictures that were reserved and not queued. */
	release(count: number): void;
};

function wholeCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * A queue for one turn. Tools get the turn's queue; the model run drains it. It
 * also holds the turn's budget of pictures (`STEP_IMAGE_TURN_BUDGET`): handing
 * the pictures over does not give it back, because the turn has shown them.
 */
export function createStepImageQueue(
	options: { budget?: number } = {},
): StepImageQueue {
	const budget = options.budget ?? STEP_IMAGE_TURN_BUDGET;
	let entries: StepImageEntry[] = [];
	let held = 0;
	return {
		push(entry) {
			entries.push(entry);
		},
		drain() {
			const drained = entries;
			entries = [];
			return drained;
		},
		room() {
			return Math.max(0, budget - held);
		},
		reserve(wanted) {
			const granted = Math.min(wholeCount(wanted), Math.max(0, budget - held));
			held += granted;
			return granted;
		},
		release(count) {
			held = Math.max(0, held - wholeCount(count));
		},
	};
}

function textMessage(...texts: string[]) {
	return {
		role: "user" as const,
		content: texts.map((text) => ({ type: "text" as const, text })),
	};
}

/**
 * The `prepareStep` that hands the queued pictures to the model: one user
 * message per drained entry, appended after everything the step would send (so
 * after the tool result the pictures belong to), holding the label and then each
 * picture. The model run builds one for each attempt, from that attempt's own
 * provider, because the primary model may see and the fallback it fails over to
 * not, and the primary may run on the person's box and the fallback elsewhere:
 *
 * - an attempt on a model that cannot see gets the label and `STRIPPED_IMAGE_NOTE`
 *   in place of the pictures, and their bytes never leave;
 * - an entry cleared for the box only (`localOnly`) is, on an attempt that is not
 *   on the box (`providerIsLocal` not true, so also when it is not said), sent
 *   a label with no file name in it and `STRIPPED_IMAGE_NOTE`, whatever the
 *   model can see: neither the pictures nor the names leave the box.
 *
 * An entry is handed over once. In `ai` 6.0.193 the `messages` a step function
 * returns are that step's alone (each step is built again from the original
 * messages and the responses so far), so the pictures ride in the one step after
 * the call that asked for them, and the model's own words carry what it saw into
 * the steps after. An SDK that keeps a returned list for later steps would keep
 * them longer and nothing here would double them: the entry is gone from the
 * queue. Nothing is returned when the queue is empty, so a step without pictures
 * is left exactly as the SDK built it (and the other step functions keep their
 * say).
 */
export function buildVisionPrepareStep(params: {
	queue: StepImageQueue;
	providerCanSee: boolean;
	providerIsLocal?: boolean;
}): PrepareStepFunction<ToolSet> {
	const { queue, providerCanSee, providerIsLocal } = params;
	return ({ messages }) => {
		const entries = queue.drain();
		if (entries.length === 0) return undefined;
		return {
			messages: [
				...messages,
				...entries.map((entry) => {
					if (entry.localOnly === true && providerIsLocal !== true) {
						return textMessage(
							entry.labelWithoutNames ?? NAMELESS_FALLBACK_LABEL,
							STRIPPED_IMAGE_NOTE,
						);
					}
					return providerCanSee
						? buildCurrentUserMessage(entry.label, entry.images)
						: textMessage(entry.label, STRIPPED_IMAGE_NOTE);
				}),
			],
		};
	};
}
