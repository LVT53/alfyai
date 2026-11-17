import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BuiltInVoiceInfo,
	createReadAloudVoice,
	deleteReadAloudVoice,
	fetchReadAloudVoices,
	type PersonalVoiceInfo,
	type ReadAloudVoiceSettings,
	saveReadAloudChoice,
} from "$lib/client/api/read-aloud-voices";
import type { VoicePreview } from "$lib/client/read-aloud/voice-preview";
import { STYLES, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import {
	idleVoicePreviewView,
	setReadAloudAvailable,
	setVoicePreviewView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
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
