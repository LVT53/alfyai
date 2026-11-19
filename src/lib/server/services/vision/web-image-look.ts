import { imagePreviewTarget } from "$lib/shared/url-provenance";
import { fetchPublisherThumbnail } from "../image-search";
import type { StepImageQueue } from "./step-images";
import type { TurnImage } from "./turn-images";

type Candidate = { id: string; url: string; thumbnail?: string };
type LookResult = {
	queuedIds: string[];
	reason?: "text_only" | "budget" | "unavailable";
};

/** The tool resolves IDs against its own search results before passing candidates here. */
export async function queueWebImagePreviews(params: {
	queue?: StepImageQueue;
	candidates: readonly Candidate[];
	signal: AbortSignal;
}): Promise<LookResult> {
	const { queue, signal } = params;
	const attempt = queue?.visionAttempt;
	const unavailable: LookResult = { queuedIds: [], reason: "unavailable" };
	if (!queue || !attempt || signal.aborted) return unavailable;
	if (!attempt.canSee) return { queuedIds: [], reason: "text_only" };

	const candidates = params.candidates
		.filter(({ url, thumbnail }) => {
			const target = imagePreviewTarget(thumbnail);
			return target !== null && target === imagePreviewTarget(url);
		})
		.slice(0, 2);
	if (!candidates.length) return unavailable;
	const granted = queue.reserve(candidates.length);
	if (!granted) return { queuedIds: [], reason: "budget" };
	const queuedIds: string[] = [];
	try {
		// Up to two small previews. Preserve the caller's selected order even if
		// the second publisher answers first.
		const images = await Promise.all(
			candidates
				.slice(0, granted)
				.map(async ({ id, url }): Promise<TurnImage | null> => {
					try {
						const preview = await fetchPublisherThumbnail(url, { signal });
						if (!preview || signal.aborted || queue.visionAttempt !== attempt)
							return null;
						const { prepareImageForModel, THUMBNAIL_MAX_LONG_EDGE } =
							await import("./prepare-image");
						const image = await prepareImageForModel(
							preview.bytes,
							preview.contentType,
							{ maxLongEdge: THUMBNAIL_MAX_LONG_EDGE, signal },
						);
						return { artifactId: id, name: id, image };
					} catch {
						return null;
					}
				}),
		);
		if (signal.aborted || queue.visionAttempt !== attempt) return unavailable;
		for (const image of images) {
			if (!image) continue;
			queue.push({
				label: `Web image preview for result ${image.name}:`,
				images: [image],
			});
			queuedIds.push(image.name);
		}
		if (!queuedIds.length) return unavailable;
		if (
			queuedIds.length < granted ||
			candidates.length < params.candidates.length
		)
			return { queuedIds, reason: "unavailable" };
		return granted < candidates.length
			? { queuedIds, reason: "budget" }
			: { queuedIds };
	} finally {
		queue.release(granted - queuedIds.length);
	}
}
