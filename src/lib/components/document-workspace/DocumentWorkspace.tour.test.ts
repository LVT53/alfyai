import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { ApiError } from "$lib/client/api/http";
import { ARTIFACT_BODIES } from "$lib/components/artifacts/artifact-bodies";
import type {
	ArtifactTourResponse,
	ResolvedArtifactTour,
	ShippedArtifactTourType,
} from "$lib/shared/artifacts/tours";
import { uiLanguage } from "$lib/stores/settings";
import {
	makeWorkspaceDocument,
	renderWorkspace,
} from "./DocumentWorkspace.test-helpers";

// The first-open tours in the panel (Slice 6): when it asks, when it does not,
// what it writes and when, and how it survives the requests failing. The card
// itself is tested in ArtifactTour.test.ts; the whole thing with a real browser
// in tests/e2e/artifact-tours.spec.ts.

const tourClient = vi.hoisted(() => ({
	getArtifactTour: vi.fn(),
	refreshArtifactTour: vi.fn(),
	markArtifactTourSeen: vi.fn(),
	keepArtifactToursFor: vi.fn(),
}));

vi.mock("$lib/client/api/artifact-tours", () => tourClient);

vi.mock("$lib/services/markdown", () => ({
	renderHighlightedText: vi.fn(
		async (content: string) => `<pre><code>${content}</code></pre>`,
	),
}));

function makeTour(
	kind: ShippedArtifactTourType,
	contentKey = "default:1",
): ResolvedArtifactTour {
	return {
		artifactType: kind,
		contentKey,
		source: contentKey.startsWith("snapshot:") ? "published" : "default",
		slides: [1, 2, 3].map((n) => ({
			title: { en: `${kind} title ${n}`, hu: `${kind} cím ${n}` },
			body: { en: `${kind} body ${n}`, hu: `${kind} szöveg ${n}` },
		})),
		summary: { en: "Empty.", hu: "Üres." },
	};
}

function answer(
	kind: ShippedArtifactTourType,
	overrides: Partial<ArtifactTourResponse> = {},
	contentKey = "default:1",
): ArtifactTourResponse {
	return {
		tour: makeTour(kind, contentKey),
		seen: false,
		lastSlide: 0,
		...overrides,
	};
}

const documentItem = () =>
	makeWorkspaceDocument({
		id: "doc-1",
		artifactId: "doc-1",
		kind: "document",
		title: "Trip notes",
		mimeType: null,
	});
const appItem = () =>
	makeWorkspaceDocument({
		id: "app-1",
		artifactId: "app-1",
		kind: "app",
		title: "Tip calculator",
		mimeType: null,
	});

function openDocument(extra: Parameters<typeof renderWorkspace>[0] = {}) {
	return renderWorkspace({
		documents: [documentItem()],
		activeDocumentId: "doc-1",
		...extra,
	});
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	uiLanguage.set("en");
	stubReducedMotion(true);
	global.fetch = vi.fn();
	tourClient.getArtifactTour.mockImplementation(
		async (kind: ShippedArtifactTourType) => answer(kind),
	);
	tourClient.refreshArtifactTour.mockImplementation(
		async (kind: ShippedArtifactTourType) => answer(kind),
	);
	tourClient.markArtifactTourSeen.mockResolvedValue({
		ok: true,
		alreadyRecorded: false,
	});
	ARTIFACT_BODIES.document = () =>
		import("./__fixtures__/FakeReplayBody.svelte");
	ARTIFACT_BODIES.app = () => import("./__fixtures__/FakeReplayBody.svelte");
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	delete ARTIFACT_BODIES.document;
	delete ARTIFACT_BODIES.app;
	warn.mockRestore();
	uiLanguage.set("en");
});

/** The card, once the lazy chunk has loaded. */
async function card() {
	return screen.findByTestId("artifact-tour");
}

async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

/** The reader's motion preference. The card slides in and out unless it asks for reduced motion; a test that is not about the slide asks for none, so an exit is over at once. */
function stubReducedMotion(reduced: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: reduced,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		})),
	);
}

