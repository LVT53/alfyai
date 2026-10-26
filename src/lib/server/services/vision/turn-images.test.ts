import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
	isSeeableImage,
	MAX_TURN_IMAGES,
	resolveTurnImages,
	sumTurnImageTokens,
	type TurnImage,
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

function turnImage(name: string, overrides: Partial<PreparedImage> = {}) {
	return {
		artifactId: `artifact-${name}`,
		name,
		image: preparedImage(overrides),
	} satisfies TurnImage;
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
				{ type: "image", image: "QUJD", mediaType: "image/jpeg" },
			],
		});
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
			turnImage("first.jpg", { base64: "Rklyc3Q=" }),
			turnImage("second.jpg", { base64: "U2Vjb25k" }),
		]);

		expect(message.content).toEqual([
			{ type: "text", text: "compare" },
			{ type: "image", image: "Rklyc3Q=", mediaType: "image/jpeg" },
			{ type: "image", image: "U2Vjb25k", mediaType: "image/jpeg" },
		]);
	});

	it("carries base64 strings, so the message survives JSON unchanged", () => {
		const message = buildCurrentUserMessage("hi", [turnImage("room.jpg")]);

		expect(JSON.parse(JSON.stringify(message))).toEqual(message);
	});
});

describe("isSeeableImage", () => {
	it.each([
		["photo.png", "image/png"],
		["photo.jpg", "image/jpeg"],
		["PHOTO.JPEG", "image/jpeg"],
		["IMG_0001.HEIC", "image/heic"],
		["portrait.heif", "image/heif"],
		["animation.gif", "image/gif"],
		["web.webp", "image/webp"],
		["scan.tiff", "image/tiff"],
	])("is true for %s", (name, mimeType) => {
		expect(isSeeableImage(name, mimeType)).toBe(true);
	});

	it("is true for an image whose name has no extension, by its type", () => {
		expect(isSeeableImage("photo", "image/png")).toBe(true);
		expect(isSeeableImage("photo", "image/heic")).toBe(true);
		expect(isSeeableImage("photo", null)).toBe(false);
	});

	it("is false for a BMP: the prebuilt image library has no BMP decoder", () => {
		expect(isSeeableImage("scan.bmp", "image/bmp")).toBe(false);
		expect(isSeeableImage("scan.bmp", null)).toBe(false);
		expect(isSeeableImage("scan", "image/bmp")).toBe(false);
	});

	it.each([
		["report.pdf", "application/pdf"],
		["notes.txt", "text/plain"],
		["data.csv", "text/csv"],
		["archive.zip", "application/zip"],
	])("is false for %s, which is not an image", (name, mimeType) => {
		expect(isSeeableImage(name, mimeType)).toBe(false);
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
		expect(heldBack).toEqual(["photo-8.png", "photo-9.png"]);
		expect(images[0]?.artifactId).toBe("artifact-0");
		expect(images[0]?.image.mediaType).toBe("image/jpeg");
		expect(warn).not.toHaveBeenCalled();
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
		expect(heldBack).toEqual(["photo-9.png"]);
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
		expect(result.heldBack).toEqual(["photo-0.png", "photo-1.png"]);
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

		expect(result).toEqual({
			images: [],
			heldBack: [],
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
			hasImageAttachments: true,
		});
	});

	it("ignores an attachment that is no longer available", async () => {
		expect(
			await resolveTurnImages({ items: [item(null)], collect: true }),
		).toEqual({
			images: [],
			heldBack: [],
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
		expect(heldBackImagesGuidance(["a.png", "b.png"])).toBe(
			"2 more attached images were not sent as pictures because of the limit: a.png, b.png.",
		);
	});

	it("is ASCII, like everything else the app writes into a request", () => {
		for (const text of [
			CANNOT_SEE_IMAGES_GUIDANCE,
			heldBackImagesGuidance(["a.png"]),
		]) {
			expect(text).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	const base = { images: [], heldBack: [], hasImageAttachments: false };

	it("adds the limit line for a model that can see and had pictures held back", () => {
		expect(
			buildTurnImageGuidance({
				canSee: true,
				turnImages: {
					...base,
					heldBack: ["c.png"],
					hasImageAttachments: true,
				},
			}),
		).toEqual([heldBackImagesGuidance(["c.png"])]);
	});

	it("adds the cannot-see line when images are attached and the model cannot see", () => {
		expect(
			buildTurnImageGuidance({
				canSee: false,
				turnImages: { ...base, hasImageAttachments: true },
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
