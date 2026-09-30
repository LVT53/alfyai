import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasChatBlocks } from "$lib/shared/artifacts/chat-blocks";
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
};

const EMPTY: CanvasChatBlocks = { files: [], apps: [], maps: [], charts: [] };

function mount(load: () => Promise<CanvasChatBlocks>, onpick = vi.fn()) {
	// The menu hands the section its glyphs; a test that does not care gives none.
	const view = render(ChatBlocksSection, {
		load,
		onpick,
		iconFor: () => undefined,
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
		for (const name of ["Files", "Apps", "Maps", "Charts"]) {
			expect(within(section).getByRole("group", { name })).toBeInTheDocument();
		}
		expect(within(section).getAllByRole("menuitem")).toHaveLength(4);
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
