// The caption step of a video take: the person's motion idea, rewritten by an
// LLM the admin configured, in the style LTX-2.5 was trained to read. The
// instruction is ComfyUI's own (`comfy_extras/nodes_textgen.py`'s
// `LTX24_I2V_SYSTEM_PROMPT`), vendored here and pinned by a test rather than
// read from a ComfyUI checkout at runtime: the take is rendered on a server
// that may hold no ComfyUI source at all, and the wording is part of the
// model's contract, not something this app may drift. What the app adds follows
// it after a blank line, in the same system message (`VIDEO_CAPTION_HOUSE_RULES`:
// the endpoint is never shown the still, and the feasibility study's house
// rules; or `VIDEO_CAPTION_ALT_RULES`, which replaces them for the second engine
// variant; or `VIDEO_CAPTION_TEXT_RULES`, the alt block for an alt take that
// starts from text and has no still). One system message, first: a chat
// template may refuse a system message anywhere else (`captionSystemMessage`).
//
// The endpoint is configuration (ADR-0068): an address the app calls without a
// click comes from the admin's settings, never from anything a model wrote.
// Without one the person's motion idea is used unchanged: the rewrite makes a
// clip better, and is never a prerequisite for making one.
//
// Everything sent is English (ruling 79). The idea is the person's own data.

import {
	getLtxCaptionApiKey,
	getLtxCaptionModel,
	getLtxCaptionUrl,
	isVideoCaptionConfigured,
} from "$lib/server/config-store";
import type { LtxVideoVariant } from "$lib/server/services/images/comfyui/ltx-spec";
import { buildOpenAICompatibleUrl } from "$lib/server/services/openai-compatible-url";

/**
 * ComfyUI's LTX-2.5 image-to-video instruction, verbatim (the trailing newline
 * of the Python literal trimmed, as ComfyUI's own `.strip()` sends it). A
 * change here is a different model instruction and needs a deliberate new pin.
 */
export const LTX24_I2V_INSTRUCTION = `You are given a REFERENCE IMAGE (the exact first frame of the video) and a user's short image-to-video request. Write a single, highly detailed audio-visual caption describing the video that BEGINS from this exact reference image and best fulfills that request, in the EXACT style of the training captions used for this video model. The generated video is scored against the user's ORIGINAL request, so preserve every element the user stated; expand faithfully into the full caption style without contradicting or dropping anything they asked for.

FIRST-FRAME / IMAGE GROUNDING (do this first): the opening of your caption must match the reference image exactly — same subject(s), identity, appearance, clothing, setting, lighting, and composition as shown. The video starts on this frame; describe it faithfully, then narrate chronologically as the user's requested action unfolds from it. Never contradict, replace, or invent things not consistent with the image. Single continuous take — no hard cuts.

Match this captioning style precisely:

1. Begin immediately with the action or visual detail. Do NOT use "The scene opens…", "We see…", "There is…".

2. Objective, observable description only. Do not infer emotions or intentions — describe what is visible and audible (e.g. not "he looks sad" but "his eyebrows angle downward and his lips are pressed together").

3. Full visual detail: environment (materials, textures, lighting, colors), character appearance (clothing, posture, facial details), and the spatial positioning of all elements — grounded in and consistent with the reference image. When a human appears, identify them specifically (gendered terms when clearly implied; differentiate multiple people consistently) and describe visible physical attributes — apparent gender presentation, skin tone, estimated age group, hair color/length/style, build, clothing and accessories. Do not infer ethnicity, nationality, religion, or culture.

4. Precise motion and cinematic description. For every shot you MUST include, woven naturally into the prose (never as tags or labels):
   - Shot type (exactly one: extreme wide shot / wide shot / medium shot / medium close-up / close-up / extreme close-up) — consistent with how the reference image is framed at the start.
   - Camera motion (always stated; if none, explicitly say the camera remains static). Camera movement is expected and good — match the user if they specified it, otherwise choose the treatment that best presents the requested scene starting from this frame.
   - Camera viewpoint relative to subject (front-facing / back-facing / side view / over-the-shoulder / top-down / low-angle / high-angle) — matching the reference image's viewpoint at the opening.
   Express these as flowing prose: "a medium shot frames…, captured from a front-facing angle as the camera slowly pans…". Never as "medium shot, static camera —".

5. Complete soundscape, integrated naturally: any dialogue (quote it exactly, in the original language), tone of voice, background music (type, mood, volume changes), and environmental sounds (footsteps, wind, traffic, animals). If the request implies sound, describe it plausibly.

6. Strict chronological, real-time flow using transitions like "Initially…", "A moment later…", "Simultaneously…". Keep the user's requested motion/action central and in motion throughout.

7. One single continuous paragraph. No bullet points, no section headers, no labels like "Audio:" or "Visual:". Exhaustive and lossless — include background elements, subtle movements, lighting, secondary sounds — detailed enough to reconstruct the scene. Aim for a rich, complete paragraph (roughly 150–220 words).

If the user wrote in another language, produce the English caption of the same content. Output ONLY the caption text — no JSON, no preamble.

AESTHETIC QUALITY (in addition to the above, without breaking the objective caption style or contradicting the reference image): render the described scene with strong visual production value — cinematic, film-grade color and contrast, beautiful natural lighting, crisp fine detail and texture, pleasing composition and depth. Weave these quality descriptors naturally into the same observable prose (e.g. "warm cinematic lighting", "richly saturated film-grade color", "crisp high-resolution detail") — describe how the exact requested scene, starting from this frame, LOOKS at its most visually striking, never adding new objects or actions and never contradicting the first frame. Keep everything else (first-frame grounding, framing triple, soundscape, chronological single paragraph, faithfulness) exactly as specified.`;

