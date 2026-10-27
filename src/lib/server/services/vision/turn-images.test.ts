import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ModelMessage } from "ai";
import sharp from "sharp";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { PromptAttachmentResolutionItem } from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/server/services/knowledge/types";

const mocks = vi.hoisted(() => ({ prepareImageForModel: vi.fn() }));

// The real preparation, behind a spy that the concurrency test can slow down.
vi.mock("./prepare-image", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./prepare-image")>();
	return {
		...actual,
		prepareImageForModel: (
			...args: Parameters<typeof actual.prepareImageForModel>
		) => mocks.prepareImageForModel(...args),
	};
});

import type { PreparedImage } from "./prepare-image";
import {
	buildCurrentUserMessage,
	buildTurnImageGuidance,
	CANNOT_SEE_IMAGES_GUIDANCE,
	collectTurnImages,
	heldBackImagesGuidance,
	MAX_TURN_IMAGES,
	type NumberedTurnImage,
	noTurnImages,
	notShownImageGuidance,
	oneLineName,
	resolveTurnImages,
	STRIPPED_IMAGE_NOTE,
	stripImageParts,
	sumTurnImageTokens,
} from "./turn-images";

const actualPrepare = (
	await vi.importActual<typeof import("./prepare-image")>("./prepare-image")
).prepareImageForModel;

let directory: string;

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "alfyai-turn-images-"));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
	mocks.prepareImageForModel.mockReset();
	mocks.prepareImageForModel.mockImplementation(actualPrepare);
});

function preparedImage(overrides: Partial<PreparedImage> = {}): PreparedImage {
	return {
		base64: "QUJD",
		mediaType: "image/jpeg",
		width: 64,
		height: 48,
		estimatedTokens: 6,
		...overrides,
	};
}

function turnImage(
	name: string,
	overrides: Partial<PreparedImage> = {},
	number = 1,
) {
	return {
		number,
		artifactId: `artifact-${name}`,
		name,
		image: preparedImage(overrides),
	} satisfies NumberedTurnImage;
}

async function pngBytes(width = 40, height = 30): Promise<Buffer> {
	return sharp({
		create: { width, height, channels: 3, background: "#3366cc" },
	})
		.png()
		.toBuffer();
}

/** A stored file the way an upload keeps it: a path relative to the working directory. */
async function storeFile(name: string, bytes: Uint8Array): Promise<string> {
	const absolute = join(directory, name);
	await mkdir(directory, { recursive: true });
	await writeFile(absolute, bytes);
	return relative(process.cwd(), absolute);
}

