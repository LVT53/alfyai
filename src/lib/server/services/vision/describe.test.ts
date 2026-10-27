import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCapabilitySet } from "$lib/model-capabilities";
import { db } from "$lib/server/db";
import { artifacts, imageDescriptions, users } from "$lib/server/db/schema";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import {
	describeImage,
	IMAGE_DESCRIPTION_PROMPT,
	scheduleImageDescriptions,
} from "./describe";
import {
	getImageDescriptions,
	saveImageDescription,
} from "./descriptions-store";
import type { PreparedImage } from "./prepare-image";
import type { TurnImage } from "./turn-images";

// The description call goes through the app's own provider factory, so what is
// checked here is what leaves on the wire (a fake `fetch`), never what the code
// seems to pass. The database is the shared test one (src/vitest-setup.ts).

const KITCHEN = "A small white kitchen with a window.";

let fetchMock: ReturnType<typeof vi.fn>;
const seededUsers: string[] = [];

function chatCompletion(content: string) {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-1",
			model: "served-model",
			created: 1_717_171_717,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1700, completion_tokens: 12, total_tokens: 1712 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** The JSON body of the n-th request that actually left. */
function sentBody(call = 0): Record<string, unknown> {
	const init = fetchMock.mock.calls[call]?.[1] as
		| { body?: unknown }
		| undefined;
	expect(init, `request ${call} never reached the fake fetch`).toBeDefined();
	return JSON.parse(String(init?.body ?? "{}"));
}

/** A request that stays open until the test lets its reply out. */
function heldReply() {
	let release!: (text: string) => void;
	const text = new Promise<string>((resolve) => {
		release = resolve;
	});
	return { text, release };
}

function preparedImage(): PreparedImage {
	return {
		base64: "QUJD",
		mediaType: "image/jpeg",
		width: 64,
		height: 48,
		estimatedTokens: 6,
	};
}

const SEEING = createModelCapabilitySet({
	imageMessageParts: {
		state: "manual_override",
		supported: true,
		source: "manual_override",
	},
});

function seeingProvider(
	overrides: Partial<NormalChatModelRunProvider> = {},
): NormalChatModelRunProvider {
	return {
		id: "local",
		name: "local",
		displayName: "Local",
		baseUrl: "http://192.168.1.96:30000/v1",
		modelName: "qwen3-8-flash-next",
		apiKey: "key",
		capabilities: SEEING,
		...overrides,
	};
}

async function seedUser(): Promise<string> {
	const id = `user-${randomUUID()}`;
	await db
		.insert(users)
		.values({ id, email: `${id}@example.com`, passwordHash: "hash" });
	seededUsers.push(id);
	return id;
}

async function seedPicture(userId: string, name: string): Promise<TurnImage> {
	const id = `artifact-${randomUUID()}`;
	await db.insert(artifacts).values({
		id,
		userId,
		type: "source_document",
		name,
		mimeType: "image/jpeg",
	});
	return { artifactId: id, name, image: preparedImage() };
}

async function descriptionOf(userId: string, artifactId: string) {
	return (await getImageDescriptions(userId, [artifactId])).get(artifactId);
}

async function waitForDescription(userId: string, artifactId: string) {
	await vi.waitFor(
		async () => {
			expect(await descriptionOf(userId, artifactId)).toBeTypeOf("string");
		},
		{ timeout: 4000 },
	);
}

beforeEach(() => {
	fetchMock = vi.fn(async () => chatCompletion(KITCHEN));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const id of seededUsers.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("describeImage", () => {
	it("sends one user message with the prompt and the picture, capped at 160 tokens, and returns the trimmed text", async () => {
		fetchMock.mockResolvedValue(chatCompletion(`  ${KITCHEN}\n `));

		const description = await describeImage({
			provider: seeingProvider(),
			image: preparedImage(),
		});

		expect(description).toBe(KITCHEN);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = sentBody();
		expect(body.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: IMAGE_DESCRIPTION_PROMPT },
					{
						type: "image_url",
						image_url: { url: "data:image/jpeg;base64,QUJD" },
					},
				],
			},
		]);
		expect(body.max_tokens).toBe(160);
	});

	// A photo of a Hungarian sign must come back as an English sentence that
	// quotes the sign's words as they are written, so history reads the same
	// whatever language the picture holds.
	it("asks for a short plain description in English, with visible text quoted as written, in plain ASCII", () => {
		expect(IMAGE_DESCRIPTION_PROMPT).toBe(
			"Describe this image in English for someone who cannot see it, in at most 60 words. Name the main subject, the setting and any visible text, and quote short text exactly as written. Use plain sentences.",
		);
		expect(IMAGE_DESCRIPTION_PROMPT).toMatch(/^[\x20-\x7e]+$/);
	});

	it("throws when the model answers with nothing", async () => {
		fetchMock.mockResolvedValue(chatCompletion("  \n "));

		await expect(
			describeImage({ provider: seeingProvider(), image: preparedImage() }),
		).rejects.toThrow(/no description/i);
	});

	it("keeps the description on one line", async () => {
		fetchMock.mockResolvedValue(
			chatCompletion("A white kitchen.\n\nA window over the sink.\n"),
		);

		await expect(
			describeImage({ provider: seeingProvider(), image: preparedImage() }),
		).resolves.toBe("A white kitchen. A window over the sink.");
	});

	it("takes the family's sampling and turns thinking off in the form the server reads (qwen)", async () => {
		await describeImage({ provider: seeingProvider(), image: preparedImage() });

		const body = sentBody();
		// Flash-Next ships temperature 1.0; the family's profile is 0.6 / 0.95 / 20.
		expect(body).toMatchObject({ temperature: 0.6, top_p: 0.95, top_k: 20 });
		// A thinking model can spend 160 tokens on reasoning and answer nothing.
		// vLLM reads the switch from chat_template_kwargs (the form the other
		// short calls are checked in: internal-call-thinking.wire.test.ts).
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("sends a family with no sampling profile none of the three, and no thinking switch", async () => {
		await describeImage({
			provider: seeingProvider({
				name: "cloud",
				displayName: "Cloud",
				baseUrl: "https://openai-compatible.example/v1",
				modelName: "gpt-4.1",
			}),
			image: preparedImage(),
		});

		const body = sentBody();
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("top_p");
		expect(body).not.toHaveProperty("top_k");
		expect(body).not.toHaveProperty("chat_template_kwargs");
	});

	it("drops a think block a model wrote into its answer anyway", async () => {
		fetchMock.mockResolvedValue(
			chatCompletion(`<think>\nA kitchen, probably.\n</think>\n\n${KITCHEN}`),
		);

		await expect(
			describeImage({ provider: seeingProvider(), image: preparedImage() }),
		).resolves.toBe(KITCHEN);
	});

	it("throws on reasoning that was cut off, rather than storing it as a description", async () => {
		fetchMock.mockResolvedValue(
			chatCompletion("<think>\nThe user wants a description of a kitchen and"),
		);

		await expect(
			describeImage({ provider: seeingProvider(), image: preparedImage() }),
		).rejects.toThrow(/no description/i);
	});

	it("rejects when the request fails", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { message: "overloaded", type: "server_error" },
				}),
				{ status: 503, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(
			describeImage({ provider: seeingProvider(), image: preparedImage() }),
		).rejects.toThrow();
	});

	it("stops when the caller's signal aborts", async () => {
		fetchMock.mockImplementation(
			(_url: unknown, init?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason ?? new Error("aborted")),
					);
				}),
		);
		const controller = new AbortController();

		const pending = describeImage({
			provider: seeingProvider(),
			image: preparedImage(),
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		controller.abort();

		await expect(pending).rejects.toThrow();
	});
});

