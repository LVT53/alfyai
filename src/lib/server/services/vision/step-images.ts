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

/** One look: what the pictures are, and the pictures. */
export type StepImageEntry = { label: string; images: TurnImage[] };

/** One turn's pictures between the tool that queues them and the step that sends them. */
export type StepImageQueue = {
	push(entry: StepImageEntry): void;
	/** Takes every queued entry, in the order they were pushed; the queue is empty after. */
	drain(): StepImageEntry[];
};

/** A queue for one turn. Tools get the turn's queue; the model run drains it. */
export function createStepImageQueue(): StepImageQueue {
	let entries: StepImageEntry[] = [];
	return {
		push(entry) {
			entries.push(entry);
		},
		drain() {
			const drained = entries;
			entries = [];
			return drained;
		},
	};
}

/**
 * The `prepareStep` that hands the queued pictures to the model: one user
 * message per entry, appended after everything the step would send (so after
 * the tool result the pictures belong to), holding the label and then each
 * picture. The model run builds one for each attempt with that attempt's own
 * `providerCanSee`, because the primary model may see and the fallback it fails
 * over to not: an attempt on a model that cannot see gets the label and
 * `STRIPPED_IMAGE_NOTE` in place of the pictures, and its bytes never leave.
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
}): PrepareStepFunction<ToolSet> {
	const { queue, providerCanSee } = params;
	return ({ messages }) => {
		const entries = queue.drain();
		if (entries.length === 0) return undefined;
		return {
			messages: [
				...messages,
				...entries.map((entry) =>
					providerCanSee
						? buildCurrentUserMessage(entry.label, entry.images)
						: {
								role: "user" as const,
								content: [
									{ type: "text" as const, text: entry.label },
									{ type: "text" as const, text: STRIPPED_IMAGE_NOTE },
								],
							},
				),
			],
		};
	};
}