function artifact(overrides: Partial<Artifact>): Artifact {
	return {
		id: "artifact-1",
		userId: "user-1",
		type: "source_document",
		retrievalClass: "durable",
		name: "photo.png",
		mimeType: "image/png",
		extension: "png",
		sizeBytes: 1,
		conversationId: "conv-1",
		summary: null,
		storagePath: null,
		contentText: null,
		metadata: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

/** The shape of an attachment with no extracted text yet, which is all a picture needs. */
function item(
	display: Artifact | null,
	overrides: Partial<PromptAttachmentResolutionItem> = {},
): PromptAttachmentResolutionItem {
	return {
		requestedArtifactId: display?.id ?? "missing",
		displayArtifact: display,
		promptArtifact: null,
		promptReady: false,
		readinessError: null,
		readinessErrorCode: null,
		contentLength: 0,
		contentPreview: null,
		contentHash: null,
		chunkCount: 0,
		extraction: null,
		...overrides,
	};
}

async function imageItem(
	index: number,
	overrides: Partial<Artifact> = {},
	bytes?: Uint8Array,
): Promise<PromptAttachmentResolutionItem> {
	const name = overrides.name ?? `photo-${index}.png`;
	const storagePath = await storeFile(
		`${index}-${name}`,
		bytes ?? (await pngBytes()),
	);
	return item(
		artifact({ id: `artifact-${index}`, name, storagePath, ...overrides }),
	);
}

describe("buildCurrentUserMessage", () => {
	it("puts the text first and each picture after it as an image part", () => {
		const image = turnImage("room.jpg");

		expect(buildCurrentUserMessage("hi", [image])).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "hi" },
				{ type: "text", text: "Picture 1: room.jpg" },
				{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
			],
		});
	});

	it("puts each picture's label right before it", () => {
		const image = preparedImage({ width: 10, height: 10, estimatedTokens: 1 });

		expect(
			buildCurrentUserMessage("hi", [
				{ number: 1, name: "a.jpg", image },
				{ number: 2, name: "b.png", image },
			]).content,
		).toEqual([
			{ type: "text", text: "hi" },
			{ type: "text", text: "Picture 1: a.jpg" },
			{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
			{ type: "text", text: "Picture 2: b.png" },
			{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
		]);
	});

	it("is a plain text message when there are no pictures", () => {
		expect(buildCurrentUserMessage("hi", [])).toEqual({
			role: "user",
			content: [{ type: "text", text: "hi" }],
		});
		expect(buildCurrentUserMessage("hi")).toEqual(
			buildCurrentUserMessage("hi", []),
		);
	});

	it("keeps the pictures in the order they were attached", () => {
		const message = buildCurrentUserMessage("compare", [
			turnImage("first.jpg", { base64: "Rklyc3Q=" }, 1),
			turnImage("second.jpg", { base64: "U2Vjb25k" }, 2),
		]);

		expect(message.content).toEqual([
			{ type: "text", text: "compare" },
			{ type: "text", text: "Picture 1: first.jpg" },
			{ type: "image", image: "Rklyc3Q=", mediaType: "image/jpeg" },
			{ type: "text", text: "Picture 2: second.jpg" },
			{ type: "image", image: "U2Vjb25k", mediaType: "image/jpeg" },
		]);
	});

	it("carries base64 strings, so the message survives JSON unchanged", () => {
		const message = buildCurrentUserMessage("hi", [turnImage("room.jpg")]);

		expect(JSON.parse(JSON.stringify(message))).toEqual(message);
	});
});

describe("stripImageParts", () => {
	const history: ModelMessage[] = [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: "Earlier question" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Let me look." },
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "research_web",
					input: { query: "room" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "research_web",
					output: { type: "text", value: "A page about rooms." },
				},
			],
		},
	];

	it("puts the note in the place of each picture and keeps the text", () => {
		const message = buildCurrentUserMessage("What is in these?", [
			turnImage("a.jpg", {}, 1),
			turnImage("b.jpg", {}, 2),
		]);

		expect(stripImageParts([message])).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in these?" },
					{ type: "text", text: "Picture 1: a.jpg" },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
					{ type: "text", text: "Picture 2: b.jpg" },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
				],
			},
		]);
	});

	it("returns a list with no picture in it as it is, by reference", () => {
		const messages: ModelMessage[] = [
			...history,
			buildCurrentUserMessage("Hello"),
		];

		expect(stripImageParts(messages)).toBe(messages);
		expect(stripImageParts([])).toEqual([]);
	});

	it("leaves every message without a picture untouched, by reference", () => {
		const current = buildCurrentUserMessage("What is this?", [
			turnImage("a.jpg"),
		]);
		const messages = [...history, current];

		const stripped = stripImageParts(messages);

		expect(stripped).toHaveLength(messages.length);
		history.forEach((message, index) => {
			expect(stripped[index]).toBe(message);
		});
		expect(stripped.at(-1)).not.toBe(current);
	});

	it("strips every message that carries a picture, not only the last", () => {
		const stripped = stripImageParts([
			buildCurrentUserMessage("first", [turnImage("a.jpg")]),
			{ role: "assistant", content: "A room." },
			buildCurrentUserMessage("second", [turnImage("b.jpg")]),
		]);

		expect(JSON.stringify(stripped)).not.toContain('"image"');
		expect(
			stripped.map((message) =>
				Array.isArray(message.content)
					? message.content.map((part) => part.type)
					: message.role,
			),
		).toEqual([
			["text", "text", "text"],
			"assistant",
			["text", "text", "text"],
		]);
	});

	it("keeps what else the message carries", () => {
		const stripped = stripImageParts([
			{
				role: "user",
				providerOptions: { local: { cache: true } },
				content: [
					{ type: "text", text: "Look", providerOptions: { local: { x: 1 } } },
					{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
					{ type: "text", text: "and tell me." },
				],
			},
		]);

		expect(stripped).toEqual([
			{
				role: "user",
				providerOptions: { local: { cache: true } },
				content: [
					{ type: "text", text: "Look", providerOptions: { local: { x: 1 } } },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
					{ type: "text", text: "and tell me." },
				],
			},
		]);
	});

	it("does not change the messages it was given", () => {
		const messages = [
			buildCurrentUserMessage("What is this?", [turnImage("a.jpg")]),
		];
		const before = structuredClone(messages);

		stripImageParts(messages);

		expect(messages).toEqual(before);
	});
});

