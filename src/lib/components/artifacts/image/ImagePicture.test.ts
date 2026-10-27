import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ImagePicture from "./ImagePicture.svelte";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("ImagePicture", () => {
	it("draws the picture from its file route in a box of its own shape, with its size set", () => {
		render(ImagePicture, {
			fileId: "file-7",
			width: 1248,
			height: 832,
			alt: "Cosy room",
			conversationId: "conv-1",
		});

		const img = screen.getByRole("img", { name: "Cosy room" });
		expect(img.getAttribute("src")).toContain("/api/images/files/file-7");
		expect(img.getAttribute("src")).toContain("conversationId=conv-1");
		expect(img).toHaveAttribute("width", "1248");
		expect(img).toHaveAttribute("height", "832");
		expect(img).toHaveAttribute("decoding", "async");
		const box = screen.getByTestId("image-picture");
		expect(box.style.aspectRatio).toBe("1248 / 832");
	});

	it("offers the thumbnail and the full picture by width, and only the thumbnail for a thumb", () => {
		render(ImagePicture, {
			fileId: "file-7",
			width: 832,
			height: 1248,
			alt: "Tall",
		});
		const srcset = screen.getByRole("img").getAttribute("srcset") ?? "";
		expect(srcset).toContain("variant=thumb");
		expect(srcset).toContain(" 213w");
		expect(srcset).toContain(" 832w");

		render(ImagePicture, {
			fileId: "file-8",
			width: 832,
			height: 1248,
			alt: "Thumb",
			variant: "thumb",
		});
		const thumb = screen.getByRole("img", { name: "Thumb" });
		expect(thumb.getAttribute("src")).toContain("variant=thumb");
		expect(thumb.hasAttribute("srcset")).toBe(false);
	});

	it("fades the picture in once it has loaded", async () => {
		render(ImagePicture, { fileId: "f", width: 10, height: 10, alt: "P" });
		const img = screen.getByRole("img");
		expect(img).not.toHaveClass("is-loaded");
		await fireEvent.load(img);
		expect(img).toHaveClass("is-loaded");
	});

	it("draws a see-through picture over the checkerboard", () => {
		render(ImagePicture, {
			fileId: "f",
			width: 10,
			height: 10,
			alt: "Cut out",
			hasAlpha: true,
		});
		expect(screen.getByTestId("image-picture")).toHaveClass(
			"image-checkerboard",
		);
	});

	it("draws the checkerboard with its own tokens, which each theme sets (Review Focus 2, F8)", () => {
		const source = readFileSync(path.join(here, "ImagePicture.svelte"), "utf8");
		expect(source).toContain("var(--checker-a)");
		expect(source).toContain("var(--checker-b)");
		const css = readFileSync(path.join(here, "../../../../app.css"), "utf8");
		const light = css.indexOf("--checker-a: #ffffff");
		const dark = css.indexOf("--checker-a: #2a2a2a");
		expect(light).toBeGreaterThan(-1);
		expect(dark).toBeGreaterThan(css.indexOf(".dark {"));
		expect(css).toMatch(
			/\.stage--incognito \{[^}]*--checker-a: var\(--incognito-checker-a\)/,
		);
	});

	it("shows the picture it was made from on Before, and itself again on After", async () => {
		const { rerender } = render(ImagePicture, {
			fileId: "after-file",
			width: 10,
			height: 10,
			alt: "Sofa",
			beforeFileId: "before-file",
			showing: "after",
		});
		expect(
			screen.getByRole("img", { name: "Sofa" }).getAttribute("src"),
		).toContain("after-file");

		await rerender({ showing: "before" });
		expect(
			screen.getByRole("img", { name: "Sofa" }).getAttribute("src"),
		).toContain("before-file");
		expect(screen.getByTestId("image-picture")).toHaveAttribute(
			"data-showing",
			"before",
		);

		await rerender({ showing: "after" });
		expect(
			screen.getByRole("img", { name: "Sofa" }).getAttribute("src"),
		).toContain("after-file");
	});
});

describe("ImagePicture with a picture already in the cache", () => {
	it("shows it at once, without its attachment re-running on its own write", async () => {
		const complete = Object.getOwnPropertyDescriptor(
			HTMLImageElement.prototype,
			"complete",
		);
		const natural = Object.getOwnPropertyDescriptor(
			HTMLImageElement.prototype,
			"naturalWidth",
		);
		Object.defineProperty(HTMLImageElement.prototype, "complete", {
			configurable: true,
			get: () => true,
		});
		Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
			configurable: true,
			get: () => 10,
		});
		try {
			const { rerender } = render(ImagePicture, {
				fileId: "after-file",
				width: 10,
				height: 10,
				alt: "Cached",
				beforeFileId: "before-file",
			});
			expect(screen.getByRole("img", { name: "Cached" })).toHaveClass(
				"is-loaded",
			);
			await rerender({ showing: "before" });
			expect(screen.getByRole("img", { name: "Cached" })).toHaveClass(
				"is-loaded",
			);
		} finally {
			if (complete)
				Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
			if (natural)
				Object.defineProperty(
					HTMLImageElement.prototype,
					"naturalWidth",
					natural,
				);
		}
	});
});
