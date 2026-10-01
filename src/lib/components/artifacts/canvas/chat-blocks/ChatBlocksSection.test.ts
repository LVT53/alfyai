import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchCanvasWebResult } from "$lib/client/api/artifacts";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import {
	type CanvasChatBlocks,
	emptyChatBlocks,
} from "$lib/shared/artifacts/chat-blocks";
import { uiLanguage } from "$lib/stores/settings";
import ChatBlocksSection from "./ChatBlocksSection.svelte";

// The Insert menu's "From this chat", on its own: what it says while the chat is
// being read, when there is nothing, when the read fails, and what each row
// hands over when it is picked.

const LISTING: CanvasChatBlocks = {
	files: [
		{
			key: "file:f1",
			at: 5_000,
			origin: "produced",
			version: null,
			data: {
				kind: "file",
				fileId: "f1",
				name: "Vienna trip.pdf",
				mime: "application/pdf",
				bytes: 2048,
				label: "PDF",
			},
		},
	],
	apps: [
		{
			key: "app:app-1",
			at: 3_000,
			versionNumber: 2,
			data: { kind: "app", artifactId: "app-1", title: "Tip calculator" },
		},
	],
	maps: [
		{
			key: "map:m1:c1",
			at: 2_000,
			action: "route",
			map: {
				bounds: { minLat: 51.7, minLng: -8.5, maxLat: 51.9, maxLng: -8.4 },
				distanceM: 27_000,
				durationS: 2040,
				originLabel: "Cork",
				destinationLabel: "Kinsale",
				attribution: "© OpenStreetMap contributors",
			},
		},
	],
	charts: [
		{
			key: "chart:m:0",
			at: 1_000,
			title: "Sales",
			chartType: "bar",
			data: { kind: "chart", code: '{"type":"bar"}' },
		},
	],
	diagrams: [
		{
			key: "mermaid:m:0",
			at: 900,
			title: null,
			diagramType: "flowchart",
			data: { kind: "mermaid", code: "flowchart TD\n  A --> B" },
		},
	],
	photos: [],
	searches: [],
};

const EMPTY: CanvasChatBlocks = emptyChatBlocks();

function mount(
	load: () => Promise<CanvasChatBlocks>,
	onpick = vi.fn(),
	search?: (
		query: string,
		signal?: AbortSignal,
	) => Promise<SearchCanvasWebResult>,
) {
	// The menu hands the section its glyphs; a test that does not care gives none.
	const view = render(ChatBlocksSection, {
		load,
		onpick,
		iconFor: () => undefined,
		...(search ? { search } : {}),
	});
	return { ...view, onpick };
}

beforeEach(() => {
	uiLanguage.set("en");
});

