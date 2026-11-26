// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PreviewSound,
	VoicePreview,
} from "$lib/client/read-aloud/voice-preview";
import { ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import {
	idleReadAloudView,
	idleVoicePreviewView,
	setVoicePreviewView,
} from "$lib/stores/read-aloud";
import { uiLanguage } from "$lib/stores/settings";
import VoicePlayButton from "./VoicePlayButton.svelte";

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

const sound = (owner: string): PreviewSound => ({
	owner,
	request: { base: "imogen", knobs: { ...ZERO_KNOBS } },
	sentences: VOICE_SAMPLES.en,
});

beforeEach(() => {
	uiLanguage.set("en");
	setVoicePreviewView(idleVoicePreviewView);
});

afterEach(() => {
	setVoicePreviewView(idleVoicePreviewView);
});

describe("VoicePlayButton", () => {
	it("unlocks and toggles on press, nothing awaited first", async () => {
		const preview = fakePreview();
		const imogen = sound("base:imogen");
		render(VoicePlayButton, {
			props: {
				sound: imogen,
				label: "Play Imogen",
				pauseLabel: "Pause Imogen",
				preview,
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Play Imogen" }));
		expect(preview.unlock).toHaveBeenCalledTimes(1);
		expect(preview.toggle).toHaveBeenCalledWith(imogen);
		const unlockOrder =
			vi.mocked(preview.unlock).mock.invocationCallOrder[0] ?? 0;
		const toggleOrder =
			vi.mocked(preview.toggle).mock.invocationCallOrder[0] ?? 0;
		expect(unlockOrder).toBeLessThan(toggleOrder);
	});

	it("shows a spinner, then pause, for its own sound only", async () => {
		const { container } = render(VoicePlayButton, {
			props: {
				sound: sound("base:imogen"),
				label: "Play Imogen",
				pauseLabel: "Pause Imogen",
				preview: fakePreview(),
			},
		});
		const button = () => container.querySelector("button") as HTMLButtonElement;
		setVoicePreviewView({
			owner: "base:rupert",
			status: "loading",
			player: { ...idleReadAloudView, status: "seeking" },
		});
		await Promise.resolve();
		expect(button().querySelector(".mini-spinner")).toBeNull();
		expect(button().querySelector(".lucide-play")).toBeTruthy();
		setVoicePreviewView({
			owner: "base:imogen",
			status: "loading",
			player: { ...idleReadAloudView, status: "seeking" },
		});
		await Promise.resolve();
		expect(button().querySelector(".mini-spinner")).toBeTruthy();
		setVoicePreviewView({
			owner: "base:imogen",
			status: "playing",
			player: { ...idleReadAloudView, status: "playing" },
		});
		await Promise.resolve();
		expect(button().querySelector(".lucide-pause")).toBeTruthy();
		expect(button().getAttribute("aria-label")).toBe("Pause Imogen");
	});
});
