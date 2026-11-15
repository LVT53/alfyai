/**
 * The Video kind's serializer, registered beside document, canvas and image. It
 * wraps the shared parser so the browser and the server read one shape. A
 * version is a small JSON body that points at its clip, poster and source
 * still; the bytes are elsewhere.
 */
import {
	parseVideoVersionBody,
	serializeVideoVersionBody,
	type VideoVersionBody,
} from "$lib/shared/artifacts/video-body";
import type { ArtifactSerializer } from "./index";

export const videoSerializer: ArtifactSerializer<VideoVersionBody> = {
	kind: "video",
	serialize: serializeVideoVersionBody,
	parse: parseVideoVersionBody,
};
