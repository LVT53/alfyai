#!/usr/bin/env tsx
//
// Plan 2c Task 4: first measurements of the picture server beside TEI and
// MinerU. Samples GPU1 over ssh while each case renders through a tunnel
// (ssh -N -L 8188:127.0.0.1:8188 alfyroot), polls the neighbours' health during
// the case and reads swap before and after. Generated scenes only.
//
// Run:  npx tsx scripts/images/measure.ts <outDir> [caseId ...]
// Env:  COMFYUI_URL (default http://127.0.0.1:8188), SSH_HOST (default alfyroot)

import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CanvasSize,
	canvasForEdit,
	canvasForNewPicture,
} from "../../src/lib/server/services/images/canvas";
import { createComfyUiClient } from "../../src/lib/server/services/images/comfyui/client";
import {
	buildPromptGraph,
	graphFor,
} from "../../src/lib/server/services/images/comfyui/templates";
import { freshSeed } from "../../src/lib/server/services/images/seeds";

/** Rows "index, MiB" from nvidia-smi csv; returns the MiB values of one GPU. */
export function parseNvidiaSmiSamples(
	text: string,
	gpuIndex: number,
): number[] {
	const out: number[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(line);
		if (match && Number(match[1]) === gpuIndex) out.push(Number(match[2]));
	}
	return out;
}

const EDIT_BASE: CanvasSize = { width: 1184, height: 896 };

export type MeasureCase = {
	id: string;
	mode: "generate" | "edit";
	inputs: number;
	canvas: CanvasSize;
	runs: number;
	note?: string;
};

export const MEASURE_CASES: ReadonlyArray<MeasureCase> = [
	{
		id: "generate-cold",
		mode: "generate",
		inputs: 0,
		canvas: canvasForNewPicture("landscape", false),
		runs: 1,
		note: "after POST /free",
	},
	{
		id: "generate-warm",
		mode: "generate",
		inputs: 0,
		canvas: canvasForNewPicture("landscape", false),
		runs: 3,
	},
	{
		id: "edit-1",
		mode: "edit",
		inputs: 1,
		canvas: canvasForEdit(EDIT_BASE, false),
		runs: 3,
	},
	{
		id: "edit-2",
		mode: "edit",
		inputs: 2,
		canvas: canvasForEdit(EDIT_BASE, false),
		runs: 1,
	},
	{
		id: "edit-4",
		mode: "edit",
		inputs: 4,
		canvas: canvasForEdit(EDIT_BASE, false),
		runs: 1,
	},
	{
		id: "edit-print",
		mode: "edit",
		inputs: 1,
		canvas: canvasForEdit(EDIT_BASE, true),
		runs: 1,
		note: "print canvas, about 4 MP",
	},
	{
		id: "trap-1024",
		mode: "edit",
		inputs: 1,
		canvas: { width: 1024, height: 1024 },
		runs: 1,
		note: "deliberate exact 1024x1024 (expect noise)",
	},
	{
		id: "trap-same-seed",
		mode: "edit",
		inputs: 1,
		canvas: canvasForEdit(EDIT_BASE, false),
		runs: 1,
		note: "seed that made the input (expect a broken picture)",
	},
	{
		id: "generate-transparent",
		mode: "generate",
		inputs: 0,
		canvas: canvasForNewPicture("square", false),
		runs: 1,
		note: "transparent wrap",
	},
	{
		id: "crash",
		mode: "edit",
		inputs: 1,
		canvas: canvasForEdit(EDIT_BASE, false),
		runs: 1,
		note: "comfyui.service restarted mid-run; next submit must work",
	},
];