describe("scheduleImageDescriptions", () => {
	it("describes a picture in the background and stores the description with the model that wrote it", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId, "kitchen.jpg");
		const provider = seeingProvider({ modelName: "qwen3-8-flash-next" });

		expect(
			scheduleImageDescriptions({ userId, provider, images: [kitchen] }),
		).toBeUndefined();
		await waitForDescription(userId, kitchen.artifactId);

		expect(await descriptionOf(userId, kitchen.artifactId)).toBe(KITCHEN);
		const [row] = await db
			.select()
			.from(imageDescriptions)
			.where(eq(imageDescriptions.artifactId, kitchen.artifactId));
		expect(row).toMatchObject({ userId, modelName: "qwen3-8-flash-next" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("skips an artifact that already has a description", async () => {
		const userId = await seedUser();
		const already = await seedPicture(userId, "already.jpg");
		const marker = await seedPicture(userId, "marker.jpg");
		await saveImageDescription({
			userId,
			artifactId: already.artifactId,
			description: "Stored earlier.",
			modelName: "old-model",
		});
		const provider = seeingProvider();

		scheduleImageDescriptions({ userId, provider, images: [already] });
		// One person's calls run in the order they were scheduled, so when the
		// marker is described the picture before it has had its turn.
		scheduleImageDescriptions({ userId, provider, images: [marker] });
		await waitForDescription(userId, marker.artifactId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await descriptionOf(userId, already.artifactId)).toBe(
			"Stored earlier.",
		);
	});

	it("makes one call when the same artifact is scheduled twice while the first is in flight", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId, "kitchen.jpg");
		const marker = await seedPicture(userId, "marker.jpg");
		const provider = seeingProvider();
		const held = heldReply();
		fetchMock.mockImplementationOnce(async () =>
			chatCompletion(await held.text),
		);

		scheduleImageDescriptions({ userId, provider, images: [kitchen] });
		scheduleImageDescriptions({ userId, provider, images: [kitchen] });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		held.release(KITCHEN);
		await waitForDescription(userId, kitchen.artifactId);

		// The same photo attached again in a later turn is the same artifact: the
		// stored description is reused, not written twice (Review Focus 1).
		scheduleImageDescriptions({ userId, provider, images: [kitchen] });
		scheduleImageDescriptions({ userId, provider, images: [marker] });
		await waitForDescription(userId, marker.artifactId);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const rows = await db
			.select()
			.from(imageDescriptions)
			.where(eq(imageDescriptions.artifactId, kitchen.artifactId));
		expect(rows).toHaveLength(1);
	});

	it("does not ask again for a picture whose call is still in flight, even when that call fails", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId, "kitchen.jpg");
		const marker = await seedPicture(userId, "marker.jpg");
		const provider = seeingProvider();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const held = heldReply();
		// Nothing is stored when it fails, so a second ask queued behind it would
		// not find a description to reuse and would spend a call of its own.
		fetchMock.mockImplementationOnce(async () => {
			await held.text;
			return new Response(
				JSON.stringify({ error: { message: "boom", type: "server_error" } }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		});

		scheduleImageDescriptions({ userId, provider, images: [kitchen] });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		scheduleImageDescriptions({ userId, provider, images: [kitchen] });
		held.release("");
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
		scheduleImageDescriptions({ userId, provider, images: [marker] });
		await waitForDescription(userId, marker.artifactId);

		// The failed call, then the marker's. Not a retry of the kitchen.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await descriptionOf(userId, kitchen.artifactId)).toBeUndefined();
	});

	it("makes one call at a time for a person", async () => {
		const userId = await seedUser();
		const first = await seedPicture(userId, "first.jpg");
		const second = await seedPicture(userId, "second.jpg");
		const heldFirst = heldReply();
		const heldSecond = heldReply();
		fetchMock
			.mockImplementationOnce(async () => chatCompletion(await heldFirst.text))
			.mockImplementationOnce(async () =>
				chatCompletion(await heldSecond.text),
			);

		scheduleImageDescriptions({
			userId,
			provider: seeingProvider(),
			images: [first, second],
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		heldFirst.release("The first picture.");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		heldSecond.release("The second picture.");
		await waitForDescription(userId, second.artifactId);

		expect(await descriptionOf(userId, first.artifactId)).toBe(
			"The first picture.",
		);
		expect(await descriptionOf(userId, second.artifactId)).toBe(
			"The second picture.",
		);
	});

	it("does not make one person's call wait for another's", async () => {
		const slowUser = await seedUser();
		const quickUser = await seedUser();
		const slow = await seedPicture(slowUser, "slow.jpg");
		const quick = await seedPicture(quickUser, "quick.jpg");
		const held = heldReply();
		fetchMock.mockImplementationOnce(async () =>
			chatCompletion(await held.text),
		);
		const provider = seeingProvider();

		scheduleImageDescriptions({
			userId: slowUser,
			provider,
			images: [slow],
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		scheduleImageDescriptions({
			userId: quickUser,
			provider,
			images: [quick],
		});
		await waitForDescription(quickUser, quick.artifactId);

		expect(await descriptionOf(slowUser, slow.artifactId)).toBeUndefined();
		held.release("The slow one.");
		await waitForDescription(slowUser, slow.artifactId);
	});

	it("stores nothing and throws nothing when the call fails, and tries again next time (Review Focus 4)", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId, "kitchen.jpg");
		const provider = seeingProvider();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ error: { message: "boom", type: "server_error" } }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			),
		);

		expect(() =>
			scheduleImageDescriptions({ userId, provider, images: [kitchen] }),
		).not.toThrow();
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());

		expect(await descriptionOf(userId, kitchen.artifactId)).toBeUndefined();
		// The failure says which picture and why, and nothing from the picture.
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain(kitchen.artifactId);
		expect(logged).not.toContain("QUJD");

		// The person's queue is not stuck on it, and nothing marks the picture as
		// tried: the next turn that carries it asks again.
		scheduleImageDescriptions({ userId, provider, images: [kitchen] });
		await waitForDescription(userId, kitchen.artifactId);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("stores nothing when the model answers with nothing", async () => {
		const userId = await seedUser();
		const kitchen = await seedPicture(userId, "kitchen.jpg");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockResolvedValueOnce(chatCompletion(" "));

		scheduleImageDescriptions({
			userId,
			provider: seeingProvider(),
			images: [kitchen],
		});
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());

		expect(await descriptionOf(userId, kitchen.artifactId)).toBeUndefined();
	});

	it("describes nothing for a model that cannot see", async () => {
		const userId = await seedUser();
		const blind = await seedPicture(userId, "blind.jpg");
		const marker = await seedPicture(userId, "marker.jpg");

		scheduleImageDescriptions({
			userId,
			provider: seeingProvider({ capabilities: undefined }),
			images: [blind],
		});
		scheduleImageDescriptions({
			userId,
			provider: seeingProvider(),
			images: [marker],
		});
		await waitForDescription(userId, marker.artifactId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await descriptionOf(userId, blind.artifactId)).toBeUndefined();
	});

	it("does nothing for a turn with no pictures", async () => {
		const userId = await seedUser();

		expect(() =>
			scheduleImageDescriptions({
				userId,
				provider: seeingProvider(),
				images: [],
			}),
		).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
