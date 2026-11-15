// The caption step of a video take: the person's motion idea, rewritten by an
// LLM the admin configured, in the style LTX-2.5 was trained to read. The
// instruction is ComfyUI's own (`comfy_extras/nodes_textgen.py`'s
// `LTX24_I2V_SYSTEM_PROMPT`), vendored here and pinned by a test rather than
// read from a ComfyUI checkout at runtime: the take is rendered on a server
// that may hold no ComfyUI source at all, and the wording is part of the
// model's contract, not something this app may drift.
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
	options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<string> {
	const motion = idea.trim();
	if (!isVideoCaptionConfigured()) return motion;
	try {
		const caption = await requestCaption(motion, options);
		return caption ?? motion;
	} catch (error) {
		console.warn("[VIDEO] The caption step failed; using the motion idea", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return motion;
	}
}

/** One OpenAI-compatible chat completion; the caption, or null for nothing usable. */
async function requestCaption(
	motion: string,
	options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
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
				{ role: "system", content: LTX24_I2V_INSTRUCTION },
				{ role: "user", content: `User Raw Input Prompt: ${motion}.` },
			],
			temperature: 0,
			stream: false,
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
