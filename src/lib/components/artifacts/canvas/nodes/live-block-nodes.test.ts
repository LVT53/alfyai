import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { CanvasBoardContext } from "../_lib/board-context";
import type {
	BlockRefreshResult,
	CanvasChatContext,
} from "../_lib/chat-context";
import WithChat from "../_test/WithChat.svelte";
import LazyNode from "./LazyNode.svelte";

// Photos and live web, drawn the way the board draws them (through `LazyNode`, which
// loads each block's content inside the shell, the real loaders here, against a
// stand-in for the flow library). What is measured is what each block PROMISES: a
// photo is only ever the app's own thumbnail and opens the chat's lightbox; a
// snapshot says how old it is, links only to web addresses, and refreshes only by
// asking the host to re-run the search it already stores.

vi.mock("@xyflow/svelte", async () =>
	(await import("../_test/xyflow-mock")).xyflowMock(),
);

function board(
	overrides: Partial<CanvasBoardContext> = {},
): CanvasBoardContext {
	return {
		readonly: false,
		requestEdit() {},
		takeEditRequest: () => false,
		dropTargetId: null,
		...overrides,
	};
}

function chatContext(
	overrides: Partial<CanvasChatContext> = {},
): CanvasChatContext {
	return { conversationId: "conv-1", ...overrides };
}

function mount(
	kind: "photo" | "liveweb",
	data: Record<string, unknown>,
	options: { chat?: CanvasChatContext; board?: CanvasBoardContext } = {},
) {
	return render(WithChat, {
		props: {
			component: LazyNode,
			componentProps: { id: `${kind}-node`, type: kind, selected: false, data },
			context: options.board ?? board(),
			chat: options.chat ?? chatContext(),
		},
	});
}

const wrapper = () => screen.getByTestId("node-wrapper");

beforeEach(() => {
	uiLanguage.set("en");
});

// ── Photos ──────────────────────────────────────────────────────────────────

const proxy = (id: string) => `/api/connections/immich/thumbnail/${id}`;
const photoData = (count = 3, extra: Record<string, unknown> = {}) => ({
	kind: "photo",
	items: Array.from({ length: count }, (_, index) => ({
		id: `asset-${index + 1}`,
		imageUrl: proxy(`asset-${index + 1}`),
	})),
	...extra,
});

