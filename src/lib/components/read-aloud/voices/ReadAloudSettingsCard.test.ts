import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import {
	type BuiltInVoiceInfo,
	createReadAloudVoice,
	deleteReadAloudVoice,
	fetchReadAloudVoices,
	type PersonalVoiceInfo,
	type ReadAloudVoiceSettings,
	saveReadAloudChoice,
} from "$lib/client/api/read-aloud-voices";
import {
	disposeVoicePreview,
	type VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { STYLES, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import {
	idleVoicePreviewView,
	setReadAloudAvailable,
	setVoicePreviewView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import { requestSpotlight, spotlightRequest } from "$lib/stores/spotlight";
import ReadAloudSettingsCard from "./ReadAloudSettingsCard.svelte";

vi.mock("$lib/client/api/read-aloud-voices", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/read-aloud-voices")>();
	return {
		...actual,
		fetchReadAloudVoices: vi.fn(),
		saveReadAloudChoice: vi.fn(),
		createReadAloudVoice: vi.fn(),
		updateReadAloudVoice: vi.fn(),
		deleteReadAloudVoice: vi.fn(),
	};
});

// The app's own preview, for a card mounted as the Settings page mounts it (no prop).
const shared = vi.hoisted(() => ({
	unlock: vi.fn(),
	toggle: vi.fn(),
	play: vi.fn(),
	retry: vi.fn(),
	seek: vi.fn(),
	beginDrag: vi.fn(),
	dragTo: vi.fn(),
	endDrag: vi.fn(),
	sentencePreview: vi.fn(() => ""),
	stop: vi.fn(),
	dispose: vi.fn(),
}));

vi.mock("$lib/client/read-aloud/voice-preview", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/client/read-aloud/voice-preview")
	>()),
	getVoicePreview: () => shared,
	disposeVoicePreview: vi.fn(),
}));

function fakePreview(): VoicePreview {
	return {
		unlock: vi.fn(),
		toggle: vi.fn(),
		play: vi.fn(),
		retry: vi.fn(),
		seek: vi.fn(),
		beginDrag: vi.fn(),
		dragTo: vi.fn(),
		endDrag: vi.fn(),
		sentencePreview: vi.fn(() => ""),
		stop: vi.fn(),
		dispose: vi.fn(),
	};
}

const BUILT_IN: BuiltInVoiceInfo[] = [
	{ key: "imogen", name: "Imogen", language: "en" },
	{ key: "rupert", name: "Rupert", language: "en" },
	{ key: "savannah", name: "Savannah", language: "en" },
	{ key: "wyatt", name: "Wyatt", language: "en" },
	{ key: "berta", name: "Berta", language: "hu" },
	{ key: "imre", name: "Imre", language: "hu" },
];

const bedtime =
	STYLES.find((style) => style.key === "bedtime")?.knobs ?? ZERO_KNOBS;

const BEDTIME_SAVANNAH: PersonalVoiceInfo = {
	id: "v1",
	name: "Bedtime Savannah",
	base: "savannah",
	baseName: "Savannah",
	language: "en",
	knobs: bedtime,
	baseMissing: false,
};

const settings = (
	extra: Partial<ReadAloudVoiceSettings> = {},
): ReadAloudVoiceSettings => ({
	builtIn: BUILT_IN,
	voices: [],
	choice: { en: "imogen", hu: "berta" },
	defaultSpeed: 1,
	...extra,
});

async function card(loaded: ReadAloudVoiceSettings = settings()) {
	vi.mocked(fetchReadAloudVoices).mockResolvedValue(loaded);
	const preview = fakePreview();
	const result = render(ReadAloudSettingsCard, { props: { preview } });
	await vi.waitFor(() =>
		expect(
			screen.getByRole("combobox", { name: "English voice" }),
		).toBeTruthy(),
	);
	await vi.waitFor(() =>
		expect(
			(
				screen.getByRole("combobox", {
					name: "English voice",
				}) as HTMLSelectElement
			).disabled,
		).toBe(false),
	);
	const select = (name: string) =>
		screen.getByRole("combobox", { name }) as HTMLSelectElement;
	const groups = (name: string) =>
		[...select(name).querySelectorAll("optgroup")].map((group) => ({
			label: group.label,
			options: [...group.querySelectorAll("option")].map(
				(option) => option.textContent,
			),
		}));
	return { ...result, preview, select, groups };
}

