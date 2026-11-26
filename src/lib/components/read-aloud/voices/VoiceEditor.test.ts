// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import {
	type BuiltInVoiceInfo,
	createReadAloudVoice,
	deleteReadAloudVoice,
	type PersonalVoiceInfo,
	updateReadAloudVoice,
} from "$lib/client/api/read-aloud-voices";
import type {
	PreviewSound,
	VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { STYLES, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import {
	idleVoicePreviewView,
	setVoicePreviewView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import VoiceEditor from "./VoiceEditor.svelte";

vi.mock("$lib/client/api/read-aloud-voices", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/read-aloud-voices")>();
	return {
		...actual,
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

const TEST_VOICE: PersonalVoiceInfo = {
	id: "v1",
	name: "Test Voice",
	base: "imogen",
	baseName: "Imogen",
	language: "en",
	knobs: { ...ZERO_KNOBS, pace: -1 },
	baseMissing: false,
};

function editor(
	props: Partial<{ voice: PersonalVoiceInfo | null; startFrom: string }> = {},
) {
	const preview = fakePreview();
	const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn() };
	const result = render(VoiceEditor, {
		props: {
			builtIn: BUILT_IN,
			voice: null,
			startFrom: "imogen",
			preview,
			...handlers,
			...props,
		},
	});
	const knob = (name: string) =>
		screen.getByRole("slider", { name }) as HTMLInputElement;
	const nameField = () =>
		screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
	const chip = (name: string) =>
		within(
			screen.getByRole("group", { name: "A style to start with" }),
		).getByRole("button", { name });
	const played = () =>
		vi.mocked(preview.play).mock.calls.map(([sound]) => sound as PreviewSound);
	return { ...result, preview, ...handlers, knob, nameField, chip, played };
}

function reducedMotion(on: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: on && query.includes("reduce"),
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
}

beforeEach(() => {
	uiLanguage.set("en");
	setVoicePreviewView(idleVoicePreviewView);
	vi.mocked(createReadAloudVoice).mockReset();
	vi.mocked(updateReadAloudVoice).mockReset();
	vi.mocked(deleteReadAloudVoice).mockReset();
	vi.stubGlobal("innerWidth", 1200);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	setVoicePreviewView(idleVoicePreviewView);
});

describe("VoiceEditor", () => {
	it('a new voice starts from the given voice with the Original style and the name "My Imogen"', () => {
		const t = editor();
		expect(screen.getByRole("dialog", { name: "New voice" })).toBeTruthy();
		expect(
			screen
				.getByRole("button", { name: /^Imogen/ })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(t.chip("Original").getAttribute("aria-pressed")).toBe("true");
		for (const name of ["Pace", "Pitch", "Depth", "Energy", "Projection"])
			expect(t.knob(name).value).toBe("0");
		expect(t.nameField().value).toBe("My Imogen");
		expect(t.preview.play).not.toHaveBeenCalled();
	});

	it("a style chip moves all five sliders over 260 ms, names the voice and plays it", async () => {
		reducedMotion(false);
		vi.useFakeTimers({
			toFake: [
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"performance",
				"setTimeout",
				"clearTimeout",
			],
		});
		const t = editor();
		await fireEvent.click(t.chip("Bedtime"));
		vi.advanceTimersByTime(120);
		await tick();
		const midway = Number(t.knob("Pace").value);
		expect(midway).toBeLessThan(0);
		expect(midway).toBeGreaterThan(-1);
		// Each step sits on the 0.05 grid.
		expect(Math.abs(midway * 20 - Math.round(midway * 20))).toBeLessThan(1e-9);
		expect(t.preview.play).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		await tick();
		expect(t.knob("Pace").value).toBe("-1");
		expect(t.knob("Depth").value).toBe("1");
		expect(t.knob("Energy").value).toBe("-2.5");
		expect(t.knob("Projection").value).toBe("-0.6");
		expect(t.nameField().value).toBe("Bedtime Imogen");
		expect(t.chip("Bedtime").getAttribute("aria-pressed")).toBe("true");
		expect(t.played()).toEqual([
			{
				owner: "listen",
				request: { base: "imogen", knobs: bedtime },
				sentences: expect.any(Array),
			},
		]);
	});

	it("under reduced motion a style sets the sliders at once", async () => {
		reducedMotion(true);
		const t = editor();
		await fireEvent.click(t.chip("Bedtime"));
		expect(t.knob("Pace").value).toBe("-1");
		expect(t.knob("Energy").value).toBe("-2.5");
		expect(t.preview.play).toHaveBeenCalledTimes(1);
	});

	it("a pointer release plays at once; a held key plays once, 400 ms after the last change", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const t = editor();
		const pace = t.knob("Pace");
		await fireEvent.pointerDown(pace);
		await fireEvent.input(pace, { target: { value: "-1" } });
		await fireEvent.change(pace, { target: { value: "-1" } });
		expect(t.preview.play).toHaveBeenCalledTimes(1);
		expect(t.played()[0]?.request.knobs.pace).toBe(-1);
		const energy = t.knob("Energy");
		for (const value of ["0.05", "0.1", "0.35"]) {
			await fireEvent.keyDown(energy, { key: "ArrowRight" });
			await fireEvent.input(energy, { target: { value } });
			await fireEvent.change(energy, { target: { value } });
			vi.advanceTimersByTime(100);
		}
		expect(t.preview.play).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(300);
		expect(t.preview.play).toHaveBeenCalledTimes(2);
		expect(t.played()[1]?.request.knobs).toMatchObject({
			pace: -1,
			energy: 0.35,
		});
	});

	it("with Play after each change off nothing plays until ▶", async () => {
		reducedMotion(true);
		const t = editor();
		await fireEvent.click(
			screen.getByRole("switch", { name: "Play after each change" }),
		);
		await fireEvent.click(t.chip("Brisk"));
		expect(t.preview.play).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(t.preview.toggle).toHaveBeenCalledTimes(1);
	});

	it("Yours / Original plays the voice and its base", async () => {
		reducedMotion(true);
		const t = editor();
		await fireEvent.click(
			screen.getByRole("switch", { name: "Play after each change" }),
		);
		await fireEvent.click(t.chip("Bedtime"));
		const compare = screen.getByRole("group", { name: "Compare" });
		await fireEvent.click(
			within(compare).getByRole("button", { name: "Original" }),
		);
		await fireEvent.click(
			within(compare).getByRole("button", { name: "Yours" }),
		);
		expect(t.played().map((sound) => sound.request.knobs)).toEqual([
			ZERO_KNOBS,
			bedtime,
		]);
	});

	it("stops suggesting a name once the person types one", async () => {
		reducedMotion(true);
		const t = editor();
		await fireEvent.input(t.nameField(), { target: { value: "Night voice" } });
		await fireEvent.click(t.chip("Bedtime"));
		expect(t.nameField().value).toBe("Night voice");
	});

	it("a cleared name shows the name it will be saved under", async () => {
		reducedMotion(true);
		const t = editor();
		await fireEvent.click(t.chip("Bedtime"));
		await fireEvent.input(t.nameField(), { target: { value: "" } });
		expect(t.nameField().value).toBe("");
		expect(t.nameField().placeholder).toBe("Bedtime Imogen");
	});

	it("saves a new voice, and keeps everything with a note when saving fails", async () => {
		reducedMotion(true);
		const t = editor();
		await fireEvent.click(t.chip("Bedtime"));
		await fireEvent.input(t.nameField(), { target: { value: "   " } });
		vi.mocked(createReadAloudVoice).mockRejectedValueOnce(
			new ApiError("voice_unavailable", { status: 503 }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
		await vi.waitFor(() =>
			expect(screen.getByText("Couldn't save this voice.")).toBeTruthy(),
		);
		expect(vi.mocked(createReadAloudVoice).mock.calls[0]?.[0]).toEqual({
			name: "Bedtime Imogen",
			base: "imogen",
			knobs: bedtime,
		});
		expect(t.knob("Pace").value).toBe("-1");
		expect(t.onSaved).not.toHaveBeenCalled();
		const saved = {
			...TEST_VOICE,
			id: "v9",
			name: "Bedtime Imogen",
			knobs: bedtime,
		};
		vi.mocked(createReadAloudVoice).mockResolvedValueOnce(saved);
		const note = screen
			.getByText("Couldn't save this voice.")
			.closest(".read-aloud-note") as HTMLElement;
		await fireEvent.click(
			within(note).getByRole("button", { name: "Try again" }),
		);
		await vi.waitFor(() => expect(t.onSaved).toHaveBeenCalledWith(saved, null));
	});

	it("edits: Save changes updates, Save as new creates, Delete asks first", async () => {
		reducedMotion(true);
		const t = editor({ voice: TEST_VOICE });
		expect(screen.getByRole("dialog", { name: "Edit voice" })).toBeTruthy();
		expect(t.nameField().value).toBe("Test Voice");
		expect(t.knob("Pace").value).toBe("-1");
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		const updated = { ...TEST_VOICE, name: "Test Voice 2" };
		vi.mocked(updateReadAloudVoice).mockResolvedValueOnce(updated);
		await fireEvent.input(t.nameField(), { target: { value: "Test Voice 2" } });
		await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() =>
			expect(t.onSaved).toHaveBeenCalledWith(updated, "v1"),
		);
		expect(vi.mocked(updateReadAloudVoice).mock.calls[0]).toEqual([
			"v1",
			{ name: "Test Voice 2", base: "imogen", knobs: TEST_VOICE.knobs },
		]);
		const copy = { ...TEST_VOICE, id: "v2", name: "Test Voice 2" };
		vi.mocked(createReadAloudVoice).mockResolvedValueOnce(copy);
		await fireEvent.click(screen.getByRole("button", { name: "Save as new" }));
		await vi.waitFor(() => expect(t.onSaved).toHaveBeenCalledWith(copy, null));
		vi.mocked(deleteReadAloudVoice).mockResolvedValueOnce({
			en: "imogen",
			hu: "berta",
		});
		await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		const confirm = screen.getByRole("dialog", { name: "Delete this voice?" });
		// The voice as it is saved: the one the list shows.
		expect(confirm.textContent).toContain(
			"Delete “Test Voice”? Readings that use it go back to Imogen.",
		);
		expect(deleteReadAloudVoice).not.toHaveBeenCalled();
		await fireEvent.click(
			within(confirm).getByRole("button", { name: "Delete" }),
		);
		await vi.waitFor(() =>
			expect(t.onDeleted).toHaveBeenCalledWith("v1", {
				en: "imogen",
				hu: "berta",
			}),
		);
	});

	it("a voice whose base is gone opens on its language's default voice, with its knobs", () => {
		const t = editor({
			voice: {
				...TEST_VOICE,
				base: "olga",
				baseName: "Olga",
				baseMissing: true,
			},
		});
		expect(
			screen
				.getByRole("button", { name: /^Imogen/ })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(t.knob("Pace").value).toBe("-1");
	});

	it("brings a failed save's note into view, above the footer", async () => {
		// The review's M3: Save is in the sticky footer, reachable from anywhere in the
		// editor, so its note must not stay below the fold.
		const scrolled = vi.fn();
		Object.defineProperty(Element.prototype, "scrollIntoView", {
			configurable: true,
			value: scrolled,
		});
		try {
			editor();
			vi.mocked(createReadAloudVoice).mockRejectedValueOnce(
				new ApiError("too_many", { status: 409 }),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
			const note = await screen.findByText(
				"You have 50 voices, the most you can keep. Delete one to make another.",
			);
			expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
			expect(scrolled.mock.contexts[0]).toBe(
				note.closest(".voice-editor-note"),
			);
		} finally {
			Reflect.deleteProperty(Element.prototype, "scrollIntoView");
		}
	});

	it("says when the person has 50 voices", async () => {
		const t = editor();
		vi.mocked(createReadAloudVoice).mockRejectedValueOnce(
			new ApiError("too_many", { status: 409 }),
		);
		await fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
		await vi.waitFor(() =>
			expect(
				screen.getByText(
					"You have 50 voices, the most you can keep. Delete one to make another.",
				),
			).toBeTruthy(),
		);
		expect(t.onSaved).not.toHaveBeenCalled();
	});

	it("on a phone it is a full sheet without Cancel", () => {
		vi.stubGlobal("innerWidth", 390);
		editor();
		const dialog = screen.getByRole("dialog", { name: "New voice" });
		expect(dialog.className).toContain("dialog-sheet--full");
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		expect(screen.getByRole("button", { name: "Save voice" })).toBeTruthy();
	});

	it("closing stops the sound", async () => {
		const t = editor();
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(t.preview.stop).toHaveBeenCalledTimes(1);
		expect(t.onClose).toHaveBeenCalledTimes(1);
		t.unmount();
		const again = editor();
		// The ✕ in the editor's own head.
		await fireEvent.click(
			within(screen.getByRole("dialog", { name: "New voice" })).getByRole(
				"button",
				{ name: "Close" },
			),
		);
		expect(again.preview.stop).toHaveBeenCalledTimes(1);
		expect(again.onClose).toHaveBeenCalledTimes(1);
	});
});
