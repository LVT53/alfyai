#!/usr/bin/env tsx
//
// Plan 2c Task 5: measures how far the real Qwen edits drift outside the edited
// area, raw and with the app's paste-back guard. Generated scenes only. Needs a
// tunnel to ComfyUI (ssh -N -L 8188:127.0.0.1:8188 alfyroot) and the throwaway
// LPIPS venv (see lpips.py).
//
// Run:  npx tsx scripts/images/drift.ts --make-scenes <scenes dir>
//       npx tsx scripts/images/drift.ts <scenes dir> <out dir> [--mask-only]
// Scenes: <scenes dir>/room-*.png plus sofa-0.png. Renders are cached in <out dir>
// by a hash of their inputs, so a threshold change re-runs only the guards.
// --mask-only: write masks and guard measures, no composites and no LPIPS.
// Env: COMFYUI_URL (default http://127.0.0.1:8188), LPIPS_PYTHON (the throwaway venv's python;
// MUST be set unless the venv is at /tmp/claude-1000/lpips-venv), DRIFT_GUARD (JSON GUARD overrides).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { guardEdit } from "../../src/lib/server/services/images/guards/guard-edit";
import {
	decodeRaw,
	encodePng,
	type RawImage,
} from "../../src/lib/server/services/images/guards/raw-image";
import { GUARD } from "../../src/lib/server/services/images/guards/thresholds";
import { freshSeed } from "../../src/lib/server/services/images/seeds";

const KEEP = "keep everything else exactly as it is";

export type DriftEdit = { id: string; prompt: string; needsSofa?: boolean };

export const SINGLE_EDITS: ReadonlyArray<DriftEdit> = [
	{ id: "recolour", prompt: `make the sofa dark green, ${KEEP}` },
	{
		id: "reupholster",
		prompt: `reupholster the sofa in brown leather, ${KEEP}`,
	},
	{ id: "cushion", prompt: `add one orange cushion on the sofa, ${KEEP}` },
	{
		id: "move",
		prompt: `move the sofa to the right side of the room, ${KEEP}`,
	},
	{
		id: "sofa-picture",
		needsSofa: true,
		prompt: `put the sofa from the second picture into the room of the first picture, ${KEEP}`,
	},
];

export const CHAIN_EDITS: ReadonlyArray<DriftEdit> = [
	{ id: "chain-1", prompt: `add a floor lamp next to the sofa, ${KEEP}` },
	{ id: "chain-2", prompt: `make the rug blue, ${KEEP}` },
	{ id: "chain-3", prompt: `hang a framed picture on the wall, ${KEEP}` },
	{ id: "chain-4", prompt: `add a potted plant in a corner, ${KEEP}` },
	{ id: "chain-5", prompt: `make the curtains red, ${KEEP}` },
];

const SCENE_PROMPTS = [
	"a cosy living room with a grey linen sofa against the left wall, evening light",
	"a bright modern living room with a beige sofa, a glass coffee table and a blue rug",
	"a small living room with a brown sofa under a window, a wooden floor and a bookshelf",
];
const SOFA_PROMPT =
	"a single dark red velvet sofa on a plain white background, product photo";

export function unionMasks(masks: ReadonlyArray<Float32Array>): Float32Array {
	const out = new Float32Array(masks[0]?.length ?? 0);
	for (const mask of masks)
		for (let i = 0; i < out.length; i++) if (mask[i] > out[i]) out[i] = mask[i];
	return out;
}

export type DriftFields = {
	scene: string;
	edit: string;
	mode: "raw" | "pasteback";
	lpipsOutside: number | null;
	offsetPx: number | null;
	changedShare: number;
	miss: string | null;
	global: boolean;
	reanchored: boolean;
};

export function driftLine(f: DriftFields): string {
	return JSON.stringify({
		scene: f.scene,
		edit: f.edit,
		mode: f.mode,
		lpips_outside: f.lpipsOutside,
		offset_px: f.offsetPx,
		changed_share: +f.changedShare.toFixed(4),
		miss: f.miss,
		global: f.global,
		reanchored: f.reanchored,
	});
}

const BASE_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const PY = process.env.LPIPS_PYTHON ?? "/tmp/claude-1000/lpips-venv/bin/python";
const LPIPS = join(dirname(fileURLToPath(import.meta.url)), "lpips.py");
const usedSeeds: number[] = [];