/** Plays every pending web animation out, in the order they were started (jsdom has none of its own). */
function finishAnimations() {
	const animate = Element.prototype.animate as unknown as Mock;
	const finished = new Set<unknown>();
	for (let guard = 0; guard < 50; guard++) {
		const next = animate.mock.results
			.map((result) => result.value as { onfinish?: () => void })
			.find(
				(made) => typeof made?.onfinish === "function" && !finished.has(made),
			);
		if (!next) return;
		finished.add(next);
		next.onfinish?.();
	}
}

/** What was animated on `element`, in the order it was asked. */
function animationsOn(element: Element) {
	const animate = Element.prototype.animate as unknown as Mock;
	return animate.mock.calls.filter(
		(_call, index) => animate.mock.contexts[index] === element,
	) as [Keyframe[], KeyframeAnimationOptions][];
}

describe("DocumentWorkspace: the first-open tour", () => {
	it("asks for the open item's kind and shows the card above the item", async () => {
		openDocument();

		const tour = await card();
		expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(1);
		expect(tourClient.getArtifactTour.mock.calls[0][0]).toBe("document");
		expect(tour).toHaveAttribute("data-kind", "document");
		expect(screen.getByTestId("artifact-tour-title")).toHaveTextContent(
			"document title 1",
		);
		// Above the artifact, inside the panel's content area.
		const body = await screen.findByTestId("fake-replay-body");
		expect(
			tour.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			tour.closest('[data-testid="page-scroll-container"]'),
		).not.toBeNull();
		// Showing it wrote nothing.
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();
	});

	it("says whose answers they are before it asks, so another reader in the same tab is not told the last one's", async () => {
		openDocument({
			currentUser: { id: "reader-a", displayName: "A", profilePicture: null },
		});
		await card();

		expect(tourClient.keepArtifactToursFor).toHaveBeenCalledWith("reader-a");
		expect(
			tourClient.keepArtifactToursFor.mock.invocationCallOrder[0],
		).toBeLessThan(tourClient.getArtifactTour.mock.invocationCallOrder[0]);
	});

	it("shows nothing for a tour the reader has seen, and nothing for one with no slides", async () => {
		tourClient.getArtifactTour.mockResolvedValueOnce(
			answer("document", { seen: true, lastSlide: 2 }),
		);
		const { rerender } = openDocument();
		await screen.findByTestId("fake-replay-body");
		await settle();
		expect(screen.queryByTestId("artifact-tour")).toBeNull();

		const slideless = answer("app");
		slideless.tour.slides = [];
		tourClient.getArtifactTour.mockResolvedValueOnce(slideless);
		await rerender({
			documents: [documentItem(), appItem()],
			activeDocumentId: "app-1",
		});
		await settle();
		expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(2);
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
	});

	// The empty states (Slice 6 T6) say what the tour says: the panel keeps the
	// summary from its one request per open and hands it to the body, seen or not.
	it("hands the open item's tour summary to its body, whether or not the reader has seen the tour", async () => {
		const seen = answer("document", { seen: true, lastSlide: 2 });
		seen.tour.summary = { en: "Seen summary.", hu: "Látott összegzés." };
		tourClient.getArtifactTour.mockResolvedValueOnce(seen);
		openDocument();

		const body = await screen.findByTestId("fake-replay-body");
		await waitFor(() =>
			expect(body).toHaveAttribute("data-tour-summary", "Seen summary."),
		);
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		// One request answered both: the card's question and the empty state's.
		expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(1);
	});

	it("hands the summary on while the card shows, and after it has gone", async () => {
		openDocument();
		const tour = await card();
		const body = screen.getByTestId("fake-replay-body");
		await waitFor(() =>
			expect(body).toHaveAttribute("data-tour-summary", "Empty."),
		);

		await fireEvent.click(within(tour).getByTestId("artifact-tour-skip"));

		await waitFor(() =>
			expect(screen.queryByTestId("artifact-tour")).toBeNull(),
		);
		expect(screen.getByTestId("fake-replay-body")).toHaveAttribute(
			"data-tour-summary",
			"Empty.",
		);
	});

	it("hands each kind its own summary, and an item the previous one's summary never", async () => {
		const doc = answer("document", { seen: true });
		doc.tour.summary = { en: "Document summary.", hu: "Dokumentum." };
		const app = answer("app", { seen: true });
		app.tour.summary = { en: "App summary.", hu: "Alkalmazás." };
		tourClient.getArtifactTour
			.mockResolvedValueOnce(doc)
			.mockResolvedValueOnce(app);
		const { rerender } = openDocument();
		await waitFor(() =>
			expect(screen.getByTestId("fake-replay-body")).toHaveAttribute(
				"data-tour-summary",
				"Document summary.",
			),
		);

		await rerender({
			documents: [documentItem(), appItem()],
			activeDocumentId: "app-1",
		});

		await waitFor(() =>
			expect(screen.getByTestId("fake-replay-body")).toHaveAttribute(
				"data-tour-summary",
				"App summary.",
			),
		);
	});

	it("hands none in an incognito chat, which asks for none", async () => {
		openDocument({ incognito: true });

		const body = await screen.findByTestId("fake-replay-body");
		await settle();
		expect(body).toHaveAttribute("data-tour-summary", "none");
		expect(tourClient.getArtifactTour).not.toHaveBeenCalled();
	});

	it("hands none when the request fails, and the body still shows", async () => {
		tourClient.getArtifactTour.mockRejectedValueOnce(
			new ApiError("Failed to load the introduction", { status: 500 }),
		);
		openDocument();

		const body = await screen.findByTestId("fake-replay-body");
		await settle();
		expect(body).toHaveAttribute("data-tour-summary", "none");
	});

	it("never asks about a File, an upload, or a kind whose tour does not ship", async () => {
		for (const kind of [undefined, "file", "slides"] as const) {
			cleanup();
			renderWorkspace({
				documents: [
					makeWorkspaceDocument({
						id: "item-1",
						artifactId: "item-1",
						kind,
						title: "Something",
					}),
				],
				activeDocumentId: "item-1",
			});
			await settle();
		}
		expect(tourClient.getArtifactTour).not.toHaveBeenCalled();
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
	});

	it("makes no request at all in an incognito chat", async () => {
		openDocument({ incognito: true });
		await screen.findByTestId("fake-replay-body");
		await settle();

		expect(tourClient.getArtifactTour).not.toHaveBeenCalled();
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		// And a body is given no replay to offer there.
		expect(screen.getByTestId("fake-replay-body")).toHaveAttribute(
			"data-can-replay",
			"false",
		);
	});

	it("does not ask while the panel is closed or showing its list", async () => {
		const { rerender } = openDocument({ open: false });
		await settle();
		expect(tourClient.getArtifactTour).not.toHaveBeenCalled();

		await rerender({
			open: true,
			list: { open: true, items: [documentItem()] },
		});
		await settle();
		expect(tourClient.getArtifactTour).not.toHaveBeenCalled();

		// Closing the list onto the item is the open.
		await rerender({
			open: true,
			list: { open: false, items: [documentItem()] },
		});
		await card();
		expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(1);
	});

	it("writes 'completed' with the key and the last slide when the reader finishes, once", async () => {
		openDocument();
		await card();

		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		await fireEvent.click(screen.getByTestId("artifact-tour-done"));

		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		expect(tourClient.markArtifactTourSeen).toHaveBeenCalledTimes(1);
		expect(tourClient.markArtifactTourSeen).toHaveBeenCalledWith("document", {
			contentKey: "default:1",
			status: "completed",
			lastSlide: 2,
		});
	});

	it("writes 'dismissed' with the slide the reader skipped from", async () => {
		openDocument();
		await card();

		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));

		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		expect(tourClient.markArtifactTourSeen).toHaveBeenCalledWith("document", {
			contentKey: "default:1",
			status: "dismissed",
			lastSlide: 1,
		});
	});

	it("writes nothing when the panel closes mid-tour, and shows the tour again from its first slide", async () => {
		const { rerender } = openDocument();
		await card();
		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"Step 2 of 3",
		);

		await rerender({ open: false });
		await settle();
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();

		await rerender({ open: true });
		await card();
		expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"Step 1 of 3",
		);
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();
	});

	it("shows each kind's own tour when the open item changes, and never the previous one's", async () => {
		const { rerender } = renderWorkspace({
			documents: [documentItem(), appItem()],
			activeDocumentId: "doc-1",
		});
		await card();
		expect(screen.getByTestId("artifact-tour")).toHaveAttribute(
			"data-kind",
			"document",
		);

		await rerender({ activeDocumentId: "app-1" });
		await waitFor(() =>
			expect(screen.getByTestId("artifact-tour")).toHaveAttribute(
				"data-kind",
				"app",
			),
		);
		expect(
			tourClient.getArtifactTour.mock.calls.map((call) => call[0]),
		).toEqual(["document", "app"]);
	});

	it("ignores an answer that arrives after the reader moved to another item", async () => {
		let release: (value: ArtifactTourResponse) => void = () => undefined;
		tourClient.getArtifactTour.mockImplementationOnce(
			() =>
				new Promise<ArtifactTourResponse>((resolve) => {
					release = resolve;
				}),
		);
		const { rerender } = renderWorkspace({
			documents: [documentItem(), appItem()],
			activeDocumentId: "doc-1",
		});
		await settle();
		await rerender({ activeDocumentId: "app-1" });
		await waitFor(() =>
			expect(screen.getByTestId("artifact-tour")).toHaveAttribute(
				"data-kind",
				"app",
			),
		);

		release(answer("document"));
		await settle();
		expect(screen.getByTestId("artifact-tour")).toHaveAttribute(
			"data-kind",
			"app",
		);
	});

	it("reads a 409 on the seen write as 'the copy changed': it asks again and starts the new one from slide one", async () => {
		openDocument();
		await card();
		tourClient.markArtifactTourSeen.mockRejectedValueOnce(
			new ApiError("conflict", { status: 409 }),
		);
		tourClient.getArtifactTour.mockResolvedValueOnce(
			answer("document", {}, "snapshot:abc"),
		);

		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));

		await waitFor(() =>
			expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(2),
		);
		const again = await screen.findByTestId("artifact-tour");
		expect(again).toBeInTheDocument();
		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"Step 1 of 3",
		);
		// The new tour is recorded against its own key.
		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));
		await waitFor(() =>
			expect(tourClient.markArtifactTourSeen).toHaveBeenLastCalledWith(
				"document",
				{ contentKey: "snapshot:abc", status: "dismissed", lastSlide: 0 },
			),
		);
	});

	it("does not ask again after a 409 when the reader has already left the item", async () => {
		const { rerender } = renderWorkspace({
			documents: [documentItem(), appItem()],
			activeDocumentId: "doc-1",
		});
		await card();
		let reject: (error: unknown) => void = () => undefined;
		tourClient.markArtifactTourSeen.mockImplementationOnce(
			() =>
				new Promise((_, rejectWith) => {
					reject = rejectWith;
				}),
		);
		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));
		await rerender({ activeDocumentId: "app-1" });
		await card();
		const asked = tourClient.getArtifactTour.mock.calls.length;

		reject(new ApiError("conflict", { status: 409 }));
		await settle();
		expect(tourClient.getArtifactTour.mock.calls.length).toBe(asked);
	});

	it("shows no card, warns, and leaves the panel working when the tour cannot be fetched", async () => {
		tourClient.getArtifactTour.mockRejectedValueOnce(
			new ApiError("boom", { status: 500 }),
		);
		openDocument();

		expect(await screen.findByTestId("fake-replay-body")).toBeInTheDocument();
		await waitFor(() => expect(warn).toHaveBeenCalled());
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("closes the card anyway, with a warning, when the seen write fails", async () => {
		tourClient.markArtifactTourSeen.mockRejectedValueOnce(
			new ApiError("boom", { status: 500 }),
		);
		openDocument();
		await card();

		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));

		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		await waitFor(() => expect(warn).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("DocumentWorkspace: replaying a tour", () => {
	const listWith = (items = [documentItem(), appItem()], open = true) => ({
		open,
		items,
	});

	/** Every answer the page gets says the reader has seen the tour. */
	function everyTourSeen() {
		const seen = async (kind: ShippedArtifactTourType) =>
			answer(kind, { seen: true, lastSlide: 2 });
		tourClient.getArtifactTour.mockImplementation(seen);
		tourClient.refreshArtifactTour.mockImplementation(seen);
	}

	it("hands a body the replay, which shows the tour again whether or not it was seen, and writes nothing", async () => {
		everyTourSeen();
		openDocument();
		const replayButton = await screen.findByTestId("fake-replay");
		await settle();
		expect(screen.queryByTestId("artifact-tour")).toBeNull();

		expect(tourClient.refreshArtifactTour).not.toHaveBeenCalled();
		await fireEvent.click(replayButton);

		const tour = await card();
		expect(tour).toHaveAttribute("data-replay", "true");
		// The open took what the page load had; the replay asked the server again,
		// so it shows the copy as it is now.
		expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(1);
		expect(tourClient.refreshArtifactTour).toHaveBeenCalledTimes(1);
		expect(tourClient.refreshArtifactTour.mock.calls[0][0]).toBe("document");
		expect(screen.getByTestId("artifact-tour-replaying")).toHaveTextContent(
			"Replaying",
		);
		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		await fireEvent.click(screen.getByTestId("artifact-tour-done"));
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();
	});

	it("opens the item and replays its tour from the list row's menu, writing nothing", async () => {
		everyTourSeen();
		const onSelectDocument = vi.fn();
		const onListOpenChange = vi.fn();
		const { rerender } = renderWorkspace({
			documents: [documentItem()],
			activeDocumentId: "doc-1",
			list: listWith(),
			onDeleteArtifact: vi.fn(async () => {}),
			onSelectDocument,
			onListOpenChange,
		});
		await settle();
		expect(tourClient.getArtifactTour).not.toHaveBeenCalled();

		await fireEvent.click(
			await within(await screen.findByTestId("artifact-panel-list")).findByRole(
				"button",
				{ name: "More actions for Trip notes" },
			),
		);
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "How this kind works" }),
		);
		expect(onSelectDocument).toHaveBeenCalledWith("doc-1");
		expect(onListOpenChange).toHaveBeenCalledWith(false);

		// The host answers by opening the item, as the chat page does.
		await rerender({ list: listWith(undefined, false) });
		const tour = await card();
		expect(tour).toHaveAttribute("data-replay", "true");
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();

		// Only that one open was a replay: the next open of the item is an ordinary one.
		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));
		await rerender({ list: listWith(undefined, true) });
		await rerender({ list: listWith(undefined, false) });
		await settle();
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
		expect(tourClient.markArtifactTourSeen).not.toHaveBeenCalled();
	});

	it("offers no replay row for a File, and none in an incognito chat", async () => {
		const file = makeWorkspaceDocument({
			id: "file-1",
			artifactId: "file-1",
			kind: "file",
			title: "Summary.pdf",
		});
		renderWorkspace({
			documents: [file],
			activeDocumentId: "file-1",
			list: { open: true, items: [file, documentItem()] },
			onDeleteArtifact: vi.fn(async () => {}),
		});
		await fireEvent.click(
			await within(await screen.findByTestId("artifact-panel-list")).findByRole(
				"button",
				{ name: "More actions for Summary.pdf" },
			),
		);
		expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
		expect(
			screen.queryByRole("menuitem", { name: "How this kind works" }),
		).toBeNull();
		cleanup();

		renderWorkspace({
			documents: [documentItem()],
			activeDocumentId: "doc-1",
			incognito: true,
			list: { open: true, items: [documentItem()] },
			onDeleteArtifact: vi.fn(async () => {}),
		});
		await fireEvent.click(
			await within(await screen.findByTestId("artifact-panel-list")).findByRole(
				"button",
				{ name: "More actions for Trip notes" },
			),
		);
		expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
		expect(
			screen.queryByRole("menuitem", { name: "How this kind works" }),
		).toBeNull();
	});
});