/**
 * The app's own words, sent after the vendored instruction and never inside
 * it (review C-1). The instruction expects the reference image beside the
 * request, but this endpoint is sent words only: told so, the model writes the
 * motion the person asked for instead of describing a picture it would have
 * to make up, which LTX would then follow away from the person's own picture
 * (the I2V guidance is the same: do not re-describe what is already visible).
 * The house rules are the feasibility study's (`docs/plans/ltx-video/
 * feasibility.md`, "Limits observed"): a push-in overshoots into a dark crop,
 * a second person is cropped out of frame, and text drifts out of it.
 * ASCII English, like everything the app writes into a model request
 * (ruling 79).
 */
export const VIDEO_CAPTION_HOUSE_RULES = `No image is attached to this request: you are not shown the reference image. Never invent how the subject, any person, their clothing, the setting, the colors or the lighting look; name them only as the user's request does, and otherwise refer to them plainly (the subject, the person, the room). The video model is given the image itself and keeps its look. Spend the caption on what moves and how: the requested action, the camera and the sound.

House rules for these clips, over the instruction above:
- The camera stays static, as on a tripod, unless the user asks for a camera move; it never pushes in or crops.
- Everyone and everything in the first frame stays in frame.
- No on-screen text, titles, captions or logos.
- The caption covers five seconds of action.`;

/**
 * The second engine variant's app block, sent INSTEAD of the house rules and
 * never beside them. The renderability rules that still apply are kept word for
 * word; the sound belongs in the instruction's one paragraph, not a section of
 * its own. A take that starts from text gets `VIDEO_CAPTION_TEXT_RULES`, this
 * block with its frame rule replaced by a no-image correction. ASCII English
 * (ruling 79).
 */
export const VIDEO_CAPTION_ALT_RULES = `The user's own words set what to describe: describe the subject, clothing, action and state exactly as the request names them, and show what changes as the action unfolds. Stay with their request: do not add people, objects or events the request did not name, and leave out nothing it did name. Expand the request faithfully into the instruction's caption style, with the sound woven into the same single paragraph as the picture.

House rules for these clips, over the instruction above:
- A single continuous take, no cuts.
- The camera stays static, as on a tripod, unless the user asks for a camera move; it never pushes in or crops.
- Everyone and everything in the first frame stays in frame.
- No on-screen text, titles, captions or logos.
- The caption covers five seconds of action.`;

