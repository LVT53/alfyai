import { describe, expect, it, vi } from "vitest";
import { createHeifPreviewQueue } from "./heif-preview";

function deferred() {
	let resolve: (value: Buffer | null) => void = () => undefined;
	const promise = new Promise<Buffer | null>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const settled = () => new Promise((done) => setTimeout(done, 0));

describe("createHeifPreviewQueue", () => {
	it("converts once for a tile, its chip and the marking screen asking together", async () => {
		const first = deferred();
		const convert = vi.fn(() => first.promise);
		const preview = createHeifPreviewQueue(convert);

		const answers = [
			preview("a.heic", "image/heic"),
			preview("a.heic", "image/heic"),
			preview("a.heic", "image/heic"),
		];
		await settled();
		first.resolve(Buffer.from("png"));

		expect(await Promise.all(answers)).toEqual([
			Buffer.from("png"),
			Buffer.from("png"),
			Buffer.from("png"),
		]);
		expect(convert).toHaveBeenCalledTimes(1);
	});

	it("converts one photo at a time, because a decode holds the calling thread", async () => {
		const first = deferred();
		const second = deferred();
		const convert = vi
			.fn<() => Promise<Buffer | null>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const preview = createHeifPreviewQueue(convert);

		const answers = [preview("a.heic", null), preview("b.heic", null)];
		await settled();
		expect(convert).toHaveBeenCalledTimes(1);

		first.resolve(null);
		await settled();
		expect(convert).toHaveBeenCalledTimes(2);

		second.resolve(Buffer.from("b"));
		expect(await Promise.all(answers)).toEqual([null, Buffer.from("b")]);
	});

	it("asks again once a conversion has finished", async () => {
		const convert = vi.fn(async () => Buffer.from("png"));
		const preview = createHeifPreviewQueue(convert);

		await preview("a.heic", null);
		await preview("a.heic", null);

		expect(convert).toHaveBeenCalledTimes(2);
	});
});
