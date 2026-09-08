import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDockerodeRegionDocker } from "./region-docker";

// A dockerode stand-in whose exec stream ends early (the proxy dropped the
// attach) while the command keeps running for a few more inspect() calls.
function fakeDocker(
	inspections: Array<{ Running: boolean; ExitCode: number | null }>,
) {
	const inspect = vi.fn(async () => {
		const next = inspections.shift();
		if (!next) throw new Error("inspect called more times than scripted");
		return next;
	});
	const start = vi.fn(async () => {
		const stream = new EventEmitter();
		setTimeout(() => {
			stream.emit("data", Buffer.from("\u0001\0\0\0\0\0\0\u0005hello"));
			stream.emit("end");
		}, 0);
		return stream;
	});
	const exec = vi.fn(async () => ({ start, inspect }));
	const docker = {
		getContainer: () => ({ exec }),
	} as unknown as Parameters<typeof createDockerodeRegionDocker>[0];
	return { docker, inspect };
}

describe("createDockerodeRegionDocker exec", () => {
	it("keeps polling a still-running exec after the attach stream ends and returns its real exit code", async () => {
		const { docker, inspect } = fakeDocker([
			{ Running: true, ExitCode: null },
			{ Running: true, ExitCode: null },
			{ Running: false, ExitCode: 0 },
		]);
		const sleep = vi.fn(async () => {});
		const region = createDockerodeRegionDocker(docker, sleep);

		const result = await region.exec("nominatim", ["nominatim", "add-data"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("hello");
		expect(inspect).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("returns a non-zero exit code straight away when the command already finished", async () => {
		const { docker, inspect } = fakeDocker([{ Running: false, ExitCode: 3 }]);
		const sleep = vi.fn(async () => {});
		const region = createDockerodeRegionDocker(docker, sleep);

		const result = await region.exec("nominatim", ["false"]);

		expect(result.exitCode).toBe(3);
		expect(inspect).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});
