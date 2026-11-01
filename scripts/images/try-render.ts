#!/usr/bin/env tsx
//
// One real render through the picture server, built with the app's own graph
// code. Needs a tunnel to ComfyUI (ssh -N -L 8188:127.0.0.1:8188 alfyroot).
//
// Run:  npx tsx scripts/images/try-render.ts generate <out.png> [prompt]
//       npx tsx scripts/images/try-render.ts edit <out.png> <input.png> [prompt]
// Env:  COMFYUI_URL (default http://127.0.0.1:8188)

import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
	canvasForEdit,
	canvasForNewPicture,
} from "../../src/lib/server/services/images/canvas";
import { createComfyUiClient } from "../../src/lib/server/services/images/comfyui/client";
import {
	buildPromptGraph,
	graphFor,
} from "../../src/lib/server/services/images/comfyui/templates";
import { freshSeed } from "../../src/lib/server/services/images/seeds";

const GENERATE_PROMPT =
	"a cosy living room with a grey linen sofa against the left wall, evening light";
const EDIT_PROMPT =
	"make the sofa dark green, keep everything else exactly as it is";

async function main(): Promise<void> {
	const [mode, out, third, fourth] = process.argv.slice(2);
	if ((mode !== "generate" && mode !== "edit") || !out) {
		console.error(
			"usage: try-render.ts generate <out.png> [prompt] | edit <out.png> <input.png> [prompt]",
		);
		process.exit(2);
	}
	const found = graphFor(mode, false);
	if (!found) throw new Error(`no ${mode} template`);
	const client = createComfyUiClient({
		baseUrl: process.env.COMFYUI_URL ?? "http://127.0.0.1:8188",
	});
	const started = Date.now();
	try {
		let images: string[] = [];
		let canvas = canvasForNewPicture("landscape", false);
		let prompt = third ?? GENERATE_PROMPT;
		if (mode === "edit") {
			if (!third) throw new Error("edit needs an input picture");
			prompt = fourth ?? EDIT_PROMPT;
			const bytes = new Uint8Array(await readFile(third));
			const meta = await sharp(bytes).metadata();
			canvas = canvasForEdit(
				{ width: meta.width ?? 1248, height: meta.height ?? 832 },
				false,
			);
			const ref = await client.uploadImage(bytes, "try-render-input.png");
			images = [
				ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename,
			];
		}
		const graph = buildPromptGraph(found.template, {
			prompt,
			seed: freshSeed([]),
			width: canvas.width,
			height: canvas.height,
			images,
		});
		const { promptId } = await client.submit(graph);
		let lastStep = -1;
		const refs = await client.follow(promptId, {
			signal: new AbortController().signal,
			deadlineMs: 600_000,
			onEvent: (event) => {
				if (event.type === "progress" && event.value !== lastStep) {
					lastStep = event.value;
					if (lastStep % 10 === 0)
						console.log(`step ${event.value}/${event.max}`);
				}
			},
		});
		const first = refs[0];
		if (!first) throw new Error("ComfyUI returned no picture");
		const png = await client.fetchImage(first);
		await writeFile(out, png);
		const meta = await sharp(png).metadata();
		console.log(
			`${mode}: ${meta.width}x${meta.height} channels=${meta.channels} hasAlpha=${meta.hasAlpha} ${((Date.now() - started) / 1000).toFixed(1)}s -> ${out}`,
		);
	} finally {
		client.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