async function renderPng(
	client: ReturnType<typeof createComfyUiClient>,
	mode: "generate" | "edit",
	prompt: string,
	inputs: Uint8Array[],
	size: { width: number; height: number },
): Promise<Uint8Array> {
	const found = graphFor(mode, false);
	if (!found) throw new Error(`no ${mode} template`);
	const images: string[] = [];
	for (const [i, bytes] of inputs.entries()) {
		const ref = await client.uploadImage(bytes, `drift-in-${i}.png`);
		images.push(
			ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename,
		);
	}
	const seed = freshSeed(usedSeeds);
	usedSeeds.push(seed);
	const graph = buildPromptGraph(found.template, {
		prompt,
		seed,
		width: size.width,
		height: size.height,
		images,
	});
	const { promptId } = await client.submit(graph);
	const refs = await client.follow(promptId, {
		signal: new AbortController().signal,
		deadlineMs: 600_000,
		onEvent: () => {},
	});
	if (!refs[0]) throw new Error("ComfyUI returned no picture");
	return client.fetchImage(refs[0]);
}

function hashOf(parts: Array<Uint8Array | string>): string {
	const h = createHash("sha1");
	for (const p of parts) h.update(p);
	return h.digest("hex").slice(0, 8);
}

async function maskPng(
	mask: Float32Array,
	w: number,
	h: number,
): Promise<Buffer> {
	const grey = Buffer.alloc(w * h);
	for (let i = 0; i < grey.length; i++) grey[i] = mask[i] > 0 ? 255 : 0;
	return sharp(grey, { raw: { width: w, height: h, channels: 1 } })
		.png()
		.toBuffer();
}

type LpipsResult = { lpips_outside: number; offset_px: number };
function runLpips(before: string, after: string, mask: string): LpipsResult {
	const r = spawnSync(PY, ["-I", LPIPS, before, after, mask], {
		encoding: "utf8",
	});
	const line = r.stdout.trim().split("\n").pop() ?? "";
	try {
		return JSON.parse(line) as LpipsResult;
	} catch {
		throw new Error(`lpips.py failed: ${r.stderr.slice(-400)}`);
	}
}

async function makeScenes(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const client = createComfyUiClient({ baseUrl: BASE_URL });
	try {
		const size = canvasForNewPicture("landscape", false);
		for (const [i, prompt] of SCENE_PROMPTS.entries()) {
			const png = await renderPng(client, "generate", prompt, [], size);
			await writeFile(join(dir, `room-${i}.png`), png);
			console.log(`room-${i}.png`);
		}
		const sofa = await renderPng(client, "generate", SOFA_PROMPT, [], size);
		await writeFile(join(dir, "sofa-0.png"), sofa);
		console.log("sofa-0.png");
	} finally {
		client.close();
	}
}

