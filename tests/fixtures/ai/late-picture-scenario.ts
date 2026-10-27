// The picture card's motion check (plan 2b T2, MOTION-PARITY): the scripted model
// says a few sentences, calls `make_image`, and answers once more after the tool
// returned, so the card arrives under a reply that is still being written, exactly
// as the Document's late card does (late-card-scenario.ts). A second marker changes
// an existing Image named in the message, so the card has a Before to flip to.

export const AI_SMOKE_LATE_PICTURE_MARKER =
	"Fake model step: say a few words, then make the picture late.";

/** What the model says before it asks for the picture, piece by piece. */
export const AI_SMOKE_LATE_PICTURE_INTRO = [
	"Here is the lighthouse you asked for. ",
	"I kept the hill green and the sky clear, ",
	"with the light coming from the left so the tower throws a long shadow. ",
	"The picture lands on its card below in a moment.",
];

export const AI_SMOKE_LATE_PICTURE_TITLE = "Lighthouse on a hill";
export const AI_SMOKE_LATE_PICTURE_PROMPT =
	"A small red lighthouse on a green hill under a clear sky, light from the left.";
export const AI_SMOKE_LATE_PICTURE_FINAL_TEXT =
	"It is on the card: press Another for a different take.";

/**
 * Changes the Image whose id follows the marker in the message (the model can only
 * know it from the message itself, as the edit-artifact scenario's ids).
 */
export const AI_SMOKE_CHANGE_PICTURE_MARKER =
	"Fake model step: change the picture with this id:";
export const AI_SMOKE_CHANGE_PICTURE_PROMPT =
	"Make the lighthouse blue, keep everything else exactly as it is.";
export const AI_SMOKE_CHANGE_PICTURE_FINAL_TEXT =
	"Done: only the lighthouse changed. Flip to Before to compare.";

/** Reads the Image id the change marker carries. */
export function changePictureIdFrom(text: string): string | null {
	const start = text.indexOf(AI_SMOKE_CHANGE_PICTURE_MARKER);
	if (start === -1) return null;
	const match = /\s*([A-Za-z0-9_-]+)/.exec(
		text.slice(start + AI_SMOKE_CHANGE_PICTURE_MARKER.length),
	);
	return match?.[1] ?? null;
}
