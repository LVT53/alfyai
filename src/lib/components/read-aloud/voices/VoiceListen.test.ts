import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInVoiceInfo } from "$lib/client/api/read-aloud-voices";
import type {
	PreviewSound,
	VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { type Knobs, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import {
	idleReadAloudView,
	idleVoicePreviewView,
	setVoicePreviewView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import VoiceListen from "./VoiceListen.svelte";

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

const IMOGEN: BuiltInVoiceInfo = {
	key: "imogen",
	name: "Imogen",
	language: "en",
};

function listen(
	props: Partial<{
		knobs: Knobs;
		compare: "yours" | "original";
		useOwnWords: boolean;
		words: string;
	}> = {},
) {
	const preview = fakePreview();
	const handlers = {
		onCompare: vi.fn(),
		onPlayAfterChange: vi.fn(),
		onUseOwnWords: vi.fn(),
		onWords: vi.fn(),
	};
	const result = render(VoiceListen, {
		props: {
			base: IMOGEN,
			knobs: { ...ZERO_KNOBS, pace: -1 },
			compare: "yours",
			playAfterChange: true,
			useOwnWords: false,
			words: "",
			preview,
			...handlers,
			...props,
		},
	});
	return { ...result, preview, ...handlers };
}

beforeEach(() => {
	uiLanguage.set("en");
	setVoicePreviewView(idleVoicePreviewView);
});

afterEach(() => {
	setVoicePreviewView(idleVoicePreviewView);
});

describe("VoiceListen", () => {
	it("turning own words on puts focus in the field it shows", async () => {
		const t = listen();
		t.onUseOwnWords.mockImplementation((on: boolean) => {
			void t.rerender({ useOwnWords: on });
		});
		const toggle = screen.getByRole("switch", { name: "Use my own words" });
		toggle.focus();
		await fireEvent.click(toggle);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("textbox", { name: "Your words" }),
			),
		);
	});

	it("before anything plays the pill shows the sample's two notches and an estimated length", () => {
		const { container } = listen();
		const scrubber = screen.getByRole("slider", { name: "Sentence" });
		expect(scrubber.getAttribute("aria-valuemax")).toBe("2");
		expect(scrubber.getAttribute("aria-valuenow")).toBe("1");
		const times = [...container.querySelectorAll(".read-aloud-time")].map(
			(time) => time.textContent,
		);
		// 138 characters at 15 a second.
		expect(times).toEqual(["0:00", "≈0:09"]);
		expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
		expect(screen.getByText(`“${VOICE_SAMPLES.en.join(" ")}”`)).toBeTruthy();
	});

	it("plays the voice from the pill, and Yours / Original calls onCompare", async () => {
		const { preview, onCompare } = listen();
		await fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(preview.unlock).toHaveBeenCalled();
		const played = vi.mocked(preview.toggle).mock.calls[0]?.[0] as PreviewSound;
		expect(played).toMatchObject({
			owner: "listen",
			request: { base: "imogen", knobs: { ...ZERO_KNOBS, pace: -1 } },
		});
		const compare = screen.getByRole("group", { name: "Compare" });
		expect(
			within(compare)
				.getByRole("button", { name: "Yours" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		await fireEvent.click(
			within(compare).getByRole("button", { name: "Original" }),
		);
		expect(onCompare).toHaveBeenCalledWith("original");
	});

	it("the person's words replace the sample", async () => {
		const { preview } = listen({ useOwnWords: true, words: "Hello there." });
		const field = screen.getByRole("textbox", {
			name: "Your words",
		}) as HTMLInputElement;
		expect(field.value).toBe("Hello there.");
		expect(field.maxLength).toBe(300);
		expect(screen.queryByText(`“${VOICE_SAMPLES.en.join(" ")}”`)).toBeNull();
		await fireEvent.keyDown(field, { key: "Enter" });
		const played = vi.mocked(preview.play).mock.calls[0]?.[0] as PreviewSound;
		expect(played.request.text).toBe("Hello there.");
		expect(played.sentences).toEqual(["Hello there."]);
	});

	it("words with nothing to say play the sample", async () => {
		const { preview } = listen({ useOwnWords: true, words: "  ★ " });
		await fireEvent.click(screen.getByRole("button", { name: "Play" }));
		const played = vi.mocked(preview.toggle).mock.calls[0]?.[0] as PreviewSound;
		expect(played.request.text).toBeUndefined();
		expect(played.sentences).toEqual(VOICE_SAMPLES.en);
	});

	it("shows the failure note with Try again when its render failed", async () => {
		const { container, preview } = listen();
		expect(container.querySelector(".read-aloud-note")).toBeNull();
		for (const owner of ["listen", "base:rupert"]) {
			setVoicePreviewView({
				owner,
				status: "failed",
				player: { ...idleReadAloudView, status: "stopped" },
			});
			await Promise.resolve();
			const note = container.querySelector(".read-aloud-note") as HTMLElement;
			expect(note.textContent).toContain("Couldn't play the sample.");
			expect(note.dataset.placement).toBe("inline");
			await fireEvent.click(
				within(note).getByRole("button", { name: "Try again" }),
			);
		}
		expect(preview.retry).toHaveBeenCalledTimes(2);
		setVoicePreviewView({
			owner: "voice:v1",
			status: "failed",
			player: { ...idleReadAloudView, status: "stopped" },
		});
		await Promise.resolve();
		expect(container.querySelector(".read-aloud-note")).toBeNull();
	});
});