describe("collectTurnImages", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warn.mockRestore();
	});

	it("prepares the first eight pictures and names the rest as held back", async () => {
		const items = await Promise.all(
			Array.from({ length: 10 }, (_, index) => imageItem(index)),
		);

		const { images, heldBack } = await collectTurnImages({
			items,
			maxImages: MAX_TURN_IMAGES,
		});

		expect(MAX_TURN_IMAGES).toBe(8);
		expect(images.map((entry) => entry.name)).toEqual(
			Array.from({ length: 8 }, (_, index) => `photo-${index}.png`),
		);
		expect(heldBack).toEqual([
			{ number: 9, name: "photo-8.png" },
			{ number: 10, name: "photo-9.png" },
		]);
		expect(images[0]?.artifactId).toBe("artifact-0");
		expect(images[0]?.image.mediaType).toBe("image/jpeg");
		expect(warn).not.toHaveBeenCalled();
	});

	it("numbers every image attachment in attachment order, one that cannot be shown included", async () => {
		const pdf = item(
			artifact({
				id: "artifact-pdf",
				name: "notes.pdf",
				mimeType: "application/pdf",
			}),
		);
		const items = [
			await imageItem(0, { name: "a.jpg", mimeType: "image/jpeg" }),
			pdf,
			await imageItem(2, { name: "old.bmp", mimeType: "image/bmp" }),
			await imageItem(3, { name: "c.png" }),
		];

		const turn = await collectTurnImages({ items, maxImages: 8 });

		expect(turn.images.map(({ number, name }) => [number, name])).toEqual([
			[1, "a.jpg"],
			[3, "c.png"],
		]);
		expect(turn.notShown).toEqual([{ number: 2, name: "old.bmp" }]);
	});

	it("does not decode a picture it will not send", async () => {
		const items = await Promise.all(
			Array.from({ length: 10 }, (_, index) => imageItem(index)),
		);

		await collectTurnImages({ items, maxImages: 8 });

		expect(mocks.prepareImageForModel).toHaveBeenCalledTimes(8);
	});

	it("prepares at most two pictures at a time", async () => {
		const items = await Promise.all(
			Array.from({ length: 7 }, (_, index) => imageItem(index)),
		);
		let running = 0;
		let peak = 0;
		mocks.prepareImageForModel.mockImplementation(
			async (...args: Parameters<typeof actualPrepare>) => {
				running += 1;
				peak = Math.max(peak, running);
				try {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return await actualPrepare(...args);
				} finally {
					running -= 1;
				}
			},
		);

		const { images } = await collectTurnImages({ items, maxImages: 8 });

		expect(images).toHaveLength(7);
		expect(peak).toBe(2);
	});

	it("sends a picture of the attachment budget, not the stored original", async () => {
		const big = await sharp({
			create: { width: 4032, height: 3024, channels: 3, background: "#888888" },
		})
			.jpeg()
			.toBuffer();
		const { images } = await collectTurnImages({
			items: [
				await imageItem(0, { name: "big.jpg", mimeType: "image/jpeg" }, big),
			],
			maxImages: 8,
		});

		expect([images[0]?.image.width, images[0]?.image.height]).toEqual([
			1600, 1200,
		]);
		expect(images[0]?.image.estimatedTokens).toBe(1900);
	});

	it("skips what is not an image", async () => {
		const pdf = item(
			artifact({
				id: "artifact-pdf",
				name: "report.pdf",
				mimeType: "application/pdf",
				storagePath: await storeFile("report.pdf", Buffer.from("%PDF-1.4")),
			}),
		);

		const result = await collectTurnImages({
			items: [pdf, await imageItem(1)],
			maxImages: 8,
		});

		expect(result.images.map((entry) => entry.name)).toEqual(["photo-1.png"]);
		expect(result.heldBack).toEqual([]);
	});

	it("skips a corrupt file without failing, and says so in the log", async () => {
		const result = await collectTurnImages({
			items: [
				await imageItem(
					0,
					{ name: "broken.png" },
					Buffer.from("not a picture"),
				),
				await imageItem(1),
			],
			maxImages: 8,
		});

		expect(result.images.map((entry) => entry.name)).toEqual(["photo-1.png"]);
		expect(result.heldBack).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[ATTACHMENTS] Image not sent as a picture",
			expect.objectContaining({ artifactId: "artifact-0" }),
		);
	});

	it("gives the slot of a picture it could not read to the next one", async () => {
		const items = [
			await imageItem(0, { name: "broken.png" }, Buffer.from("not a picture")),
			...(await Promise.all(
				Array.from({ length: 9 }, (_, index) => imageItem(index + 1)),
			)),
		];

		const { images, heldBack } = await collectTurnImages({
			items,
			maxImages: 8,
		});

		expect(images.map((entry) => entry.name)).toEqual(
			Array.from({ length: 8 }, (_, index) => `photo-${index + 1}.png`),
		);
		expect(heldBack).toEqual([{ number: 10, name: "photo-9.png" }]);
	});

	it("skips a file that is gone and an attachment with no stored file", async () => {
		const gone = item(
			artifact({
				id: "artifact-gone",
				name: "gone.png",
				storagePath: relative(
					process.cwd(),
					join(directory, "no-such-file.png"),
				),
			}),
		);
		const unstored = item(
			artifact({ id: "artifact-unstored", name: "unstored.png" }),
		);

		const result = await collectTurnImages({
			items: [gone, unstored, await imageItem(1)],
			maxImages: 8,
		});

		expect(result.images.map((entry) => entry.name)).toEqual(["photo-1.png"]);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("skips an attachment that is no longer available", async () => {
		const result = await collectTurnImages({
			items: [item(null), await imageItem(1)],
			maxImages: 8,
		});

		expect(result.images.map((entry) => entry.name)).toEqual(["photo-1.png"]);
	});

	it("skips a BMP, which cannot be decoded, without counting it as held back", async () => {
		const result = await collectTurnImages({
			items: [
				await imageItem(0, { name: "scan.bmp", mimeType: "image/bmp" }),
				await imageItem(1),
			],
			maxImages: 8,
		});

		expect(result.images.map((entry) => entry.name)).toEqual(["photo-1.png"]);
		expect(result.heldBack).toEqual([]);
		expect(mocks.prepareImageForModel).toHaveBeenCalledTimes(1);
	});

	// What the model is told afterwards: a picture it was not sent for any reason
	// other than the limit is named, in the order the pictures were attached.
	describe("the pictures that were attached and not sent, apart from the limit", () => {
		it("names a BMP, an unknown image type and a file that cannot be prepared, in attachment order", async () => {
			const result = await collectTurnImages({
				items: [
					await imageItem(0, { name: "scan.bmp", mimeType: "image/bmp" }),
					await imageItem(1),
					await imageItem(
						2,
						{ name: "broken.png" },
						Buffer.from("not a picture"),
					),
					await imageItem(3, {
						name: "favicon.ico",
						mimeType: "image/x-icon",
					}),
					await imageItem(4),
				],
				maxImages: 8,
			});

			expect(result.images.map((entry) => entry.name)).toEqual([
				"photo-1.png",
				"photo-4.png",
			]);
			expect(result.heldBack).toEqual([]);
			expect(result.notShown).toEqual([
				{ number: 1, name: "scan.bmp" },
				{ number: 3, name: "broken.png" },
				{ number: 4, name: "favicon.ico" },
			]);
			expect(result.images.map(({ number }) => number)).toEqual([2, 5]);
		});

		it("names a file that is gone and an attachment with no stored file", async () => {
			const gone = item(
				artifact({
					id: "artifact-gone",
					name: "gone.png",
					storagePath: relative(
						process.cwd(),
						join(directory, "no-such-file.png"),
					),
				}),
			);
			const unstored = item(
				artifact({ id: "artifact-unstored", name: "unstored.png" }),
			);

			const result = await collectTurnImages({
				items: [gone, unstored, await imageItem(1)],
				maxImages: 8,
			});

			expect(result.notShown).toEqual([
				{ number: 1, name: "gone.png" },
				{ number: 2, name: "unstored.png" },
			]);
		});

		it("does not name a picture the limit left out: that is the held-back line's", async () => {
			const result = await collectTurnImages({
				items: [
					await imageItem(0),
					await imageItem(1),
					await imageItem(2, { name: "scan.bmp", mimeType: "image/bmp" }),
				],
				maxImages: 1,
			});

			expect(result.heldBack).toEqual([{ number: 2, name: "photo-1.png" }]);
			expect(result.notShown).toEqual([{ number: 3, name: "scan.bmp" }]);
		});

		it("names a picture attached twice once", async () => {
			const bmp = await imageItem(0, {
				name: "scan.bmp",
				mimeType: "image/bmp",
			});

			const result = await collectTurnImages({
				items: [bmp, bmp],
				maxImages: 8,
			});

			expect(result.notShown).toEqual([{ number: 1, name: "scan.bmp" }]);
		});

		it("is empty when every picture was sent, and for a document or a missing attachment", async () => {
			const pdf = item(
				artifact({
					id: "artifact-pdf",
					name: "a.pdf",
					mimeType: "application/pdf",
				}),
			);

			const result = await collectTurnImages({
				items: [pdf, item(null), await imageItem(1)],
				maxImages: 8,
			});

			expect(result.images).toHaveLength(1);
			expect(result.notShown).toEqual([]);
		});
	});

	it("still sends a picture whose text has not been extracted", async () => {
		const noText = await imageItem(0, { name: "no-text.png" });

		expect(noText.promptReady).toBe(false);
		expect(noText.promptArtifact).toBeNull();
		const result = await collectTurnImages({ items: [noText], maxImages: 8 });

		expect(result.images.map((entry) => entry.name)).toEqual(["no-text.png"]);
	});

	it("sends a picture attached twice once", async () => {
		const once = await imageItem(0);

		const result = await collectTurnImages({
			items: [once, once],
			maxImages: 8,
		});

		expect(result.images).toHaveLength(1);
	});

	it("holds every picture back when the limit is zero", async () => {
		const result = await collectTurnImages({
			items: [await imageItem(0), await imageItem(1)],
			maxImages: 0,
		});

		expect(result.images).toEqual([]);
		expect(result.heldBack).toEqual([
			{ number: 1, name: "photo-0.png" },
			{ number: 2, name: "photo-1.png" },
		]);
		expect(mocks.prepareImageForModel).not.toHaveBeenCalled();
	});

	it("reads the file by the MIME type the attachment declares", async () => {
		const jpegBytes = await sharp({
			create: { width: 20, height: 20, channels: 3, background: "#cc3366" },
		})
			.jpeg()
			.toBuffer();

		await collectTurnImages({
			items: [
				await imageItem(
					0,
					{ name: "x.jpg", mimeType: "image/jpeg" },
					jpegBytes,
				),
			],
			maxImages: 8,
		});

		const [bytes, mimeType, options] =
			mocks.prepareImageForModel.mock.calls[0] ?? [];
		expect(ArrayBuffer.isView(bytes)).toBe(true);
		expect(mimeType).toBe("image/jpeg");
		expect(options).toEqual({ maxLongEdge: 1600 });
	});
});

