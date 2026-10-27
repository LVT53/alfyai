import { generateText } from "ai";
import { normalizeAssistantOutput } from "$lib/server/services/chat-turn/normalizer";
import {
	buildNormalChatModelRunProviderOptions,
	createOpenAICompatibleProviderForNormalChatModelRun,
	type NormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import { resolveModelCallSampling } from "$lib/server/services/normal-chat-model/sampling";
import { DEFAULT_MODEL_MAX_RETRIES } from "$lib/server/services/normal-chat-model-config";
import { normalizeWhitespace } from "$lib/server/utils/text";
import {
	getImageDescriptions,
	saveImageDescription,
} from "./descriptions-store";
import type { PreparedImage } from "./prepare-image";
import { providerCanSeeImages } from "./provider-vision";
import type { TurnImage } from "./turn-images";

// What a picture shows, in a few words, so a later turn carries the words and
// not the pixels (vision/AGENTS.md). The model that was just shown the picture
// is asked once, in the background, and the answer is stored against the
// artifact (descriptions-store.ts). It is never part of the turn: a description
// that fails, times out or comes back empty stores nothing, and history keeps
// the file name instead.

/**
 * What the model is asked about a picture. English whatever the person writes:
 * it is scaffolding the model reads, and the description it makes is for a
 * model to read in a later turn (ruling 79).
 */
export const IMAGE_DESCRIPTION_PROMPT =
	"Describe this image for someone who cannot see it, in at most 60 words. Name the main subject, the setting and any visible text, and quote short text exactly. Use plain sentences.";

/** 60 words fit well inside it; the cap stops a model that rambles. */
const IMAGE_DESCRIPTION_MAX_TOKENS = 160;

/**
 * A description that has not come back by now is given up. Calls run one at a
 * time per person, so a stuck one would hold every picture behind it.
 */
const IMAGE_DESCRIPTION_TIMEOUT_MS = 60_000;

/**
 * Asks the model that can see to describe one prepared picture. The request is
 * one user message holding the prompt and the picture. It takes the provider
 * family's sampling like every other call (Flash-Next's own default of
 * temperature 1.0 is not what the family is run at), and turns thinking off in
 * the form the server reads, as the app's other short calls do: a thinking
 * model can spend 160 tokens on reasoning and answer nothing. Throws when the
 * request fails and when nothing usable comes back.
 */
export async function describeImage(params: {
	provider: NormalChatModelRunProvider;
	image: PreparedImage;
	signal?: AbortSignal;
}): Promise<string> {
	const { provider, image } = params;
	const openaiCompatible = createOpenAICompatibleProviderForNormalChatModelRun({
		provider,
		normalizeStreaming: false,
	});
	// The one sampling route (normal-chat-model/sampling.ts). A description is
	// read by a model, but it is not a machine-read verdict, so it names no
	// temperature of its own. top_k reaches the wire through the provider builder.
	const sampling = resolveModelCallSampling(provider);
	const result = await generateText({
		model: openaiCompatible(provider.modelName),
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: IMAGE_DESCRIPTION_PROMPT },
					{
						type: "image",
						image: image.base64,
						mediaType: image.mediaType,
					},
				],
			},
		],
		temperature: sampling.temperature,
		topP: sampling.topP,
		maxOutputTokens: IMAGE_DESCRIPTION_MAX_TOKENS,
		maxRetries: DEFAULT_MODEL_MAX_RETRIES,
		abortSignal: params.signal,
		timeout: IMAGE_DESCRIPTION_TIMEOUT_MS,
		providerOptions: buildNormalChatModelRunProviderOptions(provider, "off"),
	});

	// Through the normalizer every assistant text takes, titles among them: a
	// closed think block goes, and reasoning that was cut off leaves nothing,
	// which is not a description. Then one line, so it sits in a history line.
	const description = normalizeWhitespace(
		normalizeAssistantOutput(result.text),
	);
	if (!description) {
		throw new Error("The model returned no description of the image");
	}
	return description;
}

/** A picture whose description is queued or being written, as `person:artifact`. */
const pending = new Set<string>();

/** Where each person's description calls queue up: the tail of their chain. */
const queues = new Map<string, Promise<void>>();

function enqueue(userId: string, task: () => Promise<void>): void {
	const tail = (queues.get(userId) ?? Promise.resolve()).then(task);
	queues.set(userId, tail);
	// `task` handles its own failures, so the chain never rejects; the entry only
	// goes once nothing newer was queued behind it.
	void tail.then(() => {
		if (queues.get(userId) === tail) queues.delete(userId);
	});
}

async function describeAndStore(params: {
	userId: string;
	provider: NormalChatModelRunProvider;
	picture: TurnImage;
}): Promise<void> {
	const { userId, provider, picture } = params;
	// Checked when its turn in the queue comes, not when it was scheduled: the
	// same photo attached again is the same artifact, and an earlier call for it
	// may have finished since.
	const stored = await getImageDescriptions(userId, [picture.artifactId]);
	if (stored.has(picture.artifactId)) return;
	const description = await describeImage({
		provider,
		image: picture.image,
	});
	await saveImageDescription({
		userId,
		artifactId: picture.artifactId,
		description,
		modelName: provider.modelName,
	});
}

/**
 * Describes, in the background, the pictures a turn sent to the model, so the
 * turns after it can carry a description instead of pixels. Never blocks and
 * never fails the turn: it returns at once, calls run one at a time per person,
 * a picture that already has a description (or is already being described) is
 * skipped, and a failure is logged and stores nothing. Only a model that can
 * see is asked: the pictures are the ones it was sent.
 */
export function scheduleImageDescriptions(params: {
	userId: string;
	provider: NormalChatModelRunProvider;
	images: readonly TurnImage[];
}): void {
	const { userId, provider } = params;
	if (!providerCanSeeImages(provider)) return;
	for (const picture of params.images) {
		const key = `${userId}:${picture.artifactId}`;
		// Claimed before anything awaits, so two schedules in a row make one call.
		if (pending.has(key)) continue;
		pending.add(key);
		enqueue(userId, async () => {
			try {
				await describeAndStore({ userId, provider, picture });
			} catch (error) {
				// Content-free on purpose: the artifact and the reason, never the
				// picture or the words about it.
				console.warn("[ATTACHMENTS] Image not described", {
					artifactId: picture.artifactId,
					reason: error instanceof Error ? error.message : String(error),
				});
			} finally {
				pending.delete(key);
			}
		});
	}
}
