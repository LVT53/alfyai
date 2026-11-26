// @always-run: exercises file or process inputs outside Vitest’s import graph.
// The LTX ComfyUI's daily sweep (review I-5): the units kept in
// `deploy/comfyui/` and installed on the GPU box beside the Qwen and H3
// servers' own sweeps. Every take leaves its clip (blocked and incognito ones
// included, with the prompt in its tags) and its still in the LTX server's
// own worktree, which nothing else cleans.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIDEO_RENDER_DEADLINE_MS } from "$lib/server/services/images/video/request";

const DIR = join(process.cwd(), "deploy", "comfyui");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

/** The value of a `Key=value` line of a unit file. */
function setting(unit: string, key: string): string | null {
	const line = unit
		.split("\n")
		.find((entry) => entry.trim().startsWith(`${key}=`));
	return line ? line.trim().slice(key.length + 1) : null;
}

describe("the LTX ComfyUI's daily sweep", () => {
	it("deletes the LTX worktree's inputs, outputs and temp files older than a day, as the server's own user", () => {
		const service = read("comfyui-ltx-clean.service");
		expect(setting(service, "Type")).toBe("oneshot");
		expect(setting(service, "User")).toBe("alfyws");
		const command = setting(service, "ExecStart") ?? "";
		const [binary, ...args] = command.split(/\s+/);
		expect(binary).toBe("/usr/bin/find");
		for (const folder of ["input", "output", "temp"]) {
			expect(args).toContain(`/home/alfyws/opt/comfyui-ltx/${folder}`);
		}
		// Only the LTX server's own files: never another worktree.
		expect(args.filter((arg) => arg.startsWith("/"))).toEqual([
			"/home/alfyws/opt/comfyui-ltx/input",
			"/home/alfyws/opt/comfyui-ltx/output",
			"/home/alfyws/opt/comfyui-ltx/temp",
		]);
		expect(args).toEqual(expect.arrayContaining(["-type", "f", "-delete"]));
		const minutes = Number(args[args.indexOf("-mmin") + 1]?.replace("+", ""));
		expect(minutes).toBe(24 * 60);
		// A take that resumes after a restart fetches its saved clip from the
		// server's output: the sweep never reaches a file a live take can still
		// need.
		expect(minutes * 60_000).toBeGreaterThan(VIDEO_RENDER_DEADLINE_MS);
	});

	it("runs once a day, and catches up a day the box was off", () => {
		// As the box's own comfyui-clean.timer and comfyui-h3-clean.timer: the
		// timer starts the service of its own name (no `Unit=`).
		const timer = read("comfyui-ltx-clean.timer");
		expect(setting(timer, "OnCalendar")).toBe("daily");
		expect(setting(timer, "Persistent")).toBe("true");
		expect(setting(timer, "Unit")).toBeNull();
		expect(setting(timer, "WantedBy")).toBe("timers.target");
	});
});
