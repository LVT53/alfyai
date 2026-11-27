import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	type BoschLocalCredential,
	createBoschRunner,
} from "./bosch-flow-runner";

const service = process.argv.slice(2).includes("--service");
const configuredDir =
	process.env.ALFYAI_BOSCH_STATE_DIR ?? process.env.STATE_DIRECTORY;
const directory = service
		? (configuredDir ?? "")
		: join(homedir(), ".alfyai-bosch"),
	file = join(directory, "credentials.json");
const isMissing = (e: unknown) =>
	typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
async function secureDirectory(create: boolean) {
	if (create)
		await mkdir(directory, { mode: 0o700 }).catch((e) => {
			if (e.code !== "EEXIST") throw e;
		});
	const info = await lstat(directory);
	if (
		!info.isDirectory() ||
		info.uid !== process.getuid?.() ||
		info.mode & 0o077
	)
		throw Error("Unsafe credential directory");
}
async function load(): Promise<BoschLocalCredential | null> {
	try {
		await secureDirectory(false);
		const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await f.stat();
			if (
				!stat.isFile() ||
				stat.uid !== process.getuid?.() ||
				stat.mode & 0o077 ||
				stat.size > 16384
			)
				throw Error("Unsafe credential file");
			const data = JSON.parse(await f.readFile("utf8"));
			if (
				typeof data.client?.clientId !== "string" ||
				typeof data.pairing !== "string" ||
				typeof data.refreshToken !== "string" ||
				(data.client.clientSecret !== undefined &&
					typeof data.client.clientSecret !== "string")
			)
				throw Error("Invalid saved setup");
			return data;
		} finally {
			await f.close();
		}
	} catch (e) {
		if (isMissing(e)) return null;
		throw e;
	}
}
async function persist(value: BoschLocalCredential | null) {
	await secureDirectory(true);
	if (!value) {
		await unlink(file).catch((e) => {
			if (!isMissing(e)) throw e;
		});
		return;
	}
	await privateWrite(file, JSON.stringify(value));
}
async function privateWrite(destination: string, value: string) {
	const tmp = join(directory, `${randomUUID()}.tmp`);
	const out = await open(tmp, "wx", 0o600);
	try {
		try {
			await out.writeFile(value);
			await out.sync();
		} finally {
			await out.close();
		}
		await rename(tmp, destination);
	} finally {
		await unlink(tmp).catch((e) => {
			if (!isMissing(e)) throw e;
		});
	}
}
async function main() {
	if (Number(process.versions.node.split(".")[0]) < 22)
		throw Error("Node.js 22 or later is required.");
	const privateFiles =
		typeof process.getuid === "function" && process.platform !== "win32";
	if (service && (!privateFiles || !isAbsolute(directory)))
		throw Error("A private state directory is required.");
	const listenPort = service
		? Number(process.env.ALFYAI_BOSCH_PORT ?? 47831)
		: 47831;
	const browserPort = service
		? Number(process.env.ALFYAI_BOSCH_BROWSER_PORT ?? 47831)
		: 47831;
	if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535)
		throw Error("Invalid listen port");
	const browserOrigin = `http://127.0.0.1:${browserPort}`;
	const session = createBoschRunner({
		service,
		browserPort,
		...(privateFiles ? { saved: await load(), persist } : {}),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	async function poll() {
		const delay = await session.pollOnce().catch(() => 10000);
		timer = setTimeout(poll, delay);
		timer.unref();
	}
	if (service) await secureDirectory(true);
	const server = createServer(
		{ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 },
		async (req, res) => {
			try {
				if (
					!req.url?.startsWith("/") ||
					req.url.startsWith("//") ||
					req.headers.host !== new URL(browserOrigin).host
				) {
					res.writeHead(403).end();
					return;
				}
				if (req.method !== "GET" && req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					if (size > 16384) {
						res.writeHead(413).end();
						return;
					}
					chunks.push(chunk);
				}
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers))
					if (typeof v === "string") headers.set(k, v);
				const response = await session.handle(
					new Request(browserOrigin + req.url, {
						method: req.method,
						headers,
						...(req.method === "POST"
							? { body: Buffer.concat(chunks).toString("utf8") }
							: {}),
					}),
				);
				if (service && response.headers.has("set-cookie"))
					await privateWrite(
						join(directory, "setup-url"),
						`${session.renewLaunchUrl()}\n`,
					);
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				res
					.writeHead(400, { "Cache-Control": "no-store" })
					.end("Invalid local request.");
			}
		},
	);
	server.on("error", () => {
		console.error(
			"The local runner could not start. Check the configured loopback port.",
		);
		process.exitCode = 1;
	});
	server.on("close", () => {
		if (timer) clearTimeout(timer);
	});
	server.listen(listenPort, "127.0.0.1", () => {
		if (service) {
			void privateWrite(join(directory, "setup-url"), `${session.launchUrl}\n`)
				.then(() => {
					console.log(
						"Bosch runner ready. The private setup link is in the rider state directory.",
					);
					void poll();
				})
				.catch(() => {
					console.error("Could not write a private setup link.");
					process.exitCode = 1;
					server.close();
				});
		} else {
			console.log(
				`Open this private setup link in your browser:\n${session.launchUrl}\nPress Ctrl+C to stop.`,
			);
			void poll();
		}
	});
}
void main().catch(() => {
	console.error(
		"Could not start. Use Node.js 22 or later and check access to your private ~/.alfyai-bosch directory.",
	);
	process.exitCode = 1;
});
