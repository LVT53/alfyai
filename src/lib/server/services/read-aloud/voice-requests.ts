// What the voice, preference and preview routes accept (Plan 3, Tasks 4 and 5):
// the zod schemas of their bodies, and the one function that reads a JSON body
// against a schema. The schemas hold what the service would otherwise have to
// trust: five knobs that are finite numbers inside their sliders, a name of 1
// to 40 code points, a Default speed that is one of the six.
//
// Knob ranges come from the shared voice design module, so the sliders the
// browser draws and the values the server takes cannot disagree.

import { z } from "zod";
import {
	isReadingSpeed,
	KNOBS,
	type KnobKey,
	VOICE_NAME_MAX,
} from "$lib/shared/read-aloud/voice-knobs";

/** A knob's value: a number (never NaN or infinite: zod 4's `z.number()`) inside its slider. */
function slider(key: KnobKey) {
	const spec = KNOBS.find((knob) => knob.key === key);
	if (!spec) throw new Error(`Unknown knob: ${key}`);
	return z.number().min(spec.min).max(spec.max);
}

/** The five knobs, exactly: a missing or an extra key is refused. */
export const knobsSchema = z.strictObject({
	pace: slider("pace"),
	pitch: slider("pitch"),
	depth: slider("depth"),
	energy: slider("energy"),
	projection: slider("projection"),
});

/** A name arrives with at most this many UTF-16 units, padding included, before its code points are counted. */
const NAME_INPUT_MAX = 200;

const nameSchema = z
	.string()
	.max(NAME_INPUT_MAX)
	.refine(
		(name) => {
			const length = Array.from(name.trim()).length;
			return length >= 1 && length <= VOICE_NAME_MAX;
		},
		{ message: `a name is 1 to ${VOICE_NAME_MAX} characters` },
	);

/** A built-in voice's key. */
const baseSchema = z.string().min(1).max(40);

/** A voice to make: its name, the built-in voice it is made from and its five knobs. */
export const voiceDraftSchema = z.object({
	name: nameSchema,
	base: baseSchema,
	knobs: knobsSchema,
});

/** A change to one of the person's voices: any of a draft's fields, at least one. */
export const voicePatchSchema = voiceDraftSchema
	.partial()
	.refine(
		(patch) => Object.values(patch).some((value) => value !== undefined),
		{ message: "a change names at least one field" },
	);

/** The person's choice for each language (a built-in key or one of their voice ids) and their Default speed: any, at least one. */
export const preferencesSchema = z
	.object({
		en: z.string().min(1).max(100).optional(),
		hu: z.string().min(1).max(100).optional(),
		defaultSpeed: z
			.number()
			.refine((speed) => isReadingSpeed(speed), {
				message: "one of the six reading speeds",
			})
			.optional(),
	})
	.refine(
		(next) =>
			next.en !== undefined ||
			next.hu !== undefined ||
			next.defaultSpeed !== undefined,
		{ message: "a change names at least one field" },
	);

/** A preview: the built-in voice, the knobs to hear on it, and, as an option, the person's own words (at most 2000 characters; the route checks them with `ownWords`). */
export const previewRequestSchema = z.object({
	base: baseSchema,
	knobs: knobsSchema,
	text: z.string().max(2000).optional(),
});

/** The request's body as `schema` takes it, or null when it is not JSON or fails the schema. */
export async function readJsonBody<Schema extends z.ZodType>(
	request: Request,
	schema: Schema,
): Promise<z.output<Schema> | null> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return null;
	}
	const parsed = schema.safeParse(body);
	return parsed.success ? parsed.data : null;
}
