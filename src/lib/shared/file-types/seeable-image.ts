// Which attachments are pictures a chat model can be shown.
//
// An image counts only when the server's image preparation decodes it
// (`prepareImageForModel` in `$lib/server/services/vision/prepare-image.ts`:
// sharp, plus a WebAssembly hop for HEIC and HEIF). The list is explicit, not
// "every image the registry knows":
//
//  - a BMP is a registry image the prebuilt image library has no decoder for,
//  - an AVIF is refused at upload, so it is never an attachment,
//  - an icon, a Photoshop file or a camera raw file is an `image/*` type the
//    registry does not know at all.
//
// Whatever treats a picture as needing no extracted text (the send gate for a
// model that can see) must ask this first. For an image the model can never be
// shown, the text is all there is, and a gate that let it through without text
// would send the model nothing.
//
// Shared rather than under `$lib/server` because the composer decides with the
// same rule: a chip that opened Send for a picture the server then refused
// would be a lie. `vision/prepare-image.test.ts` ("the formats an attachment
// can be sent as") keeps this list honest against the decoder: every id here is
// prepared from real bytes, and every other registry image has its reason.

import { resolveEntry } from "./index";

const SEEABLE_IMAGE_IDS: ReadonlySet<string> = new Set([
	"jpg",
	"png",
	"gif",
	"webp",
	"tif",
	"heic",
	"heif",
	"svg",
]);

/**
 * Whether an attachment is a picture that can be prepared and sent to a model.
 * The extension decides, and the MIME type when the name has none that the
 * registry knows (the lookup order every call site uses: `resolveEntry`).
 */
export function isSeeableImage(
	name: string,
	mimeType: string | null | undefined,
): boolean {
	const entry = resolveEntry(name, mimeType);
	return entry !== null && SEEABLE_IMAGE_IDS.has(entry.id);
}

const HEIF_IMAGE_IDS: ReadonlySet<string> = new Set(["heic", "heif"]);

/** What a HEIC or HEIF photo is previewed as: only Safari draws the original. */
export const HEIF_PREVIEW_CONTENT_TYPE = "image/png";

/** Whether an attachment is a HEIC or HEIF photo, by the same lookup as above. */
export function isHeifImage(
	name: string,
	mimeType: string | null | undefined,
): boolean {
	const entry = resolveEntry(name, mimeType);
	return entry !== null && HEIF_IMAGE_IDS.has(entry.id);
}
