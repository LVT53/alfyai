#!/usr/bin/env tsx
//
// Plan 2c Task 5: measures how far the real Qwen edits drift outside the edited
// area, raw and with the app's paste-back guard. Generated scenes only. Needs a
// tunnel to ComfyUI (ssh -N -L 8188:127.0.0.1:8188 alfyroot) and the throwaway
// LPIPS venv (see lpips.py).
//
// Run:  npx tsx scripts/images/drift.ts --make-scenes <scenes dir>
//       npx tsx scripts/images/drift.ts <scenes dir> <out dir> --remeasure   (independent region, marked steps)
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
import {
	marksLabel,
	paintMarks,
} from "../../src/lib/server/services/images/marks";
import { freshSeed } from "../../src/lib/server/services/images/seeds";
import type { ImageMark } from "../../src/lib/shared/artifacts/image-body";

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

/** A box as fractions of the picture (x, y from the top left), the shape of a drawn mark. */
export type Box = { x: number; y: number; w: number; h: number };

/**
 * Hand-specified boxes per generated scene (read off the base renders once; recorded in
 * results-part-2-server.md): `sofa` is the sofa's bounding box, `seat` is where the cushion
 * mark A goes, `dest` is where "move" puts the sofa (mark B, and the unmarked move's target).
 */
export const SCENE_BOXES: Record<string, { sofa: Box; seat: Box; dest: Box }> =
	{
		"room-0": {
			sofa: { x: 0, y: 0.19, w: 0.71, h: 0.78 },
			seat: { x: 0.48, y: 0.47, w: 0.2, h: 0.11 },
			dest: { x: 0.55, y: 0.25, w: 0.45, h: 0.7 },
		},
		"room-1": {
			sofa: { x: 0.49, y: 0.48, w: 0.37, h: 0.27 },
			seat: { x: 0.62, y: 0.57, w: 0.18, h: 0.09 },
			dest: { x: 0.08, y: 0.55, w: 0.4, h: 0.27 },
		},
		"room-2": {
			sofa: { x: 0.22, y: 0.48, w: 0.47, h: 0.39 },
			seat: { x: 0.34, y: 0.59, w: 0.18, h: 0.09 },
			dest: { x: 0.56, y: 0.58, w: 0.42, h: 0.3 },
		},
	};

