import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { degradedToolLabels } from "$lib/client/degraded-capabilities";
import { type I18nKey, t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";

afterEach(() => uiLanguage.set("en"));

describe("degradedToolLabels", () => {
	it("names make_image in both languages, lower-case for the banner sentence", () => {
		const degraded = [{ tool: "make_image", backend: "ComfyUI", since: "" }];
		uiLanguage.set("en");
		expect(degradedToolLabels(degraded, get(t))).toEqual(["making pictures"]);
		uiLanguage.set("hu");
		expect(degradedToolLabels(degraded, get(t))).toEqual(["képkészítés"]);
	});

	it("falls back to the tool name when there is no label", () => {
		expect(
			degradedToolLabels(
				[{ tool: "mystery", backend: "x", since: "" }],
				(key: I18nKey) => key,
			),
		).toEqual(["mystery"]);
	});
});
