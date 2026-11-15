// Takes, clips and cards for the video card's tests. The shape is the one the
// runner slice's read model must produce (`VideoCardView`): one take carrying
// its landed clip as the shared version body.
import type { VideoVersionBody } from "$lib/shared/artifacts/video-body";
import type { VideoCardView, VideoTakeView } from "./video-card-view";

let n = 0;

export function videoClip(
	over: Partial<VideoVersionBody> = {},
): VideoVersionBody {
	n += 1;
	return {
		v: 1,
		fileId: `clip-${n}`,
		posterFileId: `poster-${n}`,
		width: 1280,
		height: 720,
		durationMs: 5000,
		sourceFileId: null,
		...over,
	};
}

export function videoTake(over: Partial<VideoTakeView> = {}): VideoTakeView {
	n += 1;
	return {
		id: `video-take-${n}`,
		status: "succeeded",
		phase: null,
		phaseAt: null,
		queueAhead: null,
		etaSeconds: null,
		errorCode: null,
		retryable: false,
		toolCallId: null,
		createdAt: n,
		clip: videoClip(),
		...over,
	};
}

export function videoCard(
	take: VideoTakeView | null = videoTake(),
	over: Partial<VideoCardView> = {},
): VideoCardView {
	return {
		id: "video-card-1",
		conversationId: "conv-1",
		artifactId: "video-1",
		title: "Harbour at dawn",
		width: 1280,
		height: 720,
		durationMs: take?.clip?.durationMs ?? 5000,
		take,
		...over,
	};
}