describe("DocumentWorkspace: how the card arrives and leaves", () => {
	beforeEach(() => stubReducedMotion(false));

	it("slides in from nothing, and leaves by sliding out: it is in the page until its exit has played", async () => {
		openDocument();
		const tour = await card();
		const wrapper = tour.closest(".tour-reveal") as HTMLElement;
		expect(wrapper).not.toBeNull();

		// The entrance starts from a collapsed height: the page below the card is
		// moved by a height that grows, not by a card that appears.
		const entrance = animationsOn(wrapper);
		expect(entrance.length).toBeGreaterThan(0);
		expect(entrance[0][0][0]).toHaveProperty("height");
		expect(entrance[0][0][0]).toHaveProperty("overflow", "hidden");
		finishAnimations();

		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));

		// The write is not held back by the exit...
		expect(tourClient.markArtifactTourSeen).toHaveBeenCalledTimes(1);
		// ...but the card stays, out of reach, until it has shrunk away.
		expect(screen.getByTestId("artifact-tour")).toBeInTheDocument();
		expect(wrapper).toHaveProperty("inert", true);
		const before = animationsOn(wrapper).length;
		expect(before).toBeGreaterThan(entrance.length);
		finishAnimations();
		await waitFor(() =>
			expect(screen.queryByTestId("artifact-tour")).toBeNull(),
		);
	});

	it("brings the tour back as a new card at its first slide when the copy changed while the old one was leaving", async () => {
		tourClient.markArtifactTourSeen.mockRejectedValueOnce(
			new ApiError("changed", { status: 409 }),
		);
		tourClient.getArtifactTour
			.mockResolvedValueOnce(answer("document"))
			.mockResolvedValueOnce(answer("document", {}, "snapshot:new"));
		openDocument();
		await card();
		finishAnimations();
		await fireEvent.click(screen.getByTestId("artifact-tour-next"));
		expect(screen.getByTestId("artifact-tour-step")).toHaveTextContent(
			"Step 2 of 3",
		);

		// Skipped: the 409 comes back while that card is still on its way out.
		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));
		await waitFor(() =>
			expect(tourClient.getArtifactTour).toHaveBeenCalledTimes(2),
		);

		// The card that is shown now is a new one, not the old card called back:
		// first slide, and its buttons work (the old one had already been left).
		const newest = await waitFor(() => {
			const found = screen
				.getAllByTestId("artifact-tour")
				.find((card) => within(card).queryByText("Step 1 of 3"));
			expect(found).toBeTruthy();
			return found as HTMLElement;
		});
		finishAnimations();
		await fireEvent.click(within(newest).getByTestId("artifact-tour-next"));
		await fireEvent.click(within(newest).getByTestId("artifact-tour-next"));
		await fireEvent.click(within(newest).getByTestId("artifact-tour-done"));
		await waitFor(() =>
			expect(tourClient.markArtifactTourSeen).toHaveBeenLastCalledWith(
				"document",
				{ contentKey: "snapshot:new", status: "completed", lastSlide: 2 },
			),
		);
	});

	it("is simply there, and simply gone, under reduced motion", async () => {
		stubReducedMotion(true);
		openDocument();
		const tour = await card();
		expect(animationsOn(tour.closest(".tour-reveal") as HTMLElement)).toEqual(
			[],
		);

		await fireEvent.click(screen.getByTestId("artifact-tour-skip"));
		expect(screen.queryByTestId("artifact-tour")).toBeNull();
	});
});