async function main(): Promise<void> {
	// Tuning only: DRIFT_GUARD='{"diffThreshold":16}' overrides GUARD for this run.
	if (process.env.DRIFT_GUARD) {
		Object.assign(GUARD, JSON.parse(process.env.DRIFT_GUARD));
		console.log(`GUARD override ${process.env.DRIFT_GUARD}`);
	}
	const args = process.argv.slice(2);
	if (args[0] === "--make-scenes" && args[1]) return makeScenes(args[1]);
	const maskOnly = args.includes("--mask-only");
	const [scenesDir, outDir] = args.filter((a) => !a.startsWith("--"));
	if (!scenesDir || !outDir) {
		console.error(
			"usage: drift.ts <scenes dir> <out dir> [--mask-only] | --make-scenes <dir>",
		);
		process.exit(2);
	}
	await mkdir(outDir, { recursive: true });
	const names = (await readdir(scenesDir))
		.filter((n) => /^room-\d+\.png$/.test(n))
		.sort();
	const sofaBytes = new Uint8Array(
		await readFile(join(scenesDir, "sofa-0.png")),
	);
	const client = createComfyUiClient({ baseUrl: BASE_URL });
	const lines = join(outDir, "measures.jsonl");
	await writeFile(lines, "");
	const emit = async (f: DriftFields) => {
		const l = driftLine(f);
		console.log(l);
		await appendFile(lines, `${l}\n`);
	};

	// A model result for (input pictures, prompt), cached by a hash of both.
	async function resultFor(
		scene: string,
		tag: string,
		prompt: string,
		inputs: Uint8Array[],
		base: RawImage,
	): Promise<{ raw: RawImage; rawPath: string }> {
		const key = hashOf([prompt, ...inputs]);
		const rawPath = join(outDir, scene, `${tag}-${key}-raw.png`);
		if (!existsSync(rawPath)) {
			const canvas = canvasForEdit(
				{ width: base.width, height: base.height },
				false,
			);
			const png = await renderPng(client, "edit", prompt, inputs, canvas);
			await writeFile(rawPath, png);
		}
		const raw = await decodeRaw(new Uint8Array(await readFile(rawPath)), {
			width: base.width,
			height: base.height,
		});
		return { raw, rawPath };
	}

	async function measure(
		scene: string,
		tag: string,
		base: RawImage,
		basePath: string,
		raw: RawImage,
		guarded: RawImage,
		mask: Float32Array,
		out: Awaited<ReturnType<typeof guardEdit>>,
	) {
		const dir = join(outDir, scene);
		const maskPath = join(dir, `${tag}-mask.png`);
		await writeFile(maskPath, await maskPng(mask, base.width, base.height));
		const base_ = {
			scene,
			edit: tag,
			changedShare: out.measures.changedShare,
			miss: out.measures.miss,
			global: out.measures.global,
			reanchored: out.measures.reanchored,
		};
		if (maskOnly) {
			await emit({
				...base_,
				mode: "pasteback",
				lpipsOutside: null,
				offsetPx: null,
			});
			return;
		}
		const rawOut = join(dir, `${tag}-rawview.png`);
		const guardedPath = join(dir, `${tag}-guarded.png`);
		await writeFile(rawOut, await encodePng(raw));
		await writeFile(guardedPath, await encodePng(guarded));
		if (out.measures.global) {
			await emit({ ...base_, mode: "raw", lpipsOutside: null, offsetPx: null });
			return;
		}
		const r = runLpips(basePath, rawOut, maskPath);
		await emit({
			...base_,
			mode: "raw",
			lpipsOutside: r.lpips_outside,
			offsetPx: r.offset_px,
		});
		const g = runLpips(basePath, guardedPath, maskPath);
		await emit({
			...base_,
			mode: "pasteback",
			lpipsOutside: g.lpips_outside,
			offsetPx: g.offset_px,
		});
	}

	try {
		for (const file of names) {
			const scene = file.replace(".png", "");
			await mkdir(join(outDir, scene), { recursive: true });
			const basePath = join(scenesDir, file);
			const baseBytes = new Uint8Array(await readFile(basePath));
			const base = await decodeRaw(baseBytes);

			for (const edit of SINGLE_EDITS) {
				const inputs = edit.needsSofa ? [baseBytes, sofaBytes] : [baseBytes];
				const { raw } = await resultFor(
					scene,
					edit.id,
					edit.prompt,
					inputs,
					base,
				);
				const out = await guardEdit({
					base,
					anchor: null,
					chainSinceAnchor: 0,
					result: raw,
					marks: null,
				});
				await measure(
					scene,
					edit.id,
					base,
					basePath,
					raw,
					out.picture,
					out.mask,
					out,
				);
			}

			// Chains: raw (each result feeds the next as it is) and guarded (paste-back).
			for (const mode of ["raw", "guarded"] as const) {
				let current = base;
				let anchor: RawImage = base;
				let chain = 0;
				const masks: Float32Array[] = [];
				let last: RawImage = base;
				for (const edit of CHAIN_EDITS) {
					const bytes = new Uint8Array(await encodePng(current));
					const { raw } = await resultFor(
						scene,
						`${edit.id}-${mode}`,
						edit.prompt,
						[bytes],
						base,
					);
					const out = await guardEdit({
						base: current,
						anchor,
						chainSinceAnchor: chain,
						result: raw,
						marks: null,
					});
					masks.push(out.mask);
					if (mode === "raw") {
						current = raw;
					} else {
						current = out.picture;
						if (out.anchorIsResult) anchor = out.picture;
						chain = out.chainSinceAnchor;
					}
					last = current;
				}
				const union = unionMasks(masks);
				const dir = join(outDir, scene);
				const finalPath = join(dir, `chain-${mode}-final.png`);
				const maskPath = join(dir, `chain-${mode}-union-mask.png`);
				await writeFile(
					maskPath,
					await maskPng(union, base.width, base.height),
				);
				if (maskOnly) continue;
				await writeFile(finalPath, await encodePng(last));
				const r = runLpips(basePath, finalPath, maskPath);
				await emit({
					scene,
					edit: "chain-after-5",
					mode: mode === "raw" ? "raw" : "pasteback",
					lpipsOutside: r.lpips_outside,
					offsetPx: r.offset_px,
					changedShare: 0,
					miss: null,
					global: false,
					reanchored: false,
				});
			}
		}
	} finally {
		client.close();
	}
}

const invoked = process.argv[1]?.endsWith("drift.ts");
if (invoked) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