const HOST = process.env.SSH_HOST ?? "alfyroot";
const SSH = ["-T", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", HOST];
const BASE = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const HEALTH = [
	"http://127.0.0.1:7997/health",
	"http://127.0.0.1:7998/health",
	"http://127.0.0.1:8002/v1/health",
	"http://127.0.0.1:30001/health",
];

function ssh(cmd: string): string {
	const r = spawnSync("ssh", [...SSH, cmd], {
		encoding: "utf8",
		timeout: 30000,
	});
	return r.stdout ?? "";
}

function swapUsedMb(): number {
	const m = /Swap:\s+\d+\s+(\d+)/.exec(ssh("free -m"));
	return m ? Number(m[1]) : -1;
}

function healthCodes(): string[] {
	const cmd = HEALTH.map(
		(u) => `curl -s -o /dev/null -m 5 -w '%{http_code}' ${u}`,
	).join('; echo -n " "; ');
	return ssh(cmd).trim().split(/\s+/);
}

const samples: { t: number; mib: number }[] = [];
function startSampler() {
	const child = spawn(
		"ssh",
		[
			...SSH,
			"nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits -lms 500",
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d.toString();
		const cut = buf.lastIndexOf("\n");
		if (cut < 0) return;
		const chunk = buf.slice(0, cut + 1);
		buf = buf.slice(cut + 1);
		for (const mib of parseNvidiaSmiSamples(chunk, 1))
			samples.push({ t: Date.now(), mib });
	});
	return child;
}

const client = createComfyUiClient({ baseUrl: BASE });

async function upload(png: Uint8Array, name: string): Promise<string> {
	const ref = await client.uploadImage(png, name);
	return ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
}

type RunResult = { seconds: number; png: Uint8Array; seed: number };

async function render(
	mode: "generate" | "edit",
	transparent: boolean,
	prompt: string,
	canvas: CanvasSize,
	images: string[],
	seed: number,
): Promise<RunResult> {
	const found = graphFor(mode, transparent);
	if (!found) throw new Error(`no ${mode} template`);
	const graph = buildPromptGraph(found.template, {
		prompt,
		seed,
		width: canvas.width,
		height: canvas.height,
		images,
	});
	const started = Date.now();
	const { promptId } = await client.submit(graph);
	const refs = await client.follow(promptId, {
		signal: new AbortController().signal,
		deadlineMs: 600_000,
		onEvent: () => {},
	});
	const first = refs[0];
	if (!first) throw new Error("no picture");
	const png = await client.fetchImage(first);
	return { seconds: (Date.now() - started) / 1000, png, seed };
}

const SCENES = [
	"a cosy living room with a grey linen sofa against the left wall, evening light",
	"a sunny kitchen with a wooden table and a bowl of oranges",
	"a quiet bedroom with a white bed and a green armchair by the window",
	"a small home office with a oak desk and a tall bookshelf",
];
const EDITS = [
	"make the sofa dark green, keep everything else exactly as it is",
	"combine the rooms into one hall, keeping the furniture of each",
];

async function main(): Promise<void> {
	const [outDir, ...only] = process.argv.slice(2);
	if (!outDir) {
		console.error("usage: measure.ts <outDir> [caseId ...]");
		process.exit(2);
	}
	await mkdir(outDir, { recursive: true });
	const sampler = startSampler();
	await new Promise((r) => setTimeout(r, 1500));
	const rows: unknown[] = [];

	// Setup: four input scenes at the edit canvas (not measured).
	const edCanvas = canvasForEdit(EDIT_BASE, false);
	const inputs: { name: string; seed: number }[] = [];
	const sceneSeeds: number[] = [];
	async function ensureInputs() {
		if (inputs.length) return;
		for (let i = 0; i < SCENES.length; i++) {
			const seed = freshSeed(sceneSeeds);
			sceneSeeds.push(seed);
			const r = await render("generate", false, SCENES[i], edCanvas, [], seed);
			await writeFile(join(outDir, `input-${i}.png`), r.png);
			inputs.push({ name: await upload(r.png, `measure-in-${i}.png`), seed });
		}
	}

	for (const c of MEASURE_CASES) {
		if (only.length && !only.includes(c.id)) continue;
		if (c.mode === "edit") await ensureInputs();
		if (c.id === "generate-cold") {
			await client.free();
			await new Promise((r) => setTimeout(r, 3000));
		}
		const swapBefore = swapUsedMb();
		const times: number[] = [];
		const peaks: number[] = [];
		const healthLog: string[][] = [];
		let notes = c.note ?? "";
		for (let run = 0; run < c.runs; run++) {
			const t0 = Date.now();
			let done = false;
			const poller = (async () => {
				while (!done) {
					healthLog.push(healthCodes());
					await new Promise((r) => setTimeout(r, 1000));
				}
			})();
			try {
				const images = inputs.slice(0, c.inputs).map((i) => i.name);
				let seed = freshSeed(sceneSeeds);
				if (c.id === "trap-same-seed") seed = inputs[0].seed;
				sceneSeeds.push(seed);
				const prompt =
					c.mode === "edit"
						? c.inputs > 1
							? EDITS[1]
							: EDITS[0]
						: SCENES[(run + 1) % 4];
				const transparent = c.id === "generate-transparent";
				const p = transparent ? "A red ceramic mug with a white heart" : prompt;
				if (c.id === "crash") {
					const pending = render(
						c.mode,
						false,
						p,
						c.canvas,
						images,
						seed,
					).catch((e) => e);
					await new Promise((r) => setTimeout(r, 4000));
					ssh("systemctl restart comfyui.service");
					const r = await pending;
					notes +=
						r instanceof Error
							? ` first run failed: ${r.message}`
							: " first run still returned";
					for (let i = 0; i < 60; i++) {
						try {
							await fetch(`${BASE}/system_stats`);
							break;
						} catch {
							await new Promise((r2) => setTimeout(r2, 1000));
						}
					}
				}
				const res = await render(
					c.mode,
					transparent,
					p,
					c.canvas,
					images,
					seed,
				);
				times.push(res.seconds);
				await writeFile(join(outDir, `${c.id}-${run}.png`), res.png);
			} catch (e) {
				notes += ` ERROR ${(e as Error).message}`;
			} finally {
				done = true;
				await poller;
			}
			const mine = samples.filter((s) => s.t >= t0).map((s) => s.mib);
			peaks.push(mine.length ? Math.max(...mine) : -1);
		}
		const swapAfter = swapUsedMb();
		const healthOk = healthLog.length
			? healthLog.every(
					(h) => h.length === HEALTH.length && h.every((x) => x === "200"),
				)
			: false;
		const row = {
			id: c.id,
			canvas: c.canvas,
			inputs: c.inputs,
			secondsPerRun: times.map((t) => +t.toFixed(1)),
			peakMiB: Math.max(...peaks),
			healthSamples: healthLog.length,
			healthOk,
			swapMbBefore: swapBefore,
			swapMbAfter: swapAfter,
			notes,
		};
		console.log(JSON.stringify(row));
		rows.push(row);
	}
	sampler.kill();
	await writeFile(join(outDir, "results.json"), JSON.stringify(rows, null, 2));
	client.close();
}

const invoked = process.argv[1]?.endsWith("measure.ts");
if (invoked) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