beforeEach(() => {
	uiLanguage.set("en");
	setReadAloudAvailable(true);
	setVoicePreviewView(idleVoicePreviewView);
	vi.stubGlobal("innerWidth", 1200);
	// Reduced motion: the editor's dialog leaves without waiting on its transition.
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("reduce"),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
	for (const call of [
		fetchReadAloudVoices,
		saveReadAloudChoice,
		createReadAloudVoice,
		deleteReadAloudVoice,
	])
		vi.mocked(call).mockReset();
});

afterEach(() => {
	setReadAloudAvailable(false);
	vi.unstubAllGlobals();
});

describe("ReadAloudSettingsCard", () => {
	it("leaving Settings frees the app's preview, even when only a saved voice's ▶ used it", async () => {
		// The review's I1: a ▶ goes through VoicePlayButton, not the card, so the card must
		// free the preview whatever made it.
		vi.mocked(fetchReadAloudVoices).mockResolvedValue(
			settings({ voices: [BEDTIME_SAVANNAH] }),
		);
		vi.mocked(disposeVoicePreview).mockClear();
		const { unmount } = render(ReadAloudSettingsCard, { props: {} });
		await fireEvent.click(
			await screen.findByRole("button", { name: "Play Bedtime Savannah" }),
		);
		expect(shared.toggle).toHaveBeenCalledTimes(1);
		unmount();
		expect(disposeVoicePreview).toHaveBeenCalledTimes(1);
	});

	it("is not there while read aloud is off", () => {
		setReadAloudAvailable(false);
		const { container } = render(ReadAloudSettingsCard, {
			props: { preview: fakePreview() },
		});
		expect(container.querySelector("#settings-section-read-aloud")).toBeNull();
		expect(fetchReadAloudVoices).not.toHaveBeenCalled();
	});

	it("says when the voices could not load, and Try again loads them", async () => {
		vi.mocked(fetchReadAloudVoices).mockRejectedValueOnce(new Error("offline"));
		vi.mocked(fetchReadAloudVoices).mockResolvedValueOnce(settings());
		render(ReadAloudSettingsCard, { props: { preview: fakePreview() } });
		const failed = await screen.findByText("Couldn't load your voices.");
		const note = failed.closest(".read-aloud-note") as HTMLElement;
		await fireEvent.click(
			within(note).getByRole("button", { name: "Try again" }),
		);
		await vi.waitFor(() =>
			expect(screen.queryByText("Couldn't load your voices.")).toBeNull(),
		);
		expect(fetchReadAloudVoices).toHaveBeenCalledTimes(2);
	});

	it("lists the built-in voices per language, then the person's own", async () => {
		const t = await card(settings({ voices: [BEDTIME_SAVANNAH] }));
		expect(screen.getByRole("heading", { name: "Read aloud" })).toBeTruthy();
		expect(t.groups("English voice")).toEqual([
			{
				label: "Built in",
				options: [
					"Imogen · British woman",
					"Rupert · British man",
					"Savannah · American woman",
					"Wyatt · American man",
				],
			},
			{ label: "Yours", options: ["Bedtime Savannah"] },
		]);
		expect(t.groups("Hungarian voice")).toEqual([
			{
				label: "Built in",
				options: ["Berta · Hungarian woman", "Imre · Hungarian man"],
			},
		]);
		expect(t.select("English voice").value).toBe("imogen");
		expect(t.select("Hungarian voice").value).toBe("berta");
		expect(
			[...t.select("Default speed").options].map(
				(option) => option.textContent,
			),
		).toEqual(["0.75×", "1×", "1.25×", "1.5×", "1.75×", "2×"]);
		expect(screen.getByText("Every reading starts at this speed")).toBeTruthy();
	});

	it("saves a voice choice and the Default speed on change, and puts a select back when saving fails", async () => {
		const t = await card();
		vi.mocked(saveReadAloudChoice).mockResolvedValueOnce({
			choice: { en: "rupert", hu: "berta" },
			defaultSpeed: 1,
		});
		await fireEvent.change(t.select("English voice"), {
			target: { value: "rupert" },
		});
		expect(saveReadAloudChoice).toHaveBeenLastCalledWith({ en: "rupert" });
		vi.mocked(saveReadAloudChoice).mockResolvedValueOnce({
			choice: { en: "rupert", hu: "berta" },
			defaultSpeed: 1.5,
		});
		await fireEvent.change(t.select("Default speed"), {
			target: { value: "1.5" },
		});
		expect(saveReadAloudChoice).toHaveBeenLastCalledWith({ defaultSpeed: 1.5 });
		await vi.waitFor(() => expect(t.select("Default speed").value).toBe("1.5"));
		vi.mocked(saveReadAloudChoice).mockRejectedValueOnce(new Error("offline"));
		await fireEvent.change(t.select("Hungarian voice"), {
			target: { value: "imre" },
		});
		const failed = await screen.findByText("Couldn't save this setting.");
		expect(t.select("Hungarian voice").value).toBe("berta");
		expect(t.select("English voice").value).toBe("rupert");
		vi.mocked(saveReadAloudChoice).mockResolvedValueOnce({
			choice: { en: "rupert", hu: "imre" },
			defaultSpeed: 1.5,
		});
		const note = failed.closest(".read-aloud-note") as HTMLElement;
		await fireEvent.click(
			within(note).getByRole("button", { name: "Try again" }),
		);
		expect(saveReadAloudChoice).toHaveBeenLastCalledWith({ hu: "imre" });
		await vi.waitFor(() =>
			expect(t.select("Hungarian voice").value).toBe("imre"),
		);
		expect(screen.queryByText("Couldn't save this setting.")).toBeNull();
	});

	it("shows each voice with its summary, and the empty text when there is none", async () => {
		const empty = await card();
		expect(
			screen.getByText(
				"Make a voice of your own: start from one of the built-in voices and change how it sounds. Only you will see it.",
			),
		).toBeTruthy();
		empty.unmount();
		await card(
			settings({
				voices: [
					BEDTIME_SAVANNAH,
					{
						...BEDTIME_SAVANNAH,
						id: "v2",
						name: "Plain Rupert",
						base: "rupert",
						baseName: "Rupert",
						knobs: { ...ZERO_KNOBS },
					},
				],
			}),
		);
		// The names are in the list and in the English picker's Yours group.
		const list = screen.getByRole("list");
		expect(within(list).getByText("Bedtime Savannah")).toBeTruthy();
		expect(
			within(list).getByText(
				"from Savannah · slower, a little fuller, very calm, softer",
			),
		).toBeTruthy();
		expect(within(list).getByText("from Rupert · unchanged")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Play Bedtime Savannah" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Edit Bedtime Savannah" }),
		).toBeTruthy();
	});

	it("opening the editor unlocks the preview first", async () => {
		const t = await card(
			settings({
				voices: [BEDTIME_SAVANNAH],
				choice: { en: "v1", hu: "berta" },
			}),
		);
		await fireEvent.click(screen.getByRole("button", { name: "New voice" }));
		expect(t.preview.unlock).toHaveBeenCalledTimes(1);
		const editor = screen.getByRole("dialog", { name: "New voice" });
		// A new voice starts from the base of the person's voice for the UI language.
		expect(
			within(editor)
				.getByRole("button", { name: /^Savannah/ })
				.getAttribute("aria-pressed"),
		).toBe("true");
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Close" })[0] as HTMLElement,
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Edit Bedtime Savannah" }),
		);
		expect(t.preview.unlock).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("dialog", { name: "Edit voice" })).toBeTruthy();
	});

	it("opening the editor stops a sample playing from the card: one sound at a time", async () => {
		const t = await card(
			settings({
				voices: [BEDTIME_SAVANNAH],
				choice: { en: "v1", hu: "berta" },
			}),
		);
		await fireEvent.click(screen.getByRole("button", { name: "New voice" }));
		expect(t.preview.stop).toHaveBeenCalledTimes(1);
		await fireEvent.click(
			screen.getAllByRole("button", { name: "Close" })[0] as HTMLElement,
		);
		const stops = vi.mocked(t.preview.stop).mock.calls.length;
		await fireEvent.click(
			screen.getByRole("button", { name: "Edit Bedtime Savannah" }),
		);
		expect(vi.mocked(t.preview.stop).mock.calls.length).toBe(stops + 1);
	});

	it("is drawn from the page's voices before the app says read aloud is on (the server's page)", () => {
		setReadAloudAvailable(false);
		const { container } = render(ReadAloudSettingsCard, {
			props: { preview: fakePreview(), initial: settings() },
		});
		expect(
			container.querySelector("#settings-section-read-aloud"),
		).toBeTruthy();
		expect(fetchReadAloudVoices).not.toHaveBeenCalled();
	});

	it("draws the voices the page brought in its first paint, with no load to wait for", () => {
		const preview = fakePreview();
		render(ReadAloudSettingsCard, {
			props: {
				preview,
				initial: settings({
					voices: [BEDTIME_SAVANNAH],
					choice: { en: "v1", hu: "berta" },
				}),
			},
		});
		expect(fetchReadAloudVoices).not.toHaveBeenCalled();
		expect(
			within(screen.getByRole("list")).getByText("Bedtime Savannah"),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("combobox", {
					name: "English voice",
				}) as HTMLSelectElement
			).value,
		).toBe("v1");
	});

	it("a saved voice joins the list and its picker group", async () => {
		const t = await card();
		await fireEvent.click(screen.getByRole("button", { name: "New voice" }));
		vi.mocked(createReadAloudVoice).mockResolvedValueOnce(BEDTIME_SAVANNAH);
		await fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
		await vi.waitFor(() =>
			expect(screen.queryByRole("dialog", { name: "New voice" })).toBeNull(),
		);
		expect(
			within(screen.getByRole("list")).getByText("Bedtime Savannah"),
		).toBeTruthy();
		expect(t.groups("English voice").at(-1)).toEqual({
			label: "Yours",
			options: ["Bedtime Savannah"],
		});
	});

	it("deleting the English voice shows its base in the picker", async () => {
		const t = await card(
			settings({
				voices: [BEDTIME_SAVANNAH],
				choice: { en: "v1", hu: "berta" },
			}),
		);
		expect(t.select("English voice").value).toBe("v1");
		await fireEvent.click(
			screen.getByRole("button", { name: "Edit Bedtime Savannah" }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		vi.mocked(deleteReadAloudVoice).mockResolvedValueOnce({
			en: "savannah",
			hu: "berta",
		});
		const confirm = screen.getByRole("dialog", { name: "Delete this voice?" });
		await fireEvent.click(
			within(confirm).getByRole("button", { name: "Delete" }),
		);
		await vi.waitFor(() =>
			expect(t.select("English voice").value).toBe("savannah"),
		);
		expect(screen.queryByText("Bedtime Savannah")).toBeNull();
		expect(t.groups("English voice").map((group) => group.label)).toEqual([
			"Built in",
		]);
	});

	it("warns under a voice whose base is gone", async () => {
		const { container } = await card(
			settings({
				voices: [
					{
						...BEDTIME_SAVANNAH,
						base: "olga",
						baseName: "Olga",
						baseMissing: true,
					},
				],
			}),
		);
		expect(
			screen.getByText(
				"Olga isn't available any more, so this voice reads as your English voice for now.",
			),
		).toBeTruthy();
		expect(container.querySelector(".lucide-triangle-alert")).toBeTruthy();
	});
});

