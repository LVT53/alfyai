// Takes and cards for the picture card's component tests.
import type {
	ImageCardView,
	ImageTakeView,
} from "$lib/server/services/images/read-model";

let n = 0;

export function take(over: Partial<ImageTakeView> = {}): ImageTakeView {
	n += 1;
	return {
		id: `take-${n}`,
		status: "succeeded",
		phase: null,
		phaseAt: null,
		queueAhead: null,
		progressPercent: null,
		etaSeconds: null,
		canvas: { width: 1248, height: 832 },
		box: { width: 1248, height: 832 },
		origin: "turn",
		retryOf: null,
		held: false,
		fileId: `file-${n}`,
		width: 1248,
		height: 832,
		hasAlpha: false,
		baseFileId: null,
		sourceFileIds: [],
		retried: false,
		errorCode: null,
		retryable: false,
		versionNumber: null,
		toolCallId: null,
		createdAt: n,
		...over,
	};
}

export function card(
	takes: ImageTakeView[],
	over: Partial<ImageCardView> = {},
): ImageCardView {
	return {
		id: "card-1",
		conversationId: "conv-1",
		turnId: "turn-1",
		artifactId: "artifact-1",
		title: "Cosy room",
		madeFrom: "words",
		sourceCount: 0,
		pickedTakeId: takes[0]?.id ?? null,
		takes,
		...over,
	};
}