describe("resolveTurnImages", () => {
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		warn.mockRestore();
	});

	it("collects the pictures when the model can see", async () => {
		const result = await resolveTurnImages({
			items: [await imageItem(0), await imageItem(1)],
			collect: true,
		});

		expect(result.images.map((entry) => entry.name)).toEqual([
			"photo-0.png",
			"photo-1.png",
		]);
		expect(result.heldBack).toEqual([]);
		expect(result.hasImageAttachments).toBe(true);
	});

	it("reads no file when the model cannot see, and still reports the attached images", async () => {
		const result = await resolveTurnImages({
			items: [await imageItem(0)],
			collect: false,
		});

		// A model that cannot see is told one line about images, so nothing is
		// listed as "not shown" for it: that list is for a model that can see.
		expect(result).toEqual({
			images: [],
			heldBack: [],
			notShown: [],
			hasImageAttachments: true,
		});
		expect(mocks.prepareImageForModel).not.toHaveBeenCalled();
	});

	it("reports no image attachments for a message with documents only", async () => {
		const pdf = item(
			artifact({
				id: "artifact-pdf",
				name: "a.pdf",
				mimeType: "application/pdf",
			}),
		);

		for (const collect of [true, false]) {
			expect(await resolveTurnImages({ items: [pdf], collect })).toEqual({
				images: [],
				heldBack: [],
				notShown: [],
				hasImageAttachments: false,
			});
		}
	});

	it("counts a BMP as an attached image that is not sent", async () => {
		const result = await resolveTurnImages({
			items: [await imageItem(0, { name: "scan.bmp", mimeType: "image/bmp" })],
			collect: true,
		});

		expect(result).toEqual({
			images: [],
			heldBack: [],
			notShown: [{ number: 1, name: "scan.bmp" }],
			hasImageAttachments: true,
		});
	});

	it("names the pictures it could not show, for a model that can see", async () => {
		const result = await resolveTurnImages({
			items: [
				await imageItem(0, { name: "scan.bmp", mimeType: "image/bmp" }),
				await imageItem(
					1,
					{ name: "broken.png" },
					Buffer.from("not a picture"),
				),
				await imageItem(2),
			],
			collect: true,
		});

		expect(result.images.map((entry) => entry.name)).toEqual(["photo-2.png"]);
		expect(result.heldBack).toEqual([]);
		expect(result.notShown).toEqual([
			{ number: 1, name: "scan.bmp" },
			{ number: 2, name: "broken.png" },
		]);
		expect(result.hasImageAttachments).toBe(true);
	});

	it("ignores an attachment that is no longer available", async () => {
		expect(
			await resolveTurnImages({ items: [item(null)], collect: true }),
		).toEqual({
			images: [],
			heldBack: [],
			notShown: [],
			hasImageAttachments: false,
		});
	});
});

