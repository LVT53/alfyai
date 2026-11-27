// @always-run: boots the runner bundled from its Node entry point by the Vite asset plugin
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { GET } from "./+server";

it("boots a standalone private helper, rotates its setup link on restart and signs in through Chromium with public PKCE", async () => {
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
	let stdout = "";
	const syntheticPoll = join(dir, "synthetic-poll.mjs");
	await writeFile(
		syntheticPoll,
		'globalThis.fetch = async (url) => String(url) === "https://ai.alfydesign.com/api/connections/bosch/poll" ? Response.json({ requestId: null }) : new Response(null, {status: 503});',
	);
	function start() {
		const child = execFile(
			process.execPath,
			["--import", syntheticPoll, script, "--service"],
			{
				env: {
					...process.env,
					ALFYAI_BOSCH_STATE_DIR: dir,
					ALFYAI_BOSCH_PORT: String(port),
					ALFYAI_BOSCH_BROWSER_PORT: String(port),
				},
			},
		);
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		return child;
	}
	async function setupLink(previous = "") {
		for (let i = 0; i < 80; i++) {
			const value = await readFile(join(dir, "setup-url"), "utf8").catch(
				() => "",
			);
			if (value && value !== previous) return value;
			await sleep(25);
		}
		throw Error("Helper did not publish its new setup link");
	}
	let child = start();
	try {
		const original = await setupLink();
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		await exited;
		child = start();
		const launch = await setupLink(original);
		expect((await fetch(original.trim(), { redirect: "manual" })).status).toBe(
			403,
		);
		expect(stdout).not.toContain("?start=");
		expect((await stat(join(dir, "setup-url"))).mode & 0o077).toBe(0);
		const browser = await chromium.launch({
			args: [
				"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
				"--no-proxy-server",
			],
		});
		try {
			const tab = await browser.newPage();
			const cdp = await tab.context().newCDPSession(tab);
			const external: URL[] = [];
			const outbound: {
				method: string;
				referrer: string | null;
				hasBody: boolean;
			}[] = [];
			await cdp.send("Fetch.enable", {
				patterns: [{ urlPattern: "https://*" }],
			});
			cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
				const url = new URL(request.url);
				external.push(url);
				outbound.push({
					method: request.method,
					referrer: new Headers(request.headers).get("referer"),
					hasBody: !!request.hasPostData,
				});
				const isBosch = url.hostname === "p9.authz.bosch.com";
				await cdp.send("Fetch.fulfillRequest", {
					requestId,
					responseCode: isBosch ? 302 : 200,
					responseHeaders: isBosch
						? [
								{
									name: "Location",
									value: "https://identity.example.test/login",
								},
							]
						: [{ name: "Content-Type", value: "text/plain" }],
					body: Buffer.from(
						isBosch ? "" : "Synthetic identity provider",
					).toString("base64"),
				});
			});
			await tab.goto(launch.trim());
			const origin = new URL(launch.trim()).origin;
			expect(tab.url()).toBe(`${origin}/`);
			const csrf = await tab.locator('[name="csrf"]').inputValue();
			const pairing = `synthetic.rider.${"s".repeat(43)}`;
			for (const rejectedOrigin of ["null", "https://foreign.example.test"]) {
				const denied = await tab.request.post(`${origin}/authorize`, {
					headers: { origin: rejectedOrigin },
					form: { csrf, pairing, clientId: "synthetic" },
					maxRedirects: 0,
				});
				expect(denied.status()).toBe(403);
			}
			await tab.locator('[name="pairing"]').fill(pairing);
			await tab.locator('[name="clientId"]').fill("synthetic");
			expect(await tab.locator('[name="clientSecret"]').inputValue()).toBe("");
			const [post] = await Promise.all([
				tab.waitForResponse(
					(r) =>
						r.url() === `${origin}/authorize` &&
						r.request().method() === "POST",
				),
				tab.getByRole("button", { name: "Sign in with Bosch" }).click(),
			]);
			expect(await post.request().headerValue("origin")).toBe(origin);
			expect(post.status()).toBe(200);
			await tab.waitForURL("https://identity.example.test/login");
			expect(external.map((url) => url.hostname)).toEqual([
				"p9.authz.bosch.com",
				"identity.example.test",
			]);
			expect(outbound).toEqual(
				Array(2).fill({ method: "GET", referrer: null, hasBody: false }),
			);
			expect(external[0].searchParams.get("code_challenge_method")).toBe(
				"S256",
			);
			expect(external[0].searchParams.get("code_challenge")).toMatch(
				/^[\w-]{43}$/,
			);
			expect(external[0].searchParams.has("client_secret")).toBe(false);
			// A previously paired rider can upgrade and see confirmation in the
			// actual distributed executable, then reopen it to view the saved grant.
			const priorLink = await readFile(join(dir, "setup-url"), "utf8");
			const stopped = once(child, "exit");
			child.kill("SIGTERM");
			await stopped;
			await writeFile(
				join(dir, "credentials.json"),
				JSON.stringify({
					client: { clientId: "synthetic" },
					pairing,
					refreshToken: "synthetic",
					onDemand: true,
				}),
				{ mode: 0o600 },
			);
			child = start();
			await tab.goto((await setupLink(priorLink)).trim());
			const status = tab.getByRole("status");
			expect(await status.textContent()).toBe(
				"Only bike names and ride summaries are enabled.",
			);
			await Promise.all([
				tab.waitForNavigation(),
				tab.getByRole("button", { name: "Allow all supported data" }).click(),
			]);
			expect(await status.textContent()).toBe(
				"Permissions saved. All supported data is enabled.",
			);
			await tab.reload();
			expect(await status.textContent()).toBe("All supported data is enabled.");
		} finally {
			await browser.close();
		}
	} finally {
		child.kill("SIGTERM");
		await rm(dir, { recursive: true, force: true });
	}
});
