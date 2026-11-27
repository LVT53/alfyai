// @always-run: boots the runner bundled from its Node entry point by the Vite asset plugin
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { GET } from "./+server";

it("serves a standalone ESM download which boots a local unauthenticated rider instance without logging its setup key", async () => {
	const event = (user: unknown) =>
		({ locals: { user } }) as Parameters<typeof GET>[0];
	expect((await GET(event(null))).status).toBe(401);
	const r = await GET(event({ id: "user" }));
	expect(r.headers.get("Content-Disposition")).toContain("alfyai-bosch.mjs");
	const bytes = await r.text();
	expect(bytes).not.toContain('from "./bosch');
	expect(bytes).toContain(
		"https://ai.alfydesign.com/api/connections/bosch/sync",
	);
	const dir = await mkdtemp(join(tmpdir(), "alfyai-bosch-test-"));
	const script = join(dir, "alfyai-bosch.mjs");
	const chooser = createServer();
	await new Promise<void>((resolve) => chooser.listen(0, "127.0.0.1", resolve));
	const addr = chooser.address();
	if (!addr || typeof addr === "string") throw Error("no port");
	await new Promise<void>((resolve) => chooser.close(() => resolve()));
	const port = addr.port;
	await writeFile(script, bytes);
	const child = execFile(process.execPath, [script, "--service"], {
		env: {
			...process.env,
			ALFYAI_BOSCH_STATE_DIR: dir,
			ALFYAI_BOSCH_PORT: String(port),
			ALFYAI_BOSCH_BROWSER_PORT: String(port),
		},
	});
	let stdout = "";
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	try {
		let launch = "";
		for (let i = 0; i < 80 && !launch; i++) {
			launch = await readFile(join(dir, "setup-url"), "utf8").catch(() => "");
			if (!launch) await sleep(25);
		}
		expect(launch.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?start=/);
		expect(stdout).not.toContain("?start=");
		expect((await stat(join(dir, "setup-url"))).mode & 0o077).toBe(0);
		const start = await fetch(launch.trim(), { redirect: "manual" });
		expect(start.status).toBe(303);
		const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
		const page = await fetch(new URL("/", launch.trim()), {
			headers: { cookie },
		});
		expect(await page.text()).toContain("Sign in with Bosch");
	} finally {
		child.kill("SIGTERM");
		await rm(dir, { recursive: true, force: true });
	}
});
