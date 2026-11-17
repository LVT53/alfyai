// The 2.4 campaign's pictures, one per card (`sizes.ts` names them). Each draws
// itself for a variant: the desktop's 16:10 crop or the phone's 9:16.

import type { Component } from "svelte";
import AsksFirst from "./pictures/AsksFirst.svelte";
import NewFeatures from "./pictures/NewFeatures.svelte";
import ReadAloud from "./pictures/ReadAloud.svelte";
import Smaller from "./pictures/Smaller.svelte";
import Videos from "./pictures/Videos.svelte";
import Voices from "./pictures/Voices.svelte";
import type { PictureName, Variant } from "./sizes";

export const PICTURES: Record<PictureName, Component<{ variant: Variant }>> = {
	"read-aloud": ReadAloud,
	voices: Voices,
	"asks-first": AsksFirst,
	videos: Videos,
	new: NewFeatures,
	smaller: Smaller,
};
