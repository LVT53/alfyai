// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import readAloudDict from "$lib/i18n/read-aloud";
import { KNOBS, type KnobSpec } from "$lib/shared/read-aloud/voice-knobs";
import { uiLanguage } from "$lib/stores/settings";
import VoiceKnobSlider from "./VoiceKnobSlider.svelte";

const spec = (key: string) =>
	KNOBS.find((knob) => knob.key === key) as KnobSpec;

function slider(key: string, value: number) {
	const handlers = {
		onInput: vi.fn(),
		onCommit: vi.fn(),
		onReset: vi.fn(),
	};
	const result = render(VoiceKnobSlider, {
		props: { spec: spec(key), value, ...handlers },
	});
	return { ...result, ...handlers };
}

beforeEach(() => {
	uiLanguage.set("en");
});

describe("VoiceKnobSlider", () => {
	it("shows the word for its value and the spec's ends", () => {
		const { container } = slider("pace", -1);
		const input = screen.getByRole("slider", { name: "Pace" });
		expect(input.getAttribute("aria-valuetext")).toBe("Slower");
		expect(input.getAttribute("min")).toBe("-2");
		expect(input.getAttribute("max")).toBe("2");
		expect(input.getAttribute("step")).toBe("0.05");
		expect(container.querySelector(".voice-knob-word")?.textContent).toBe(
			"Slower",
		);
		expect(
			container.querySelector(".voice-knob")?.hasAttribute("data-moved"),
		).toBe(true);
		const ends = [...container.querySelectorAll(".voice-knob-ends span")].map(
			(end) => end.textContent,
		);
		expect(ends).toEqual(["Slower", "Faster"]);
	});

	it("snaps near normal while dragging", async () => {
		const { onInput } = slider("pace", 0);
		const input = screen.getByRole("slider", {
			name: "Pace",
		}) as HTMLInputElement;
		await fireEvent.pointerDown(input);
		await fireEvent.input(input, { target: { value: "0.1" } });
		expect(onInput).toHaveBeenLastCalledWith(0);
		expect(input.value).toBe("0");
		await fireEvent.input(input, { target: { value: "0.3" } });
		expect(onInput).toHaveBeenLastCalledWith(0.3);
	});

	it("commits by pointer or by key", async () => {
		const { onCommit } = slider("energy", 0);
		const input = screen.getByRole("slider", {
			name: "Energy",
		}) as HTMLInputElement;
		await fireEvent.pointerDown(input);
		await fireEvent.change(input, { target: { value: "-2.5" } });
		expect(onCommit).toHaveBeenLastCalledWith(-2.5, "pointer");
		await fireEvent.keyDown(input, { key: "ArrowRight" });
		await fireEvent.change(input, { target: { value: "-2.45" } });
		expect(onCommit).toHaveBeenLastCalledWith(-2.45, "key");
	});

	it("shows ↺ only when moved, and resets", async () => {
		const still = slider("depth", 0);
		expect(
			still.queryByRole("button", { name: "Depth back to normal" }),
		).toBeNull();
		still.unmount();
		const moved = slider("depth", 1);
		await fireEvent.click(
			moved.getByRole("button", { name: "Depth back to normal" }),
		);
		expect(moved.onReset).toHaveBeenCalledTimes(1);
	});

	it("a key step leaves normal in one press, and steps back to it", async () => {
		const { onInput, rerender } = slider("pace", 0);
		const input = screen.getByRole("slider", {
			name: "Pace",
		}) as HTMLInputElement;
		await fireEvent.keyDown(input, { key: "ArrowRight" });
		await fireEvent.input(input, { target: { value: "0.05" } });
		// Pace snaps within ±0.16: the step goes on to the first value outside.
		expect(onInput).toHaveBeenLastCalledWith(0.2);
		expect(input.value).toBe("0.2");
		await rerender({ value: 0.2 });
		await fireEvent.keyDown(input, { key: "ArrowLeft" });
		await fireEvent.input(input, { target: { value: "0.15" } });
		expect(onInput).toHaveBeenLastCalledWith(0);
	});

	it("↺ gives focus to its slider", async () => {
		const moved = slider("depth", 1);
		const reset = moved.getByRole("button", { name: "Depth back to normal" });
		reset.focus();
		await fireEvent.click(reset);
		expect(moved.onReset).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(
			moved.getByRole("slider", { name: "Depth" }),
		);
	});

	it("has a word for every band of its knob", () => {
		for (const knob of KNOBS) {
			for (const language of ["en", "hu"] as const) {
				const dict: Record<string, string> = readAloudDict[language];
				for (let i = 0; i < knob.words; i++)
					expect(
						dict[`readAloud.knob.${knob.key}.${i}`],
						`${language} ${knob.key}.${i}`,
					).toBeTruthy();
				expect(
					dict[`readAloud.knob.${knob.key}.${knob.words}`],
				).toBeUndefined();
			}
		}
	});
});
