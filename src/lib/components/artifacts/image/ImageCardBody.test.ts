import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ImageCardBody from "./ImageCardBody.svelte";
import { card, take } from "./image-card-fixtures.test-helpers";

describe("ImageCardBody", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("shows a take being made with its words, its progress and Stop", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			phaseAt: Date.now(),
			etaSeconds: 8,
			progressPercent: 40,
			fileId: null,
			width: null,
			height: null,
		});
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([making]), onAction });

		expect(screen.getByText("Making the picture…")).toBeInTheDocument();
		expect(screen.getByText("About 8 s left")).toBeInTheDocument();
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"40",
		);
		await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(onAction).toHaveBeenCalledWith({ type: "stop", takeId: making.id });
	});

	it("never moves the progress back when a later poll reports less", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			progressPercent: 60,
			fileId: null,
		});
		const { rerender } = render(ImageCardBody, { card: card([making]) });
		await rerender({ card: card([{ ...making, progressPercent: 30 }]) });
		expect(screen.getByRole("progressbar")).toHaveAttribute(
			"aria-valuenow",
			"60",
		);
	});

	it("says how many pictures are ahead of a waiting take", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "running",
					phase: "submitted",
					queueAhead: 1,
					fileId: null,
				}),
			]),
		});
		expect(
			screen.getByText("Another picture is being made"),
		).toBeInTheDocument();
		expect(screen.getByText("1 ahead of this one")).toBeInTheDocument();
	});

	it("says the picture maker is starting after a quiet spell", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "running",
					phase: "starting",
					phaseAt: Date.now() - 10_000,
					fileId: null,
				}),
			]),
		});
		expect(screen.getByText("Starting the picture maker…")).toBeInTheDocument();
	});

	it("draws a ready take from its file, sized, in the box its take reserved", () => {
		const ready = take({ fileId: "file-a", box: { width: 1248, height: 832 } });
		render(ImageCardBody, { card: card([ready]), conversationId: "conv-1" });

		const img = screen.getByRole("img", { name: "Cosy room" });
		expect(img.getAttribute("src")).toContain("/api/images/files/file-a");
		expect(img).toHaveAttribute("width", "1248");
		expect(img).toHaveAttribute("height", "832");
		expect(screen.getByTestId("image-card-stage").style.aspectRatio).toBe(
			"1248 / 832",
		);
	});

	it("keeps the take's box while it is made, so nothing moves when it lands (Review Focus 1)", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			fileId: null,
			width: null,
			height: null,
			box: { width: 1184, height: 896 },
		});
		const { rerender } = render(ImageCardBody, { card: card([making]) });
		const stage = screen.getByTestId("image-card-stage");
		expect(stage.style.aspectRatio).toBe("1184 / 896");

		await rerender({
			card: card([
				{
					...making,
					status: "succeeded",
					phase: null,
					fileId: "landed",
					width: 1184,
					height: 896,
				},
			]),
		});
		expect(screen.getByTestId("image-card-stage")).toBe(stage);
		expect(stage.style.aspectRatio).toBe("1184 / 896");
	});

	it("draws a see-through picture over the checkerboard", () => {
		render(ImageCardBody, { card: card([take({ hasAlpha: true })]) });
		expect(
			within(screen.getByTestId("image-card-stage")).getByTestId(
				"image-picture",
			),
		).toHaveClass("image-checkerboard");
	});

	it("marks the take in use, and offers Use this on another take chosen in the strip", async () => {
		const first = take();
		const second = take();
		const onAction = vi.fn();
		render(ImageCardBody, {
			card: card([first, second], { pickedTakeId: first.id }),
			onAction,
		});

		const tiles = screen.getAllByTestId("image-card-tile");
		expect(tiles).toHaveLength(2);
		expect(
			within(tiles[0]).getByTestId("image-card-in-use"),
		).toBeInTheDocument();
		expect(within(tiles[1]).queryByTestId("image-card-in-use")).toBeNull();
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();

		await fireEvent.click(tiles[1]);
		expect(tiles[1]).toHaveAttribute("aria-pressed", "true");
		expect(
			screen
				.getByTestId("image-card-stage")
				.querySelector('[data-testid="image-picture-after"]')
				?.getAttribute("src"),
		).toContain(second.fileId);
		await fireEvent.click(screen.getByRole("button", { name: /Use this/ }));
		expect(onAction).toHaveBeenCalledWith({ type: "use", takeId: second.id });
	});

	it("never offers a held take", async () => {
		const first = take();
		const held = take({ held: true });
		render(ImageCardBody, {
			card: card([first, held], { pickedTakeId: first.id }),
		});
		await fireEvent.click(screen.getAllByTestId("image-card-tile")[1]);
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();
	});

	it("asks for Another, shows its tile at once and the take it queued once the card has it", async () => {
		const first = take();
		const onAction = vi.fn(async () => ({ takeId: "take-new" }));
		const { rerender } = render(ImageCardBody, {
			card: card([first]),
			onAction,
		});
		expect(screen.queryByTestId("image-card-strip")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /Another/ }));
		expect(onAction).toHaveBeenCalledWith({
			type: "another",
			cardId: "card-1",
		});
		expect(
			screen.getByTestId("image-card-tile-placeholder"),
		).toBeInTheDocument();
		expect(screen.getByTestId("image-card-body")).toHaveAttribute(
			"data-state",
			"waiting",
		);

		const queued = take({
			id: "take-new",
			status: "queued",
			fileId: null,
			origin: "another",
		});
		await rerender({ card: card([first, queued], { pickedTakeId: first.id }) });
		await tick();
		expect(screen.queryByTestId("image-card-tile-placeholder")).toBeNull();
		const tiles = screen.getAllByTestId("image-card-tile");
		expect(tiles).toHaveLength(2);
		expect(tiles[1]).toHaveAttribute("aria-pressed", "true");
	});

	it("takes the placeholder back when Another did not go through", async () => {
		const onAction = vi.fn(async () => {
			throw new Error("refused");
		});
		render(ImageCardBody, { card: card([take()]), onAction });
		await fireEvent.click(screen.getByRole("button", { name: /Another/ }));
		await tick();
		await tick();
		expect(screen.queryByTestId("image-card-tile-placeholder")).toBeNull();
	});

	it("holds Download and History in its menu", async () => {
		const ready = take({ fileId: "file-z" });
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([ready]), onAction });

		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		await fireEvent.click(await screen.findByTestId("image-card-download"));
		expect(onAction).toHaveBeenCalledWith({
			type: "download",
			fileId: "file-z",
			title: "Cosy room",
		});

		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		await fireEvent.click(await screen.findByTestId("image-card-history"));
		expect(onAction).toHaveBeenCalledWith({
			type: "history",
			artifactId: "artifact-1",
		});
	});

	it("opens the picture in the panel when it is pressed", async () => {
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([take()]), onAction });
		await fireEvent.click(screen.getByTestId("image-card-picture"));
		expect(onAction).toHaveBeenCalledWith({
			type: "open",
			artifactId: "artifact-1",
		});
	});

	it("says pictures cannot be made when the server is out of reach, and tries again", async () => {
		const failed = take({
			status: "failed",
			fileId: null,
			errorCode: "image_server_unreachable",
			retryable: true,
		});
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([failed]), onAction });

		expect(
			screen.getByText("Pictures can't be made right now."),
		).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onAction).toHaveBeenCalledWith({ type: "retry", takeId: failed.id });
	});

	it("says a picture server that is not set up cannot make pictures either", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "failed",
					fileId: null,
					errorCode: "image_server_not_configured",
				}),
			]),
		});
		expect(
			screen.getByText("Pictures can't be made right now."),
		).toBeInTheDocument();
	});

	it("says a failed take could not be made and that nothing was saved", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "failed",
					fileId: null,
					errorCode: "image_render_failed",
				}),
			]),
		});
		expect(screen.getByText("Couldn't make this one.")).toBeInTheDocument();
		expect(screen.getByText("Nothing was saved.")).toBeInTheDocument();
	});

	it("offers Try again on a stopped take", async () => {
		const stopped = take({ status: "cancelled", fileId: null });
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([stopped]), onAction });
		expect(screen.getByText("Stopped.")).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onAction).toHaveBeenCalledWith({
			type: "retry",
			takeId: stopped.id,
		});
	});

	it("flips to the picture it was made from on Before, and back on After", async () => {
		const changed = take({ fileId: "after-f", baseFileId: "base-f" });
		render(ImageCardBody, {
			card: card([changed], { madeFrom: "photo" }),
		});
		const before = screen.getByRole("button", { name: "Before" });
		const after = screen.getByRole("button", { name: "After" });
		expect(after).toHaveAttribute("aria-pressed", "true");

		await fireEvent.click(before);
		expect(before).toHaveAttribute("aria-pressed", "true");
		expect(
			screen.getByRole("img", { name: "Cosy room" }).getAttribute("src"),
		).toContain("base-f");

		await fireEvent.click(after);
		expect(
			screen.getByRole("img", { name: "Cosy room" }).getAttribute("src"),
		).toContain("after-f");
	});

	it("shows the pictures a card was made from, numbered", () => {
		render(ImageCardBody, {
			card: card([take({ sourceFileIds: ["src-1", "src-2"] })], {
				madeFrom: "pictures",
				sourceCount: 2,
			}),
		});
		const row = screen.getByTestId("image-card-made-from");
		expect(row).toHaveTextContent("Made from");
		expect(row).toHaveTextContent("1");
		expect(row).toHaveTextContent("2");
		expect(row.querySelectorAll("img")).toHaveLength(2);
	});

	it("speaks Hungarian", async () => {
		uiLanguage.set("hu");
		const first = take();
		const second = take();
		render(ImageCardBody, {
			card: card([
				first,
				second,
				take({ status: "running", phase: "rendering", fileId: null }),
			]),
		});
		expect(screen.getByRole("button", { name: /Másik/ })).toBeInTheDocument();
		await fireEvent.click(screen.getAllByTestId("image-card-tile")[1]);
		expect(
			screen.getByRole("button", { name: /Ez legyen/ }),
		).toBeInTheDocument();
		await fireEvent.click(screen.getAllByTestId("image-card-tile")[2]);
		expect(screen.getByText("Készül a kép…")).toBeInTheDocument();
	});
});