describe("From this chat", () => {
	it("says it is looking through the chat until the answer arrives, and reads the chat once", async () => {
		let answer: (value: CanvasChatBlocks) => void = () => {};
		const load = vi.fn(
			() => new Promise<CanvasChatBlocks>((r) => (answer = r)),
		);
		mount(load);

		expect(screen.getByText("Looking through this chat…")).toBeInTheDocument();
		expect(screen.queryAllByRole("menuitem")).toHaveLength(0);

		answer(LISTING);
		expect(await screen.findByText("Vienna trip.pdf")).toBeInTheDocument();
		expect(screen.queryByText("Looking through this chat…")).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("says quietly that there is nothing yet, and offers nothing to pick", async () => {
		mount(async () => EMPTY);
		expect(
			await screen.findByText("Nothing from this chat to insert yet."),
		).toBeInTheDocument();
		expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("says it could not look when the read fails, and tries again on request", async () => {
		const load = vi
			.fn<() => Promise<CanvasChatBlocks>>()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValue(LISTING);
		mount(load);

		expect(
			await screen.findByText("Couldn't look through this chat."),
		).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(await screen.findByText("Vienna trip.pdf")).toBeInTheDocument();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("is a labelled group, with a labelled group per kind that has something, each row a menu item", async () => {
		mount(async () => LISTING);
		await screen.findByText("Vienna trip.pdf");

		const section = screen.getByRole("group", { name: "From this chat" });
		for (const name of ["Files", "Apps", "Maps", "Charts", "Diagrams"]) {
			expect(within(section).getByRole("group", { name })).toBeInTheDocument();
		}
		expect(within(section).getAllByRole("menuitem")).toHaveLength(5);
	});

	it("leaves a kind out entirely when the chat has none of it", async () => {
		mount(async () => ({ ...EMPTY, apps: LISTING.apps }));
		await screen.findByText("Tip calculator");
		expect(screen.queryByRole("group", { name: "Files" })).toBeNull();
		expect(screen.queryByRole("group", { name: "Maps" })).toBeNull();
		expect(screen.getByRole("group", { name: "Apps" })).toBeInTheDocument();
	});

	it("shows each row's name and its quiet second part", async () => {
		mount(async () => LISTING);
		await screen.findByText("Vienna trip.pdf");
		const rows = screen.getAllByRole("menuitem");
		expect(rows[0]).toHaveTextContent("Vienna trip.pdf");
		expect(rows[0]).toHaveTextContent("PDF · 2.0 KB");
		expect(rows[1]).toHaveTextContent("Tip calculator");
		expect(rows[1]).toHaveTextContent("v2");
		expect(rows[2]).toHaveTextContent("Cork → Kinsale");
		expect(rows[2]).toHaveTextContent("27.0 km · 34 min");
		expect(rows[3]).toHaveTextContent("Sales");
		expect(rows[4]).toHaveTextContent("Flowchart");
	});

	it("keeps every row out of the tab order: the menu's own roving position is the one tab stop", async () => {
		mount(async () => LISTING);
		await screen.findByText("Vienna trip.pdf");
		for (const row of screen.getAllByRole("menuitem")) {
			expect(row.getAttribute("tabindex")).toBe("-1");
		}
	});

	it("hands over the kind and the data of the row that was picked", async () => {
		const { onpick } = mount(async () => LISTING);
		await screen.findByText("Vienna trip.pdf");

		await fireEvent.click(
			screen.getByRole("menuitem", { name: /Vienna trip\.pdf/ }),
		);
		expect(onpick).toHaveBeenLastCalledWith("file", LISTING.files[0].data);

		await fireEvent.click(
			screen.getByRole("menuitem", { name: /Tip calculator/ }),
		);
		expect(onpick).toHaveBeenLastCalledWith("app", LISTING.apps[0].data);

		await fireEvent.click(screen.getByRole("menuitem", { name: /Sales/ }));
		expect(onpick).toHaveBeenLastCalledWith("chart", LISTING.charts[0].data);
	});

	it("lists a diagram under its own heading, named by its kind, and hands over the diagram block", async () => {
		const { onpick } = mount(async () => LISTING);
		await screen.findByText("Vienna trip.pdf");
		expect(screen.getByRole("group", { name: "Diagrams" })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("menuitem", { name: /Flowchart/ }));
		expect(onpick).toHaveBeenLastCalledWith(
			"mermaid",
			LISTING.diagrams[0].data,
		);
	});

	it("hands over the map block built the way the chat reads its route", async () => {
		const { onpick } = mount(async () => LISTING);
		await screen.findByText("Cork → Kinsale");
		await fireEvent.click(
			screen.getByRole("menuitem", { name: /Cork → Kinsale/ }),
		);
		expect(onpick).toHaveBeenCalledWith(
			"map",
			expect.objectContaining({
				kind: "map",
				route: "Cork → Kinsale",
				meta: "27.0 km · 34 min",
				map: LISTING.maps[0].map,
			}),
		);
	});

	it("says all of it in Hungarian in Hungarian", async () => {
		uiLanguage.set("hu");
		mount(async () => LISTING);
		await screen.findByText("Vienna trip.pdf");
		const section = screen.getByRole("group", {
			name: "Ebből a beszélgetésből",
		});
		for (const name of ["Fájlok", "Alkalmazások", "Térképek", "Diagramok"]) {
			expect(within(section).getByRole("group", { name })).toBeInTheDocument();
		}
	});

	it("says the empty and failed states in Hungarian too", async () => {
		uiLanguage.set("hu");
		const view = mount(async () => EMPTY);
		expect(
			await screen.findByText("Még nincs mit beszúrni ebből a beszélgetésből."),
		).toBeInTheDocument();
		view.unmount();
		mount(async () => {
			throw new Error("no");
		});
		expect(
			await screen.findByText("Nem sikerült átnézni a beszélgetést."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Újra" })).toBeInTheDocument();
	});
});

// ── Search the web… ──────────────────────────────────────────────────────────

describe("Search the web…", () => {
	const WEB: Extract<CanvasBlockData, { kind: "liveweb" }> = {
		kind: "liveweb",
		query: "cork weather",
		sources: [
			{
				id: "s1",
				title: "Result",
				url: "https://example.com/r",
				provider: "parallel",
				authorityClass: "primary",
				authorityScore: 0.9,
				publishedAt: null,
				updatedAt: null,
			},
		],
		fetchedAt: 1_000,
	};

	const okSearch = () =>
		vi.fn(async (_query: string, _signal?: AbortSignal) => ({
			ok: true as const,
			data: WEB,
		})) as unknown as (
			query: string,
			signal?: AbortSignal,
		) => Promise<SearchCanvasWebResult>;

	async function openForm() {
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Search the web…" }),
		);
		return screen.getByRole("textbox", { name: "Search the web" });
	}

	it("offers a row for it at the top of the section, even from a chat with nothing to insert, and only where a search can be made", async () => {
		mount(async () => EMPTY, vi.fn(), okSearch());
		const row = await screen.findByRole("menuitem", {
			name: "Search the web…",
		});
		expect(row.getAttribute("tabindex")).toBe("-1");
		expect(
			screen.getByRole("group", { name: "From this chat" }),
		).toContainElement(row);

		// A board with no chat to search for has no such row.
		document.body.innerHTML = "";
		mount(async () => EMPTY);
		await screen.findByText("Nothing from this chat to insert yet.");
		expect(
			screen.queryByRole("menuitem", { name: "Search the web…" }),
		).toBeNull();
	});

	it("keeps the row ahead of the chat's own rows, so it is where it is whatever the chat holds", async () => {
		mount(async () => LISTING, vi.fn(), okSearch());
		await screen.findByText("Vienna trip.pdf");
		const rows = screen.getAllByRole("menuitem");
		expect(rows[0]).toHaveAccessibleName("Search the web…");
		expect(rows).toHaveLength(6);
	});

	it("opens a field for the query, named for a screen reader, with a limit of what a block keeps, and puts the cursor in it", async () => {
		mount(async () => EMPTY, vi.fn(), okSearch());

		const field = await openForm();

		expect(field).toHaveFocus();
		expect(field.getAttribute("maxlength")).toBe("500");
		expect(field.getAttribute("placeholder")).toBe(
			"What should the board look up?",
		);
		expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
	});

	it("searches for what was typed, trimmed, and hands over the live-web block it made", async () => {
		const search = okSearch();
		const { onpick } = mount(async () => EMPTY, vi.fn(), search);
		const field = await openForm();

		await fireEvent.input(field, { target: { value: "  cork weather  " } });
		await fireEvent.click(screen.getByRole("button", { name: "Search" }));

		await waitFor(() => expect(onpick).toHaveBeenCalledWith("liveweb", WEB));
		expect(search).toHaveBeenCalledTimes(1);
		const [query, signal] = (
			search as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0];
		expect(query).toBe("cork weather");
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("searches on Enter too, and not at all for a field with nothing in it", async () => {
		const search = okSearch();
		mount(async () => EMPTY, vi.fn(), search);
		const field = await openForm();

		await fireEvent.submit(field.closest("form") as HTMLFormElement);
		await fireEvent.input(field, { target: { value: "   " } });
		await fireEvent.submit(field.closest("form") as HTMLFormElement);
		expect(search).not.toHaveBeenCalled();
		expect(
			screen
				.getByRole("button", { name: "Search" })
				.getAttribute("aria-disabled"),
		).toBe("true");

		await fireEvent.input(field, { target: { value: "weather" } });
		expect(
			screen
				.getByRole("button", { name: "Search" })
				.getAttribute("aria-disabled"),
		).toBe("false");
		await fireEvent.submit(field.closest("form") as HTMLFormElement);
		expect(search).toHaveBeenCalledTimes(1);
	});

	it("says it is searching, ignores a second press, and does not hand over anything until the answer comes", async () => {
		let answer: (value: SearchCanvasWebResult) => void = () => {};
		const search = vi.fn(
			(_query: string, _signal?: AbortSignal) =>
				new Promise<SearchCanvasWebResult>((resolve) => {
					answer = resolve;
				}),
		);
		const { onpick } = mount(async () => EMPTY, vi.fn(), search);
		const field = await openForm();
		await fireEvent.input(field, { target: { value: "weather" } });

		await fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(screen.getByRole("status")).toHaveTextContent("Searching the web…");
		await fireEvent.submit(field.closest("form") as HTMLFormElement);
		expect(search).toHaveBeenCalledTimes(1);
		expect(onpick).not.toHaveBeenCalled();

		answer({ ok: true, data: WEB });
		await waitFor(() => expect(onpick).toHaveBeenCalledTimes(1));
	});

	it("says what went wrong, keeps what was typed, and lets the reader try again", async () => {
		const search = vi
			.fn<
				(query: string, signal?: AbortSignal) => Promise<SearchCanvasWebResult>
			>()
			.mockResolvedValueOnce({ ok: false, reason: "refresh_failed" })
			.mockResolvedValueOnce({ ok: false, reason: "no_results" })
			.mockResolvedValueOnce({ ok: false, reason: "rate_limited" })
			.mockResolvedValueOnce({ ok: false, reason: "not_found" })
			.mockResolvedValue({ ok: true, data: WEB });
		const { onpick } = mount(async () => EMPTY, vi.fn(), search);
		const field = await openForm();
		await fireEvent.input(field, { target: { value: "weather" } });
		const press = () =>
			fireEvent.click(screen.getByRole("button", { name: "Search" }));

		await press();
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"The search did not work. Try again.",
			),
		);
		expect(field).toHaveValue("weather");
		await press();
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"Nothing came back for that search.",
			),
		);
		await press();
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"That is a lot of searches at once. Wait a moment.",
			),
		);
		await press();
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"The search did not work. Try again.",
			),
		);
		expect(onpick).not.toHaveBeenCalled();

		await press();
		await waitFor(() => expect(onpick).toHaveBeenCalledWith("liveweb", WEB));
	});

	it("stops the search and drops its answer when the menu goes away", async () => {
		let signal: AbortSignal | undefined;
		let answer: (value: SearchCanvasWebResult) => void = () => {};
		const search = vi.fn(
			(_query: string, given?: AbortSignal) =>
				new Promise<SearchCanvasWebResult>((resolve) => {
					signal = given;
					answer = resolve;
				}),
		);
		const { onpick, unmount } = mount(async () => EMPTY, vi.fn(), search);
		const field = await openForm();
		await fireEvent.input(field, { target: { value: "weather" } });
		await fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(signal?.aborted).toBe(false);

		unmount();

		expect(signal?.aborted).toBe(true);
		answer({ ok: true, data: WEB });
		// Long enough for the answer to be handled, if anything were going to handle it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onpick).not.toHaveBeenCalled();
	});

	it("says all of it in Hungarian", async () => {
		uiLanguage.set("hu");
		const search = vi.fn(
			async () =>
				({ ok: false, reason: "refresh_failed" }) as SearchCanvasWebResult,
		);
		mount(async () => EMPTY, vi.fn(), search);
		await fireEvent.click(
			await screen.findByRole("menuitem", { name: "Keresés a weben…" }),
		);
		const field = screen.getByRole("textbox", { name: "Keresés a weben" });
		expect(field.getAttribute("placeholder")).toBe("Mit keressen a tábla?");
		await fireEvent.input(field, { target: { value: "időjárás" } });
		await fireEvent.click(screen.getByRole("button", { name: "Keresés" }));
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"A keresés nem sikerült. Próbáld újra.",
			),
		);
	});
});