/**
 * The alt block for a take that starts from text: the same block without the
 * rule that keeps what the opening already holds, which only a take starting on
 * a still can obey. In its place it corrects the vendored instruction's premise
 * — no reference image is attached — and asks the caption to establish the
 * scene from the person's own words, saying plainly that inventing that detail
 * is right here, unlike a picture take whose frame already fixes it. It never
 * claims a frame cannot exist: a continuation's opening frame is the previous
 * segment's last frame. Everything the alt block still asks for is kept: one
 * continuous take, the static camera, no on-screen text, five seconds, and no
 * addition beyond the request. ASCII English (ruling 79).
 */
export const VIDEO_CAPTION_TEXT_RULES = `The user's own words set what to describe: describe the subject, clothing, action and state exactly as the request names them, and show what changes as the action unfolds. No reference image is attached: the request alone supplies the scene, so establish its subject, setting and light from the person's words yourself. Inventing that detail is right here, unlike a picture take whose frame already fixes it. Stay with their request: do not add people, objects or events the request did not name, and leave out nothing it did name. Expand the request faithfully into the instruction's caption style, with the sound woven into the same single paragraph as the picture.

House rules for these clips, over the instruction above:
- A single continuous take, no cuts.
- The camera stays static, as on a tripod, unless the user asks for a camera move; it never pushes in or crops.
- No on-screen text, titles, captions or logos.
- The caption covers five seconds of action.`;

/**
 * The note that makes a caption the SECOND five seconds of a ten-second clip
 * (review C-2): segment 2 starts on segment 1's last frame, so its caption goes
 * on from there. Sent the same caption, it replayed the action from its start
 * and spoke the same dialogue twice. `first` is segment 1's caption, data.
 * No take asks for one since a ten-second clip became one render.
 */
export function videoContinuationNote(first: string): string {
	return `This caption is for the SECOND five seconds of a ten-second clip. Its first frame is the last frame of the first five seconds, which were captioned as follows:

${first}

Continue from that last moment: describe only what happens in the next five seconds, as the action goes on. Do not start the action over, do not repeat what already happened, and do not repeat any dialogue already spoken.`;
}

/**
 * The caption request's one system message: the vendored instruction first and
 * unchanged, then the variant's own rules, each after a blank line, and the
 * continuation note last. Never several system messages: Qwen's chat template
 * refuses a system message anywhere but first, and the endpoint answers 400
 * ("System message must be at the beginning."). Measured on the box on
 * 2026-11-17, when the house rules went in a second message: every caption
 * failed and fell back to the person's words.
 */
function captionSystemMessage(rules: string, note?: string): string {
	return [LTX24_I2V_INSTRUCTION, rules, ...(note ? [note] : [])].join("\n\n");
}

/**
 * The app's block for a variant: the house rules, the alt block, or, for an
 * alt take that starts from text, the text-take block.
 */
function captionRules(variant: LtxVideoVariant, fromText: boolean): string {
	if (variant !== "alt") return VIDEO_CAPTION_HOUSE_RULES;
	return fromText ? VIDEO_CAPTION_TEXT_RULES : VIDEO_CAPTION_ALT_RULES;
}

/**
 * What a caption call may be given: the engine variant, whether the take starts
 * from text, and the caller's fetch.
 */
type VideoCaptionOptions = {
	variant?: LtxVideoVariant;
	/**
	 * True when the take starts from the person's words alone: the alt block's
	 * frame-bound rule is for a take that starts on a still, so an alt text
	 * take gets the text-take block instead. Defaults to false.
	 */
	fromText?: boolean;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
};

/**
 * A caption that speaks of an image it was not shown answered the request, not
 * the clip ("I can't see the image, but…"): sent to LTX it would be rendered as
 * if it were the scene, so the person's own words are used instead.
 */