/** Every image the block hands the browser to load. */
const loadedSources = (container: HTMLElement) =>
	[...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

describe("a photo block", () => {
	it("draws a thumbnail for each photo, from the app's own proxy, each a named button", async () => {
		const { container } = mount("photo", photoData(3));
		await screen.findByTestId("canvas-photo");

		expect(loadedSources(container)).toEqual([
			proxy("asset-1"),
			proxy("asset-2"),
			proxy("asset-3"),
		]);
		for (const number of [1, 2, 3]) {
			expect(
				screen.getByRole("button", {
					name: `Open photo ${number} of 3`,
				}),
			).toBeInTheDocument();
		}
	});

	it("draws six thumbnails and says how many more there are on the last one", async () => {
		const { container } = mount("photo", photoData(9));
		await screen.findByTestId("canvas-photo");

		expect(container.querySelectorAll("img")).toHaveLength(6);
		expect(screen.getByText("+3")).toBeInTheDocument();
		// The count is a picture of "more", not a second name for the button.
		expect(
			screen.getByRole("button", { name: "Open photo 6 of 9" }),
		).toBeInTheDocument();
	});

	it("never hands the browser an address that is not the app's own thumbnail, whatever the stored data says", async () => {
		const hostile = [
			"https://evil.example/pixel.png?d=secret",
			"//evil.example/p.png",
			"/\\evil.example/p.png",
			"/\t/evil.example/p.png",
			"javascript:alert(1)",
			"data:image/svg+xml,<svg onload=alert(1)>",
			"/api/auth/logout",
			"/api/chat/files/f1/download",
		];
		const { container } = mount("photo", {
			kind: "photo",
			items: [
				...hostile.map((imageUrl, index) => ({ id: `bad-${index}`, imageUrl })),
				{ id: "good", imageUrl: proxy("good") },
			],
		});
		await screen.findByTestId("canvas-photo");

		expect(loadedSources(container)).toEqual([proxy("good")]);
		// Nothing of the rest is in the page at all, not even as an attribute.
		expect(container.innerHTML).not.toContain("evil.example");
		expect(container.innerHTML).not.toContain("logout");
		// The block counts only what it draws.
		expect(
			screen.getByRole("button", { name: "Open photo 1 of 1" }),
		).toBeInTheDocument();
	});

	it("says so, and draws no image, when none of the stored addresses is one it may draw", async () => {
		const { container } = mount("photo", {
			kind: "photo",
			items: [{ id: "bad", imageUrl: "https://evil.example/p.png" }],
		});
		await screen.findByTestId("canvas-photo");
		expect(container.querySelectorAll("img")).toHaveLength(0);
		expect(screen.getByText("No photos in this block.")).toBeInTheDocument();
	});

	it("says so for a block with no photos in it", async () => {
		mount("photo", { kind: "photo", items: [] });
		expect(
			await screen.findByText("No photos in this block."),
		).toBeInTheDocument();
	});

	it("opens the chat's own lightbox at the photo that was clicked, and names it", async () => {
		mount("photo", photoData(3));
		await screen.findByTestId("canvas-photo");

		await fireEvent.click(
			screen.getByRole("button", { name: "Open photo 2 of 3" }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(dialog).toBe(screen.getByTestId("image-lightbox"));
		const shown = within(dialog).getByRole("img", { name: "Photo 2" });
		expect(shown.getAttribute("src")).toBe(proxy("asset-2"));
		expect(
			within(dialog).getByTestId("image-lightbox-counter"),
		).toHaveTextContent("2 / 3");
	});

	it("pages through every photo of the block from the lightbox, not only the six the block draws", async () => {
		mount("photo", photoData(9));
		await screen.findByTestId("canvas-photo");
		await fireEvent.click(
			screen.getByRole("button", { name: "Open photo 6 of 9" }),
		);
		const dialog = await screen.findByRole("dialog");

		await fireEvent.keyDown(window, { key: "ArrowRight" });
		await fireEvent.keyDown(window, { key: "ArrowRight" });

		expect(
			within(dialog).getByRole("img", { name: "Photo 8" }).getAttribute("src"),
		).toBe(proxy("asset-8"));
	});

	it("moves focus into the lightbox when it opens and back to the thumbnail that opened it when it closes, by Escape and by its button", async () => {
		mount("photo", photoData(3));
		await screen.findByTestId("canvas-photo");
		const thumbnail = screen.getByRole("button", { name: "Open photo 2 of 3" });
		thumbnail.focus();

		await fireEvent.click(thumbnail);
		const dialog = await screen.findByRole("dialog");
		await waitFor(() => expect(document.activeElement).toBe(dialog));

		await fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(thumbnail));

		// Opened again, from another thumbnail, and closed by the dialog's own button.
		const other = screen.getByRole("button", { name: "Open photo 3 of 3" });
		other.focus();
		await fireEvent.click(other);
		await waitFor(() => expect(document.activeElement).toBe(dialog));
		await fireEvent.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(document.activeElement).toBe(other));
	});

	it("shows a quiet empty tile for a thumbnail that will not load, keeps the others, and leaves it out of the lightbox", async () => {
		const { container } = mount("photo", photoData(3));
		await screen.findByTestId("canvas-photo");

		await fireEvent.error(
			container.querySelectorAll("img")[1] as HTMLImageElement,
		);

		const missing = await screen.findByTestId("canvas-photo-missing");
		expect(missing).toHaveAccessibleName("Photo not available");
		expect(loadedSources(container)).toEqual([
			proxy("asset-1"),
			proxy("asset-3"),
		]);
		// The tile is not a button: there is nothing to open.
		expect(missing.tagName).not.toBe("BUTTON");

		await fireEvent.click(
			screen.getByRole("button", { name: "Open photo 3 of 3" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByTestId("image-lightbox-counter"),
		).toHaveTextContent("2 / 2");
		expect(
			within(dialog).getByRole("img", { name: "Photo 3" }).getAttribute("src"),
		).toBe(proxy("asset-3"));
	});

	it("keeps the browser's own picture drag and referrer out of it, so the board's drag is the only drag", async () => {
		const { container } = mount("photo", photoData(1));
		await screen.findByTestId("canvas-photo");
		const image = container.querySelector("img");
		expect(image?.getAttribute("draggable")).toBe("false");
		expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(image?.getAttribute("loading")).toBe("lazy");
	});

	it("names the node for a screen reader by its kind, and is named in Hungarian too", async () => {
		mount("photo", photoData(2));
		await screen.findByTestId("canvas-photo");
		await waitFor(() =>
			expect(wrapper().getAttribute("aria-label")).toBe("Photos"),
		);
	});

	it("says everything it says in Hungarian, in the reader's language", async () => {
		uiLanguage.set("hu");
		const { container } = mount("photo", photoData(9));
		await screen.findByTestId("canvas-photo");
		expect(
			screen.getByRole("button", { name: "1. fénykép megnyitása (9 közül)" }),
		).toBeInTheDocument();
		await fireEvent.error(
			container.querySelectorAll("img")[0] as HTMLImageElement,
		);
		expect(
			await screen.findByTestId("canvas-photo-missing"),
		).toHaveAccessibleName("A fénykép nem érhető el");
		await waitFor(() =>
			expect(wrapper().getAttribute("aria-label")).toBe("Fényképek"),
		);
	});
});

// ── Live web ────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const source = (index: number, extra: Record<string, unknown> = {}) => ({
	id: `s${index}`,
	title: `Cork weather ${index}`,
	url: `https://weather${index}.example.com/cork`,
	provider: "parallel",
	authorityClass: "primary",
	authorityScore: 0.9,
	publishedAt: null,
	updatedAt: null,
	snippet: `Snippet ${index}`,
	...extra,
});
const webData = (
	sources = [source(1), source(2), source(3)],
	extra: Record<string, unknown> = {},
) => ({
	kind: "liveweb",
	query: "cork weather this weekend",
	sources,
	fetchedAt: NOW - 5 * 60_000,
	...extra,
});

describe("a live-web block", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("shows the query it searched and the sources it returned, as the chat shows a search's sources", async () => {
		mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");

		expect(screen.getByText("cork weather this weekend")).toBeInTheDocument();
		const sources = screen.getAllByTestId("canvas-liveweb-source");
		expect(sources).toHaveLength(3);
		expect(sources[0]).toHaveTextContent("Cork weather 1");
		expect(sources[0]).toHaveTextContent("weather1.example.com");
	});

	it("makes each source a link that opens the page in a new tab and tells the site nothing about the board", async () => {
		mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");

		const link = screen.getByRole("link", { name: /Cork weather 2/ });
		expect(link.getAttribute("href")).toBe("https://weather2.example.com/cork");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(link.getAttribute("draggable")).toBe("false");
	});

	it("draws a site's icon from the app's own favicon proxy, never from the site", async () => {
		const { container } = mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");

		const icons = [
			...container.querySelectorAll<HTMLImageElement>(".web__favicon img"),
		].map((img) => img.getAttribute("src"));
		expect(icons).toEqual([
			"/api/favicon?domain=weather1.example.com",
			"/api/favicon?domain=weather2.example.com",
			"/api/favicon?domain=weather3.example.com",
		]);
		for (const img of container.querySelectorAll(".web__favicon img")) {
			expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
		}
	});

	it("draws a source whose address is not a web address as plain words, never as a link", async () => {
		const { container } = mount(
			"liveweb",
			webData([
				source(1, { url: "javascript:alert(1)" }),
				source(2, { url: "data:text/html,<script>alert(1)</script>" }),
				source(3, { url: "//evil.example/x" }),
				source(4),
			]),
		);
		await screen.findByTestId("canvas-liveweb");

		expect(screen.getAllByRole("link")).toHaveLength(1);
		expect(container.querySelector('a[href^="javascript"]')).toBeNull();
		expect(container.querySelector('a[href^="data"]')).toBeNull();
		expect(container.innerHTML).not.toContain('href="//evil');
		// The words are still there: the block does not hide what it holds.
		expect(screen.getByText("Cork weather 1")).toBeInTheDocument();
	});

	it("gives a source's tooltip as plain words, never the markup a search provider's text can carry", async () => {
		mount(
			"liveweb",
			webData([
				source(1, { snippet: "<b>Bold</b> and **markdown** [link](http://x)" }),
			]),
		);
		await screen.findByTestId("canvas-liveweb");
		const title = screen.getByRole("link").getAttribute("title");
		expect(title).toBe("Bold and markdown link");
	});

	it("says how old the snapshot is, and does not call a recent one not live", async () => {
		mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");
		expect(screen.getByTestId("canvas-liveweb-age")).toHaveTextContent(
			"Updated 5 min ago",
		);
		expect(screen.queryByTestId("canvas-liveweb-stale")).toBeNull();
	});

	it("keeps the age current as the clock moves", async () => {
		mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");
		await act(() => vi.advanceTimersByTime(60_000));
		await waitFor(() =>
			expect(screen.getByTestId("canvas-liveweb-age")).toHaveTextContent(
				"Updated 6 min ago",
			),
		);
	});

	it("says it is not live once the snapshot is past its window, and only then", async () => {
		mount("liveweb", webData(undefined, { fetchedAt: NOW - 59 * 60_000 }));
		await screen.findByTestId("canvas-liveweb");
		expect(screen.queryByTestId("canvas-liveweb-stale")).toBeNull();
		await act(() => vi.advanceTimersByTime(3 * 60_000));
		await waitFor(() =>
			expect(screen.getByTestId("canvas-liveweb-stale")).toHaveTextContent(
				"Not live",
			),
		);
	});

	it("calls a snapshot from yesterday not live at once, and says how long ago", async () => {
		mount("liveweb", webData(undefined, { fetchedAt: NOW - 26 * 60 * 60_000 }));
		await screen.findByTestId("canvas-liveweb");
		expect(screen.getByTestId("canvas-liveweb-stale")).toHaveTextContent(
			"Not live",
		);
		expect(screen.getByTestId("canvas-liveweb-age")).toHaveTextContent(
			"Updated Yesterday",
		);
	});

	it("draws eight sources and says how many more it holds", async () => {
		const many = Array.from({ length: 11 }, (_, index) => source(index + 1));
		mount("liveweb", webData(many));
		await screen.findByTestId("canvas-liveweb");
		expect(screen.getAllByTestId("canvas-liveweb-source")).toHaveLength(8);
		expect(screen.getByText("+3 more")).toBeInTheDocument();
	});

	it("says so for a block with no sources", async () => {
		mount("liveweb", webData([]));
		expect(
			await screen.findByText("No sources in this block."),
		).toBeInTheDocument();
	});

	it("names the node for a screen reader by its kind and its query", async () => {
		mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");
		await waitFor(() =>
			expect(wrapper().getAttribute("aria-label")).toBe(
				"Live web: cork weather this weekend",
			),
		);
	});

	it("says everything it says in Hungarian", async () => {
		uiLanguage.set("hu");
		mount("liveweb", webData(undefined, { fetchedAt: NOW - 3 * 60 * 60_000 }), {
			chat: chatContext({
				refreshBlock: vi.fn(async () => ({ ok: true }) as BlockRefreshResult),
			}),
		});
		await screen.findByTestId("canvas-liveweb");
		expect(screen.getByTestId("canvas-liveweb-age")).toHaveTextContent(
			"Frissítve: 3 órája",
		);
		expect(screen.getByTestId("canvas-liveweb-stale")).toHaveTextContent(
			"Nem élő",
		);
		expect(
			screen.getByRole("button", { name: "Frissítés" }),
		).toBeInTheDocument();
	});
});