describe("noTurnImages", () => {
	it("is a turn with no images attached, sent, held back or left unshown", () => {
		expect(noTurnImages()).toEqual({
			images: [],
			heldBack: [],
			notShown: [],
			hasImageAttachments: false,
		});
	});
});

describe("the guidance the model reads about pictures", () => {
	it("tells a model that cannot see to say so and answer from the text", () => {
		expect(CANNOT_SEE_IMAGES_GUIDANCE).toBe(
			"The user attached an image, but you cannot see images; you only get any text extracted from it. Say so in one short sentence, then answer from that text.",
		);
	});

	it("names the pictures held back by the limit", () => {
		expect(
			heldBackImagesGuidance([
				{ number: 9, name: "a.jpg" },
				{ number: 10, name: "b.jpg" },
			]),
		).toBe(
			"Not sent as pictures because of the limit: Picture 9: a.jpg; Picture 10: b.jpg.",
		);
	});

	it("says which numbered picture could not be shown", () => {
		expect(notShownImageGuidance({ number: 2, name: "old.bmp" })).toBe(
			"Picture 2: old.bmp was attached, but it could not be shown to you.",
		);
	});

	it("one-lines a name and cuts it by code points", () => {
		expect(oneLineName("kitchen\n photo.jpg")).toBe("kitchen photo.jpg");
		expect(oneLineName("\u{1F600}".repeat(100))).toBe(
			`${"\u{1F600}".repeat(77)}...`,
		);
		expect(oneLineName("\n ")).toBe("");
	});

	it("says in the place of a picture that one was attached and cannot be seen", () => {
		expect(STRIPPED_IMAGE_NOTE).toBe(
			"[An image was attached here, but this model cannot see images.]",
		);
	});

	it("is ASCII, like everything else the app writes into a request", () => {
		for (const text of [
			CANNOT_SEE_IMAGES_GUIDANCE,
			heldBackImagesGuidance([{ number: 1, name: "a.png" }]),
			STRIPPED_IMAGE_NOTE,
			...buildTurnImageGuidance({
				canSee: true,
				turnImages: {
					images: [],
					heldBack: [],
					notShown: [{ number: 1, name: "scan.bmp" }],
					hasImageAttachments: true,
				},
			}),
		]) {
			expect(text).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	const base = {
		images: [],
		heldBack: [],
		notShown: [],
		hasImageAttachments: false,
	};

	it("adds the limit line for a model that can see and had pictures held back", () => {
		expect(
			buildTurnImageGuidance({
				canSee: true,
				turnImages: {
					...base,
					heldBack: [{ number: 3, name: "c.png" }],
					hasImageAttachments: true,
				},
			}),
		).toEqual([heldBackImagesGuidance([{ number: 3, name: "c.png" }])]);
	});

	it("adds the cannot-see line when images are attached and the model cannot see", () => {
		expect(
			buildTurnImageGuidance({
				canSee: false,
				turnImages: { ...base, hasImageAttachments: true },
			}),
		).toEqual([CANNOT_SEE_IMAGES_GUIDANCE]);
	});

	// A picture that was attached and could not be shown (a BMP, a type the
	// decoder does not read, a file that would not prepare) is named, one line
	// each, so the model does not answer as if it had looked at it.
	it("names each picture it could not be shown, one line each, for a model that can see", () => {
		expect(
			buildTurnImageGuidance({
				canSee: true,
				turnImages: {
					...base,
					notShown: [
						{ number: 1, name: "scan.bmp" },
						{ number: 2, name: "broken.png" },
					],
					hasImageAttachments: true,
				},
			}),
		).toEqual([
			"Picture 1: scan.bmp was attached, but it could not be shown to you.",
			"Picture 2: broken.png was attached, but it could not be shown to you.",
		]);
	});

	it("puts the limit line before the lines for pictures it could not show", () => {
		expect(
			buildTurnImageGuidance({
				canSee: true,
				turnImages: {
					...base,
					heldBack: [{ number: 3, name: "c.png" }],
					notShown: [{ number: 1, name: "scan.bmp" }],
					hasImageAttachments: true,
				},
			}),
		).toEqual([
			heldBackImagesGuidance([{ number: 3, name: "c.png" }]),
			"Picture 1: scan.bmp was attached, but it could not be shown to you.",
		]);
	});

	it("tells a model that cannot see the cannot-see line and none of the per-picture lines", () => {
		expect(
			buildTurnImageGuidance({
				canSee: false,
				turnImages: {
					...base,
					notShown: [{ number: 1, name: "scan.bmp" }],
					hasImageAttachments: true,
				},
			}),
		).toEqual([CANNOT_SEE_IMAGES_GUIDANCE]);
	});

	it("adds nothing for a message with no images, or when every picture was sent", () => {
		expect(buildTurnImageGuidance({ canSee: false, turnImages: base })).toEqual(
			[],
		);
		expect(buildTurnImageGuidance({ canSee: true, turnImages: base })).toEqual(
			[],
		);
		expect(
			buildTurnImageGuidance({
				canSee: true,
				turnImages: {
					...base,
					images: [turnImage("a.png")],
					hasImageAttachments: true,
				},
			}),
		).toEqual([]);
	});
});

describe("sumTurnImageTokens", () => {
	it("adds what each prepared picture costs, not a flat amount", () => {
		expect(
			sumTurnImageTokens([
				turnImage("wide.jpg", { estimatedTokens: 1900 }),
				turnImage("square.jpg", { estimatedTokens: 2500 }),
			]),
		).toBe(4400);
	});

	it("is zero for no pictures", () => {
		expect(sumTurnImageTokens([])).toBe(0);
		expect(sumTurnImageTokens()).toBe(0);
	});
});