const UNSEEN_IMAGE =
	/\b(?:can(?:no|')t|cannot|unable to|could not|couldn't)\s+(?:see|view|access)\b[^.]{0,40}\b(?:image|picture|photo)\b|\bno (?:reference )?(?:image|picture|photo) (?:was |is )?(?:provided|attached|given|shown)\b|\b(?:image|picture|photo) (?:was |is )?not (?:provided|attached|given|shown)\b/i;

/** A caption longer than this is cut: the take's prompt is not a place for a runaway model. */
export const VIDEO_CAPTION_MAX_CHARS = 4000;
/** The rewrite is one short generation; past this the idea is used unchanged. */
export const VIDEO_CAPTION_TIMEOUT_MS = 15_000;

/**
 * What the take renders as its prompt: the caption the configured endpoint
 * wrote, or the motion idea when no endpoint is set, the call fails, or it
 * answers nothing usable.
 */
export async function buildVideoPrompt(
	idea: string,
	options: VideoCaptionOptions = {},
): Promise<string> {
	const motion = idea.trim();
	if (!isVideoCaptionConfigured()) return motion;
	try {
		const caption = await requestCaption(motion, options);
		if (caption && UNSEEN_IMAGE.test(caption)) {
			console.warn(
				"[VIDEO] The caption spoke of an image it was not shown; using the motion idea",
			);
			return motion;
		}
		return caption ?? motion;
	} catch (error) {
		console.warn("[VIDEO] The caption step failed; using the motion idea", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return motion;
	}
}

/**
 * A 10 s take's second segment's caption: what happens next, from where the
 * first five seconds (`first`) end. Null when there is no caption endpoint or
 * it gives nothing usable: the segment then renders the first prompt again.
 * No take asks for one since a ten-second clip became one render.
 */
export async function buildVideoContinuationPrompt(
	idea: string,
	first: string,
	options: VideoCaptionOptions = {},
): Promise<string | null> {
	if (!isVideoCaptionConfigured()) return null;
	try {
		const caption = await requestCaption(
			idea.trim(),
			options,
			videoContinuationNote(first),
		);
		if (!caption || UNSEEN_IMAGE.test(caption)) return null;
		return caption;
	} catch (error) {
		console.warn("[VIDEO] The second segment's caption failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** One OpenAI-compatible chat completion; the caption, or null for nothing usable. */
async function requestCaption(
	motion: string,
	options: VideoCaptionOptions,
	note?: string,
): Promise<string | null> {
	const url = buildOpenAICompatibleUrl(
		getLtxCaptionUrl(),
		"/v1/chat/completions",
	);
	const apiKey = getLtxCaptionApiKey().trim();
	const timeout = AbortSignal.timeout(VIDEO_CAPTION_TIMEOUT_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: getLtxCaptionModel(),
			messages: [
				{
					role: "system",
					content: captionSystemMessage(
						captionRules(
							options.variant ?? "standard",
							options.fromText === true,
						),
						note,
					),
				},
				{ role: "user", content: `User Raw Input Prompt: ${motion}.` },
			],
			temperature: 0,
			stream: false,
			// A reasoning model answers with its thinking and an empty `content`
			// (measured: 2.8k tokens of reasoning, 0 characters of caption, and the
			// token cap spent before the answer started), so the rewrite asks for
			// the template without thinking. A server that does not know the field
			// ignores it, and one that rejects it fails into the same fallback the
			// person's own wording is.
			chat_template_kwargs: { enable_thinking: false },
			max_tokens: 1200,
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`The caption endpoint answered ${response.status}.`);
	}
	const body: unknown = await response.json();
	return readCaption(body);
}

/** The one string an OpenAI-compatible answer carries, trimmed and bounded. */
function readCaption(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const choices = (body as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0];
	if (!first || typeof first !== "object") return null;
	const message = (first as { message?: unknown }).message;
	if (!message || typeof message !== "object") return null;
	const content = (message as { content?: unknown }).content;
	if (typeof content !== "string") return null;
	const caption = content.trim();
	return caption ? caption.slice(0, VIDEO_CAPTION_MAX_CHARS) : null;
}