describe("a live-web block's Refresh", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	function deferred() {
		let resolve!: (value: BlockRefreshResult) => void;
		const promise = new Promise<BlockRefreshResult>((res) => {
			resolve = res;
		});
		return { promise, resolve };
	}

	it("asks the host to re-run the search with the block's own id and nothing else", async () => {
		const refreshBlock = vi.fn(
			async () => ({ ok: true }) as BlockRefreshResult,
		);
		mount("liveweb", webData(), { chat: chatContext({ refreshBlock }) });
		await screen.findByTestId("canvas-liveweb");

		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		expect(refreshBlock).toHaveBeenCalledTimes(1);
		const args = refreshBlock.mock.calls[0] as unknown as unknown[];
		expect(args[0]).toBe("liveweb-node");
		// A signal, so a block that goes away stops the search; no query, no address.
		expect(args[1]).toBeInstanceOf(AbortSignal);
		expect(args).toHaveLength(2);
	});

	it("says it is refreshing, keeps focus on its button, ignores a second press, and comes back when it is done", async () => {
		const pending = deferred();
		const refreshBlock = vi.fn(() => pending.promise);
		mount("liveweb", webData(), { chat: chatContext({ refreshBlock }) });
		await screen.findByTestId("canvas-liveweb");
		const button = screen.getByTestId("canvas-liveweb-refresh");
		button.focus();

		await fireEvent.click(button);
		expect(button).toHaveTextContent("Refreshing…");
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.getAttribute("aria-disabled")).toBe("true");
		// It is not `disabled`: a disabled button drops the focus the reader is on.
		expect(button).not.toBeDisabled();
		expect(document.activeElement).toBe(button);

		await fireEvent.click(button);
		expect(refreshBlock).toHaveBeenCalledTimes(1);

		pending.resolve({ ok: true });
		await waitFor(() => expect(button).toHaveTextContent("Refresh"));
		expect(button.getAttribute("aria-busy")).toBe("false");
		expect(screen.getByTestId("canvas-liveweb-status")).toHaveTextContent("");
	});

	it("says it could not refresh, leaves the snapshot as it was, and lets the reader try again", async () => {
		const refreshBlock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, reason: "refresh_failed" })
			.mockResolvedValueOnce({ ok: true });
		mount("liveweb", webData(), { chat: chatContext({ refreshBlock }) });
		await screen.findByTestId("canvas-liveweb");

		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		await waitFor(() =>
			expect(screen.getByTestId("canvas-liveweb-status")).toHaveTextContent(
				"Could not refresh this block.",
			),
		);
		expect(screen.getAllByTestId("canvas-liveweb-source")).toHaveLength(3);
		expect(screen.getByTestId("canvas-liveweb-age")).toHaveTextContent(
			"Updated 5 min ago",
		);

		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.getByTestId("canvas-liveweb-status")).toHaveTextContent(""),
		);
		expect(refreshBlock).toHaveBeenCalledTimes(2);
	});

	it("tells a search that found nothing, and one asked too often, apart from one that failed", async () => {
		const refreshBlock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, reason: "no_results" })
			.mockResolvedValueOnce({ ok: false, reason: "rate_limited" })
			.mockResolvedValueOnce({ ok: false, reason: "not_found" });
		mount("liveweb", webData(), { chat: chatContext({ refreshBlock }) });
		await screen.findByTestId("canvas-liveweb");
		const status = () => screen.getByTestId("canvas-liveweb-status");

		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(status()).toHaveTextContent(
				"The search found nothing new to show.",
			),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(status()).toHaveTextContent(
				"Too many searches at once. Try again in a moment.",
			),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(status()).toHaveTextContent("Could not refresh this block."),
		);
	});

	it("says it could not refresh when the host throws, too", async () => {
		const refreshBlock = vi.fn().mockRejectedValue(new Error("boom"));
		mount("liveweb", webData(), { chat: chatContext({ refreshBlock }) });
		await screen.findByTestId("canvas-liveweb");
		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.getByTestId("canvas-liveweb-status")).toHaveTextContent(
				"Could not refresh this block.",
			),
		);
	});

	it("stops the search when the block goes away", async () => {
		const pending = deferred();
		let signal: AbortSignal | undefined;
		const refreshBlock = vi.fn((_id: string, given?: AbortSignal) => {
			signal = given;
			return pending.promise;
		});
		const { unmount } = mount("liveweb", webData(), {
			chat: chatContext({ refreshBlock }),
		});
		await screen.findByTestId("canvas-liveweb");
		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(signal?.aborted).toBe(false);

		unmount();

		expect(signal?.aborted).toBe(true);
	});

	it("has no Refresh where the host cannot search, and one that does nothing on a board that cannot change", async () => {
		const first = mount("liveweb", webData());
		await screen.findByTestId("canvas-liveweb");
		expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
		first.unmount();

		const refreshBlock = vi.fn(
			async () => ({ ok: true }) as BlockRefreshResult,
		);
		mount("liveweb", webData(), {
			chat: chatContext({ refreshBlock }),
			board: board({ readonly: true }),
		});
		await screen.findByTestId("canvas-liveweb");
		const button = screen.getByRole("button", { name: "Refresh" });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		await fireEvent.click(button);
		expect(refreshBlock).not.toHaveBeenCalled();
	});

	it("does not start a drag of the block when the reader presses it", async () => {
		mount("liveweb", webData(), {
			chat: chatContext({
				refreshBlock: vi.fn(async () => ({ ok: true }) as BlockRefreshResult),
			}),
		});
		await screen.findByTestId("canvas-liveweb");
		expect(screen.getByRole("button", { name: "Refresh" }).className).toContain(
			"nodrag",
		);
	});
});