// The guide's Show me asks for the voice pickers by name ("settings.readAloud")
// and the control that carries the name rings itself (`spotlightTarget`). The
// card is drawn only while read aloud is on, so the guide's own end-to-end row
// switches it on for itself.
describe("ReadAloudSettingsCard and the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	beforeEach(() => {
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
	});

	it("marks its voice pickers for Show me", async () => {
		requestSpotlight("settings.readAloud");
		const { select } = await card();
		vi.advanceTimersToNextFrame();

		const group = screen.getByTestId("read-aloud-voice-rows");
		// The two pickers, and not the Default speed under them, are what rings; the
		// request was taken, and the group's own class is still on it.
		expect(group).toHaveClass("settings-row-group", "spotlight-ring");
		expect(get(spotlightRequest)).toBeNull();
		expect(within(group).getByRole("combobox", { name: "English voice" })).toBe(
			select("English voice"),
		);
		expect(
			within(group).getByRole("combobox", { name: "Hungarian voice" }),
		).toBe(select("Hungarian voice"));
		expect(
			within(group).queryByRole("combobox", { name: "Default speed" }),
		).toBeNull();
		expect(
			screen.getByRole("combobox", { name: "Default speed" }),
		).toBeTruthy();
	});

	it("rings nothing for another control's request", async () => {
		requestSpotlight("settings.style");
		await card();
		vi.advanceTimersToNextFrame();

		expect(screen.getByTestId("read-aloud-voice-rows")).not.toHaveClass(
			"spotlight-ring",
		);
		expect(get(spotlightRequest)).not.toBeNull();
	});
});
