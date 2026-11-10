/** Geometry-only input: the recorder observes canonical answer and Stop separately from activity. */
export type ActivityFrame = {
	t: number;
	tracked: Record<string, { y: number; h: number } | null>;
};

/** End at independently observed final prose or terminal Stop removal, never at growth or loss of activity. */
export function measureLiveActivity(
	frames: readonly ActivityFrame[],
	arrival: number,
) {
	const baseline = frames[arrival - 1];
	if (!baseline?.tracked.prose || !baseline.tracked.user)
		throw new Error("Missing pre-arrival live activity baseline");
	const boundary = frames.findIndex(
		(frame, index) =>
			index >= arrival &&
			(frame.tracked.answer != null ||
				(Object.hasOwn(frame.tracked, "stop") && frame.tracked.stop === null)),
	);
	const end = boundary < 0 ? frames.length : boundary;
	if (end <= arrival)
		throw new Error("No live activity frames before terminal boundary");
	const startOffset = baseline.tracked.prose.y - baseline.tracked.user.y;
	let proseMovedPx = 0;
	for (const frame of frames.slice(arrival, end)) {
		if (!frame.tracked.prose || !frame.tracked.user)
			throw new Error(
				"Live activity disappeared before an observed terminal boundary",
			);
		proseMovedPx = Math.max(
			proseMovedPx,
			Math.abs(frame.tracked.prose.y - frame.tracked.user.y - startOffset),
		);
	}
	return { end, proseMovedPx };
}