/** Each side moved out by `share` of the box's own width/height, kept inside the picture. */
export function growBox(box: Box, share: number): Box {
	const x0 = Math.max(0, box.x - box.w * share);
	const y0 = Math.max(0, box.y - box.h * share);
	const x1 = Math.min(1, box.x + box.w * (1 + share));
	const y1 = Math.min(1, box.y + box.h * (1 + share));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 1 inside any of the boxes, 0 elsewhere. */
export function boxesMask(
	boxes: ReadonlyArray<Box>,
	width: number,
	height: number,
): Float32Array {
	const mask = new Float32Array(width * height);
	for (const b of boxes) {
		const x0 = Math.floor(b.x * width);
		const x1 = Math.min(width, Math.ceil((b.x + b.w) * width));
		const y0 = Math.floor(b.y * height);
		const y1 = Math.min(height, Math.ceil((b.y + b.h) * height));
		for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
	}
	return mask;
}

type RegionFields = {
	scene: string;
	edit: string;
	marked: boolean;
	mode: "raw" | "pasteback";
	lpipsRegion: number;
	offsetPx: number;
	lpipsWhole: number;
	changedShare: number;
	insideMarksShare: number | null;
	miss: string | null;
	global: boolean;
};

function regionLine(f: RegionFields): string {
	return JSON.stringify({
		scene: f.scene,
		edit: f.edit,
		marked: f.marked,
		mode: f.mode,
		lpips_outside_region: f.lpipsRegion,
		offset_outside_region_px: f.offsetPx,
		lpips_whole_frame: f.lpipsWhole,
		changed_share: +f.changedShare.toFixed(4),
		inside_marks_share:
			f.insideMarksShare === null ? null : +f.insideMarksShare.toFixed(4),
		miss: f.miss,
		global: f.global,
	});
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
	/** LPIPS over the whole frame (nothing excluded), when measured. */
	lpipsWhole?: number;
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
		lpips_whole: f.lpipsWhole,
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

/** A mask with nothing masked out, so LPIPS covers the whole frame. */
async function writeBlankMask(
	path: string,
	w: number,
	h: number,
): Promise<string> {
	await writeFile(path, await maskPng(new Float32Array(w * h), w, h));
	return path;
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
		const blank = await writeBlankMask(
			join(dir, "blank-mask.png"),
			base.width,
			base.height,
		);
		const rawWhole = runLpips(basePath, rawOut, blank).lpips_outside;
		const guardedWhole = runLpips(basePath, guardedPath, blank).lpips_outside;
		if (out.measures.global) {
			await emit({
				...base_,
				mode: "raw",
				lpipsOutside: null,
				offsetPx: null,
				lpipsWhole: rawWhole,
			});
			await emit({
				...base_,
				mode: "pasteback",
				lpipsOutside: null,
				offsetPx: null,
				lpipsWhole: guardedWhole,
			});
			return;
		}
		const r = runLpips(basePath, rawOut, maskPath);
		await emit({
			...base_,
			mode: "raw",
			lpipsOutside: r.lpips_outside,
			offsetPx: r.offset_px,
			lpipsWhole: rawWhole,
		});
		const g = runLpips(basePath, guardedPath, maskPath);
		await emit({
			...base_,
			mode: "pasteback",
			lpipsOutside: g.lpips_outside,
			offsetPx: g.offset_px,
			lpipsWhole: guardedWhole,
		});
	}

	// Independent region (plan 2c Task 5 re-measure): LPIPS and offset outside a region the
	// guard does not produce, plus the whole frame. Marked steps go through the app's marks
	// painter (images/marks.ts) and the edit graph with a second, marked input picture.
	if (args.includes("--remeasure")) {
		const regionLines = join(outDir, "region-measures.jsonl");
		await writeFile(regionLines, "");
		try {
			for (const file of names) {
				const scene = file.replace(".png", "");
				const boxes = SCENE_BOXES[scene];
				if (!boxes) continue;
				await mkdir(join(outDir, scene), { recursive: true });
				const basePath = join(scenesDir, file);
				const baseBytes = new Uint8Array(await readFile(basePath));
				const base = await decodeRaw(baseBytes);
				const blank = await writeBlankMask(
					join(outDir, scene, "blank-mask.png"),
					base.width,
					base.height,
				);
				const steps: Array<{
					id: string;
					prompt: string;
					inputs: Uint8Array[];
					marks: ImageMark[] | null;
					region: Box[];
				}> = [];
				for (const edit of SINGLE_EDITS) {
					const unmarkedRegion =
						edit.id === "move" ? [boxes.sofa, boxes.dest] : [boxes.sofa];
					steps.push({
						id: edit.id,
						prompt: edit.prompt,
						inputs: edit.needsSofa ? [baseBytes, sofaBytes] : [baseBytes],
						marks: null,
						region: unmarkedRegion.map((b) => growBox(b, 0.1)),
					});
				}
				const cushionMarks: ImageMark[] = [{ letter: "A", ...boxes.seat }];
				const moveMarks: ImageMark[] = [
					{ letter: "A", ...boxes.sofa },
					{ letter: "B", ...boxes.dest },
				];
				for (const [id, instruction, marks] of [
					[
						"cushion-marked",
						"add one orange cushion inside box A",
						cushionMarks,
					],
					[
						"move-marked",
						"move the sofa in box A to the place of box B",
						moveMarks,
					],
				] as const) {
					const painted = new Uint8Array(await paintMarks(baseBytes, marks));
					steps.push({
						id,
						prompt: `${instruction}. ${marksLabel(2, marks)}. Remove the boxes and letters from the result, ${KEEP}`,
						inputs: [baseBytes, painted],
						marks: [...marks],
						region: marks.map((m) => growBox(m, 0.1)),
					});
				}
				for (const step of steps) {
					const { raw } = await resultFor(
						scene,
						step.id,
						step.prompt,
						step.inputs,
						base,
					);
					const out = await guardEdit({
						base,
						anchor: null,
						chainSinceAnchor: 0,
						result: raw,
						marks: step.marks,
					});
					const dir = join(outDir, scene);
					const regionPath = join(dir, `${step.id}-region-mask.png`);
					await writeFile(
						regionPath,
						await maskPng(
							boxesMask(step.region, base.width, base.height),
							base.width,
							base.height,
						),
					);
					await writeFile(
						join(dir, `${step.id}-mask.png`),
						await maskPng(out.mask, base.width, base.height),
					);
					const rawPath = join(dir, `${step.id}-rawview.png`);
					const guardedPath = join(dir, `${step.id}-guarded.png`);
					await writeFile(rawPath, await encodePng(raw));
					await writeFile(guardedPath, await encodePng(out.picture));
					for (const [mode, path] of [
						["raw", rawPath],
						["pasteback", guardedPath],
					] as const) {
						const r = runLpips(basePath, path, regionPath);
						const whole = runLpips(basePath, path, blank);
						const line = regionLine({
							scene,
							edit: step.id,
							marked: step.marks !== null,
							mode,
							lpipsRegion: r.lpips_outside,
							offsetPx: r.offset_px,
							lpipsWhole: whole.lpips_outside,
							changedShare: out.measures.changedShare,
							insideMarksShare: out.measures.insideMarksShare,
							miss: out.measures.miss,
							global: out.measures.global,
						});
						console.log(line);
						await appendFile(regionLines, `${line}\n`);
					}
				}
			}
		} finally {
			client.close();
		}
		return;
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
				const blank = await writeBlankMask(
					join(dir, "blank-mask.png"),
					base.width,
					base.height,
				);
				await emit({
					lpipsWhole: runLpips(basePath, finalPath, blank).lpips_outside,
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
