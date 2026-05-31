import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import * as pdfjsLib from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PdfPreview from "./PdfPreview.svelte";

const mockPdfRenderCancel = vi.fn();
const mockPdfRender = vi.fn(() => ({
	promise: Promise.resolve(),
	cancel: mockPdfRenderCancel,
}));

const mockPdfGetPage = vi.fn(async () => ({
	getViewport: vi.fn(({ scale }: { scale: number }) => ({
		width: 640 * scale,
		height: 480 * scale,
	})),
	render: mockPdfRender,
}));

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: {
		workerSrc: "",
	},
	VerbosityLevel: {
		ERRORS: 0,
	},
	setVerbosityLevel: vi.fn(),
	getDocument: vi.fn(() => ({
		promise: Promise.resolve({
			numPages: 2,
			getPage: mockPdfGetPage,
		}),
		destroy: vi.fn(async () => undefined),
	})),
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
	default: "/mock-pdf-worker.mjs",
}));

const originalIntersectionObserver = globalThis.IntersectionObserver;

describe("PdfPreview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window, "devicePixelRatio", {
			value: 1,
			configurable: true,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.IntersectionObserver = originalIntersectionObserver;
	});

	it("loads PDF bytes dynamically and exposes the shared page toolbar", async () => {
		const blob = new Blob(["%PDF-1.7 test"], { type: "application/pdf" });

		render(PdfPreview, {
			props: {
				blob,
				filename: "document.pdf",
			},
		});

		await waitFor(() => {
			expect(screen.getByTestId("preview-toolbar")).toBeInTheDocument();
		});

		expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toBe("/mock-pdf-worker.mjs");
		expect(pdfjsLib.setVerbosityLevel).toHaveBeenCalledWith(
			pdfjsLib.VerbosityLevel.ERRORS,
		);
		expect(pdfjsLib.getDocument).toHaveBeenCalledWith({
			data: await blob.arrayBuffer(),
			verbosity: pdfjsLib.VerbosityLevel.ERRORS,
		});
		expect(screen.getByTestId("preview-page-input")).toHaveDisplayValue("1");
		expect(screen.getByText("of 2")).toBeInTheDocument();
		expect(screen.getByTestId("pdf-scroll-region")).toHaveAccessibleName(
			"PDF pages",
		);
	});

	it("destroys the previous PDF loading task when the blob changes", async () => {
		const firstDestroy = vi.fn(async () => undefined);
		const secondDestroy = vi.fn(async () => undefined);
		const firstLoadingPromise = new Promise<{
			numPages: number;
			getPage: typeof mockPdfGetPage;
		}>(() => undefined);

		vi.mocked(pdfjsLib.getDocument)
			.mockReturnValueOnce({
				promise: firstLoadingPromise,
				destroy: firstDestroy,
			} as ReturnType<typeof pdfjsLib.getDocument>)
			.mockReturnValueOnce({
				promise: Promise.resolve({
					numPages: 2,
					getPage: mockPdfGetPage,
				}),
				destroy: secondDestroy,
			} as ReturnType<typeof pdfjsLib.getDocument>);

		const { rerender } = render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 first"], { type: "application/pdf" }),
				filename: "first.pdf",
			},
		});

		await waitFor(() => {
			expect(pdfjsLib.getDocument).toHaveBeenCalledTimes(1);
		});

		await rerender({
			blob: new Blob(["%PDF-1.7 second"], { type: "application/pdf" }),
			filename: "second.pdf",
		});

		await waitFor(() => {
			expect(firstDestroy).toHaveBeenCalledTimes(1);
		});
		expect(secondDestroy).not.toHaveBeenCalled();
	});

	it("waits for the previous PDF loading task to finish destroying before starting the replacement load", async () => {
		let finishDestroy: () => void = () => undefined;
		const firstDestroyPromise = new Promise<void>((resolve) => {
			finishDestroy = resolve;
		});
		const firstDestroy = vi.fn(() => firstDestroyPromise);
		const firstLoadingPromise = new Promise<{
			numPages: number;
			getPage: typeof mockPdfGetPage;
		}>(() => undefined);

		vi.mocked(pdfjsLib.getDocument)
			.mockReturnValueOnce({
				promise: firstLoadingPromise,
				destroy: firstDestroy,
			} as ReturnType<typeof pdfjsLib.getDocument>)
			.mockReturnValueOnce({
				promise: Promise.resolve({
					numPages: 2,
					getPage: mockPdfGetPage,
				}),
				destroy: vi.fn(async () => undefined),
			} as ReturnType<typeof pdfjsLib.getDocument>);

		const { rerender } = render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 first"], { type: "application/pdf" }),
				filename: "first.pdf",
			},
		});

		await waitFor(() => {
			expect(pdfjsLib.getDocument).toHaveBeenCalledTimes(1);
		});

		await rerender({
			blob: new Blob(["%PDF-1.7 second"], { type: "application/pdf" }),
			filename: "second.pdf",
		});

		await waitFor(() => {
			expect(firstDestroy).toHaveBeenCalledTimes(1);
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(pdfjsLib.getDocument).toHaveBeenCalledTimes(1);

		finishDestroy();
		await waitFor(() => {
			expect(pdfjsLib.getDocument).toHaveBeenCalledTimes(2);
		});
	});

	it("cancels active render tasks and re-renders when zoom changes", async () => {
		let rejectSlowRender: (error: Error) => void = () => undefined;
		const slowRenderPromise = new Promise<void>((_, reject) => {
			rejectSlowRender = reject;
		});
		mockPdfRender.mockImplementationOnce(() => ({
			promise: slowRenderPromise,
			cancel: () => {
				mockPdfRenderCancel();
				rejectSlowRender(new Error("cancelled"));
			},
		}));

		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 slow"], { type: "application/pdf" }),
				filename: "slow.pdf",
			},
		});

		const zoomIn = await screen.findByLabelText("Zoom in");
		await waitFor(() => {
			expect(mockPdfRender).toHaveBeenCalled();
		});
		const initialRenderCount = mockPdfRender.mock.calls.length;
		await fireEvent.click(zoomIn);

		await waitFor(() => {
			expect(mockPdfRenderCancel).toHaveBeenCalled();
			expect(mockPdfRender.mock.calls.length).toBeGreaterThan(
				initialRenderCount,
			);
		});
		expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("125%");
	});

	it("keeps the latest page render cancellable when an older canceled render settles late", async () => {
		let rejectFirstRender: (error: Error) => void = () => undefined;
		const firstRenderPromise = new Promise<void>((_, reject) => {
			rejectFirstRender = reject;
		});
		const secondRenderPromise = new Promise<void>(() => undefined);
		const firstRenderCancel = vi.fn();
		const secondRenderCancel = vi.fn();

		mockPdfRender
			.mockImplementationOnce(() => ({
				promise: firstRenderPromise,
				cancel: firstRenderCancel,
			}))
			.mockImplementationOnce(() => ({
				promise: secondRenderPromise,
				cancel: secondRenderCancel,
			}));

		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 rapid zoom"], {
					type: "application/pdf",
				}),
				filename: "rapid-zoom.pdf",
			},
		});

		const zoomIn = await screen.findByLabelText("Zoom in");
		await waitFor(() => {
			expect(mockPdfRender).toHaveBeenCalledTimes(1);
		});

		await fireEvent.click(zoomIn);
		await waitFor(() => {
			expect(firstRenderCancel).toHaveBeenCalled();
			expect(mockPdfRender).toHaveBeenCalledTimes(2);
		});

		rejectFirstRender(new Error("cancelled"));
		await waitFor(() => {
			expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("125%");
		});

		await fireEvent.click(zoomIn);
		await waitFor(() => {
			expect(secondRenderCancel).toHaveBeenCalled();
		});
	});

	it("sizes canvases for the device pixel ratio while rendering at logical viewport size", async () => {
		Object.defineProperty(window, "devicePixelRatio", {
			value: 2,
			configurable: true,
		});

		const { container } = render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 hidpi"], { type: "application/pdf" }),
				filename: "hidpi.pdf",
			},
		});

		await waitFor(() => {
			expect(mockPdfRender).toHaveBeenCalled();
		});

		const canvas = container.querySelector<HTMLCanvasElement>(
			'canvas[data-page="1"]',
		);
		expect(canvas).toBeInTheDocument();
		expect(canvas?.width).toBe(1280);
		expect(canvas?.height).toBe(960);
		expect(canvas?.style.width).toBe("640px");
		expect(canvas?.style.height).toBe("480px");

		expect(mockPdfRender.mock.calls[0]?.[0]).toMatchObject({
			viewport: {
				width: 640,
				height: 480,
			},
			transform: [2, 0, 0, 2, 0, 0],
		});
	});

	it("lets browser wheel scrolling pass through while Ctrl-wheel and keyboard scrolling stay active", async () => {
		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 scroll"], { type: "application/pdf" }),
				filename: "scroll.pdf",
			},
		});

		const scrollRegion = await screen.findByTestId("pdf-scroll-region");
		Object.defineProperty(scrollRegion, "clientHeight", {
			value: 300,
			configurable: true,
		});
		Object.defineProperty(scrollRegion, "scrollHeight", {
			value: 1200,
			configurable: true,
		});

		const wheelEvent = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: 120,
		});
		const normalWheelPreventDefault = vi.spyOn(wheelEvent, "preventDefault");
		scrollRegion.dispatchEvent(wheelEvent);
		expect(normalWheelPreventDefault).not.toHaveBeenCalled();

		const zoomWheelEvent = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: -120,
			ctrlKey: true,
		});
		const zoomWheelPreventDefault = vi.spyOn(zoomWheelEvent, "preventDefault");
		scrollRegion.dispatchEvent(zoomWheelEvent);
		expect(zoomWheelPreventDefault).toHaveBeenCalled();
		await waitFor(() => {
			expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("112%");
		});

		scrollRegion.focus();
		await fireEvent.keyDown(scrollRegion, { key: "ArrowDown" });
		expect(scrollRegion.scrollTop).toBe(48);
	});

	it("lets users pan the zoomed PDF preview by dragging the scroll region", async () => {
		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 pan"], { type: "application/pdf" }),
				filename: "pan.pdf",
			},
		});

		const scrollRegion = await screen.findByTestId("pdf-scroll-region");
		Object.defineProperty(scrollRegion, "clientHeight", {
			value: 300,
			configurable: true,
		});
		Object.defineProperty(scrollRegion, "scrollHeight", {
			value: 1200,
			configurable: true,
		});
		Object.defineProperty(scrollRegion, "clientWidth", {
			value: 400,
			configurable: true,
		});
		Object.defineProperty(scrollRegion, "scrollWidth", {
			value: 1000,
			configurable: true,
		});
		scrollRegion.scrollTop = 100;
		scrollRegion.scrollLeft = 100;
		scrollRegion.setPointerCapture = vi.fn();
		scrollRegion.releasePointerCapture = vi.fn();

		await fireEvent.click(await screen.findByLabelText("Zoom in"));
		await waitFor(() => {
			expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("125%");
		});

		await fireEvent.pointerDown(scrollRegion, {
			clientX: 120,
			clientY: 120,
			pointerId: 1,
		});
		await fireEvent.pointerMove(scrollRegion, {
			clientX: 90,
			clientY: 80,
			pointerId: 1,
		});
		await fireEvent.pointerUp(scrollRegion, { pointerId: 1 });

		expect(scrollRegion.setPointerCapture).toHaveBeenCalledWith(1);
		expect(scrollRegion.releasePointerCapture).toHaveBeenCalledWith(1);
		expect(scrollRegion.scrollLeft).toBe(130);
		expect(scrollRegion.scrollTop).toBe(140);
	});

	it("shows the first rendered page before later pages finish rendering", async () => {
		const firstPageRender = vi.fn(() => ({
			promise: Promise.resolve(),
			cancel: vi.fn(),
		}));
		let resolveSecondPage: () => void = () => undefined;
		const secondPageRender = vi.fn(() => ({
			promise: new Promise<void>((resolve) => {
				resolveSecondPage = resolve;
			}),
			cancel: vi.fn(),
		}));
		mockPdfRender
			.mockImplementationOnce(firstPageRender)
			.mockImplementationOnce(secondPageRender);

		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 progressive"], {
					type: "application/pdf",
				}),
				filename: "progressive.pdf",
			},
		});

		await waitFor(() => {
			expect(firstPageRender).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(secondPageRender).toHaveBeenCalled();
		});
		expect(
			document.querySelector(".pdf-rendering-overlay"),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("preview-page-input")).toHaveDisplayValue("1");
		expect(screen.getByText("of 2")).toBeInTheDocument();

		resolveSecondPage();
	});

	it("uses a non-passive touchmove listener so pinch zoom can prevent browser scrolling", async () => {
		const addEventListenerSpy = vi.spyOn(
			HTMLElement.prototype,
			"addEventListener",
		);

		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 pinch"], { type: "application/pdf" }),
				filename: "pinch.pdf",
			},
		});

		const scrollRegion = await screen.findByTestId("pdf-scroll-region");
		await waitFor(() => {
			expect(addEventListenerSpy).toHaveBeenCalledWith(
				"touchmove",
				expect.any(Function),
				{ passive: false },
			);
		});

		const touchStart = new Event("touchstart", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(touchStart, "touches", {
			value: [
				{ clientX: 0, clientY: 0 },
				{ clientX: 100, clientY: 0 },
			],
		});
		scrollRegion.dispatchEvent(touchStart);

		const touchMove = new Event("touchmove", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(touchMove, "touches", {
			value: [
				{ clientX: 0, clientY: 0 },
				{ clientX: 150, clientY: 0 },
			],
		});
		const preventDefault = vi.spyOn(touchMove, "preventDefault");
		scrollRegion.dispatchEvent(touchMove);

		expect(preventDefault).toHaveBeenCalled();
		await waitFor(() => {
			expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("150%");
		});
	});

	it("keeps a continuous pinch gesture active across multiple zoom frames", async () => {
		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 continuous pinch"], {
					type: "application/pdf",
				}),
				filename: "continuous-pinch.pdf",
			},
		});

		const scrollRegion = await screen.findByTestId("pdf-scroll-region");
		const touchStart = new Event("touchstart", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(touchStart, "touches", {
			value: [
				{ clientX: 0, clientY: 0 },
				{ clientX: 100, clientY: 0 },
			],
		});
		scrollRegion.dispatchEvent(touchStart);

		const firstTouchMove = new Event("touchmove", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(firstTouchMove, "touches", {
			value: [
				{ clientX: 0, clientY: 0 },
				{ clientX: 150, clientY: 0 },
			],
		});
		scrollRegion.dispatchEvent(firstTouchMove);
		await waitFor(() => {
			expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("150%");
		});

		const secondTouchMove = new Event("touchmove", {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(secondTouchMove, "touches", {
			value: [
				{ clientX: 0, clientY: 0 },
				{ clientX: 200, clientY: 0 },
			],
		});
		scrollRegion.dispatchEvent(secondTouchMove);

		await waitFor(() => {
			expect(screen.getByLabelText("Reset zoom")).toHaveTextContent("200%");
		});
	});

	it("updates the toolbar current page from the most visible observed page", async () => {
		let observerCallback:
			| ((
					entries: Array<{
						isIntersecting: boolean;
						target: Element;
						intersectionRatio: number;
					}>,
			  ) => void)
			| null = null;
		const observedElements: Element[] = [];

		globalThis.IntersectionObserver = class {
			constructor(callback: typeof observerCallback) {
				observerCallback = callback;
			}

			observe(element: Element) {
				observedElements.push(element);
			}

			disconnect() {
				// No-op in this focused observer mock.
			}
		} as typeof IntersectionObserver;

		render(PdfPreview, {
			props: {
				blob: new Blob(["%PDF-1.7 pages"], { type: "application/pdf" }),
				filename: "pages.pdf",
			},
		});

		await waitFor(() => {
			expect(observedElements).toHaveLength(2);
		});

		observerCallback?.([
			{
				isIntersecting: true,
				target: observedElements[0],
				intersectionRatio: 0.25,
			},
			{
				isIntersecting: true,
				target: observedElements[1],
				intersectionRatio: 0.9,
			},
		]);

		await waitFor(() => {
			expect(screen.getByTestId("preview-page-input")).toHaveDisplayValue("2");
		});
	});
});
