// The MinerU watchdog kept in `deploy/mineru/` and run on the GPU box by
// `mineru42-watchdog.timer`. MinerU 4.2.3's hang guard (`--task-timeout`)
// leaves the server answering 503 `task_timeout` on `/v1/health` and on every
// new task until the process restarts, and the server never exits, so
// systemd's `Restart=` never fires; a dead engine does the same with
// `engine_dead`. The script restarts the unit for those two answers and for
// nothing else. It runs here against a local health endpoint and a stand-in
// `systemctl` and `logger` on PATH, so nothing on this machine is touched.
import { execFile } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "deploy", "mineru", "mineru-watchdog.sh");

let dir: string;
let server: Server | null = null;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mineru-watchdog-"));
	// `systemctl is-active --quiet <unit>`: exit 0 when $FAKE_ACTIVE is "yes".
	// `systemctl show -p ActiveEnterTimestampMonotonic --value <unit>`: a time
	// $FAKE_UP_S seconds ago, on the same clock the script reads.
	// `systemctl restart <unit>`: recorded.
	writeFileSync(
		join(dir, "systemctl"),
		`#!/bin/bash
echo "$*" >> "$FAKE_LOG/systemctl.calls"
case "$1" in
  is-active) [ "$FAKE_ACTIVE" = yes ] ;;
  show) python3 -I -c 'import os, time; print(int((time.monotonic() - float(os.environ["FAKE_UP_S"])) * 1_000_000))' ;;
  restart) exit 0 ;;
  *) exit 1 ;;
esac
`,
	);
	writeFileSync(
		join(dir, "logger"),
		`#!/bin/bash
echo "$*" >> "$FAKE_LOG/logger.lines"
`,
	);
	chmodSync(join(dir, "systemctl"), 0o755);
	chmodSync(join(dir, "logger"), 0o755);
});

afterEach(async () => {
	await new Promise<void>((resolve) =>
		server ? server.close(() => resolve()) : resolve(),
	);
	server = null;
	rmSync(dir, { recursive: true, force: true });
});

/** A health endpoint that answers every request with this status and body. */
async function health(status: number, body: string): Promise<string> {
	server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(body);
	});
	await new Promise<void>((resolve) =>
		server?.listen(0, "127.0.0.1", () => resolve()),
	);
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}/v1/health`;
}

/** An address nothing listens on: the server is down or still starting. */
async function nothingListening(): Promise<string> {
	const url = await health(200, "{}");
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = null;
	return url;
}

function sticky(code: string): string {
	return JSON.stringify({
		error: { code, message: "refused until restarted" },
	});
}

async function run(
	url: string,
	options: { active?: boolean; upSeconds?: number } = {},
): Promise<{ code: number; restarts: string[]; logged: string[] }> {
	const code = await new Promise<number>((resolve) => {
		execFile(
			"bash",
			[SCRIPT],
			{
				env: {
					PATH: `${dir}:${process.env.PATH}`,
					HOME: dir,
					FAKE_LOG: dir,
					FAKE_ACTIVE: options.active === false ? "no" : "yes",
					FAKE_UP_S: String(options.upSeconds ?? 3600),
					MINERU_WATCHDOG_UNIT: "mineru42.service",
					MINERU_WATCHDOG_URL: url,
				},
				timeout: 20_000,
			},
			(error) => resolve(error ? Number(error.code ?? 1) : 0),
		);
	});
	const lines = (name: string) => {
		try {
			return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
	return {
		code,
		restarts: lines("systemctl.calls").filter((call) =>
			call.startsWith("restart"),
		),
		logged: lines("logger.lines"),
	};
}

describe("the MinerU watchdog", () => {
	it.each(["task_timeout", "engine_dead"])(
		"restarts the unit that answers 503 %s, and says so in the journal",
		async (code) => {
			const result = await run(await health(503, sticky(code)));
			expect(result.code).toBe(0);
			expect(result.restarts).toEqual(["restart mineru42.service"]);
			expect(result.logged.join("\n")).toContain(code);
		},
	);

	it.each([
		[
			"a healthy server",
			200,
			JSON.stringify({ status: "ok", version: "4.2.3" }),
		],
		// The engine health monitor's answer clears by itself (4.2.2+).
		["a 503 that clears by itself", 503, sticky("engine_unavailable")],
		["a server that is stopping", 503, sticky("server_shutting_down")],
		["a 503 that is not MinerU's", 503, "<html>Service Unavailable</html>"],
		["a 500", 500, sticky("task_timeout")],
	] as const)("leaves %s alone", async (_label, status, body) => {
		const result = await run(await health(status, body));
		expect(result.code).toBe(0);
		expect(result.restarts).toEqual([]);
	});

	it("leaves a server that does not answer to systemd: down, or still starting", async () => {
		const result = await run(await nothingListening());
		expect(result.code).toBe(0);
		expect(result.restarts).toEqual([]);
	});

	it("leaves a unit that is not running alone", async () => {
		const result = await run(await health(503, sticky("task_timeout")), {
			active: false,
		});
		expect(result.code).toBe(0);
		expect(result.restarts).toEqual([]);
	});

	it("does not restart a unit that came up less than five minutes ago, and says why", async () => {
		// A server whose engine dies again at once needs a person, not a restart
		// every minute.
		const result = await run(await health(503, sticky("engine_dead")), {
			upSeconds: 120,
		});
		expect(result.code).toBe(0);
		expect(result.restarts).toEqual([]);
		expect(result.logged.join("\n")).toMatch(/engine_dead/);
	});

	it("restarts again once the unit has been up five minutes", async () => {
		const result = await run(await health(503, sticky("task_timeout")), {
			upSeconds: 301,
		});
		expect(result.restarts).toEqual(["restart mineru42.service"]);
	});
});
