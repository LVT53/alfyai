/**
 * The Image kind's serializer, registered beside document and canvas. It wraps
 * the shared parser so the browser and the server read one shape. A version is
 * a small JSON body that points at its picture; the bytes are elsewhere.
 */
import {
	type ImageVersionBody,
	parseImageVersionBody,
	serializeImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import type { ArtifactSerializer } from "./index";

export const imageSerializer: ArtifactSerializer<ImageVersionBody> = {
	kind: "image",
	serialize: serializeImageVersionBody,
	parse: parseImageVersionBody,
};
