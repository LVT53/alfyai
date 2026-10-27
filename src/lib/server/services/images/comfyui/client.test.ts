import { MessageChannel } from "node:worker_threads";
import sharp from "sharp";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type ComfyEvent,
	type ComfyGraph,
	type ComfyUiClient,
	ComfyUiError,
	createComfyUiClient,
} from "./client";
import { createFakeComfyUi, type FakeComfyUi } from "./testing/fake-comfyui";

const graph: ComfyGraph = {
	"3": { class_type: "KSampler", inputs: { seed: 7 } },
	"5": {
		class_type: "EmptyLatentImage",
		inputs: { width: 64, height: 48, batch_size: 1 },
	},
};

/**
 * The suite runs under jsdom, whose global Event is not Node's, and Node's
 * WebSocket dispatches Node Events. Borrow Node's Event for this file.
 */
beforeAll(async () => {
	const { port1, port2 } = new MessageChannel();
	const event = await new Promise<Event>((resolve) => {
		port1.addEventListener("message", (e) => resolve(e as Event), {
			once: true,
		});
		port1.start();
		port2.postMessage(1);
	});
	port1.close();
	const NodeEvent = Object.getPrototypeOf(
		Object.getPrototypeOf(event),
	).constructor;
	vi.stubGlobal("Event", NodeEvent);
});

let fake: FakeComfyUi;
const clients: ComfyUiClient[] = [];

function makeClient(
	extra: Partial<Parameters<typeof createComfyUiClient>[0]> = {},
): ComfyUiClient {
	const client = createComfyUiClient({
		baseUrl: fake.baseUrl,
		pollMs: 20,
		...extra,
	});
	clients.push(client);
	return client;
}

function follow(client: ComfyUiClient, promptId: string, deadlineMs = 5000) {
	const events: ComfyEvent[] = [];
	const result = client.follow(promptId, {
		signal: new AbortController().signal,
		deadlineMs,
		onEvent: (event) => events.push(event),
	});
	return { events, result };
}

async function waitFor(check: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

beforeEach(async () => {
	fake = await createFakeComfyUi();
});

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	await fake.close();
});

describe("ComfyUI client against the fake", () => {
	it("uploads a picture and gets its name back", async () => {
		const client = makeClient();
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const ref = await client.uploadImage(bytes, "photo.png");
		expect(ref).toEqual({
			filename: "photo.png",
			subfolder: "",
			type: "input",
		});
		expect(Array.from(fake.uploads.get("photo.png") ?? [])).toEqual([
			1, 2, 3, 4,
		]);
		const request = fake.requests.find((r) => r.path === "/upload/image");
		expect(request?.fields).toMatchObject({ type: "input", overwrite: "true" });
	});

	it("follows a prompt to its picture", async () => {
		const client = makeClient();
		const { promptId } = await client.submit(graph);
		const { events, result } = follow(client, promptId);
		const images = await result;
		expect(events.map((e) => e.type)).toEqual([
			"queued",
			"started",
			"progress",
			"progress",
			"progress",
			"progress",
			"done",
		]);
		expect(events[0]).toEqual({ type: "queued", ahead: 0 });
		expect(events.filter((e) => e.type === "progress")).toEqual(
			[1, 2, 3, 4].map((value) => ({ type: "progress", value, max: 4 })),
		);
		expect(images).toHaveLength(1);
		const bytes = await client.fetchImage(images[0]);
		expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
		const meta = await sharp(bytes).metadata();
		expect([meta.width, meta.height]).toEqual([64, 48]);
	});

	it("says how many are ahead", async () => {
		fake.holdQueue(true);
		const client = makeClient();
		await client.submit(graph);
		const b = await client.submit(graph);
		const { events, result } = follow(client, b.promptId);
		await waitFor(() => events.length > 0);
		expect(events[0]).toEqual({ type: "queued", ahead: 1 });
		expect(await client.queueSize()).toBe(2);
		fake.holdQueue(false);
		await result;
	});

	it("deletes a prompt still waiting", async () => {
		fake.holdQueue(true);
		const client = makeClient();
		const { promptId } = await client.submit(graph);
		expect(await client.cancel(promptId, { interrupt: false })).toBe("deleted");
		const queue = await (await fetch(`${fake.baseUrl}/queue`)).json();
		expect(JSON.stringify(queue)).not.toContain(promptId);
		expect(await client.cancel(promptId, { interrupt: true })).toBe(
			"not_found",
		);
	});

	it("interrupts only its own running prompt", async () => {
		fake.setOptions({ stepDelayMs: 200 });
		const other = makeClient();
		const ours = makeClient();
		await other.submit(graph);
		await waitFor(() => [...fake.prompts.values()].includes("running"));
		const mine = await ours.submit(graph);
		expect(await ours.cancel(mine.promptId, { interrupt: true })).toBe(
			"deleted",
		);
		expect(fake.requests.some((r) => r.path === "/interrupt")).toBe(false);

		// ours running: interrupt false leaves it, interrupt true interrupts
		const second = await ours.submit(graph);
		await waitFor(() => fake.prompts.get(second.promptId) === "running");
		expect(await ours.cancel(second.promptId, { interrupt: false })).toBe(
			"running",
		);
		expect(fake.requests.some((r) => r.path === "/interrupt")).toBe(false);
		expect(await ours.cancel(second.promptId, { interrupt: true })).toBe(
			"interrupted",
		);
		expect(fake.requests.filter((r) => r.path === "/interrupt")).toHaveLength(
			1,
		);
	});

	it("fails fast when the server is down", async () => {
		const dead = await createFakeComfyUi();
		const baseUrl = dead.baseUrl;
		await dead.close();
		const client = createComfyUiClient({ baseUrl });
		clients.push(client);
		const started = Date.now();
		await expect(client.submit(graph)).rejects.toMatchObject({
			code: "unreachable",
		});
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("reports a graph the server refused", async () => {
		fake.setOptions({ fail: "reject" });
		const client = makeClient();
		const error = await client.submit(graph).catch((e) => e);
		expect(error).toBeInstanceOf(ComfyUiError);
		expect(error.code).toBe("rejected");
		expect(error.detail).toEqual({
			"3": { errors: [{ type: "fake_rejection" }] },
		});
	});

	it("reports a render that failed", async () => {
		fake.setOptions({ fail: "execution" });
		const client = makeClient();
		const { promptId } = await client.submit(graph);
		await expect(follow(client, promptId).result).rejects.toMatchObject({
			code: "execution_failed",
		});
	});

	it("gives up at its deadline", async () => {
		fake.setOptions({ stepDelayMs: 1000 });
		const client = makeClient();
		const { promptId } = await client.submit(graph);
		await expect(follow(client, promptId, 200).result).rejects.toMatchObject({
			code: "timeout",
		});
	});

	it("still finishes without the socket", async () => {
		const Broken = class {
			constructor() {
				throw new Error("no sockets here");
			}
		} as unknown as typeof WebSocket;
		const client = makeClient({ webSocketImpl: Broken });
		const { promptId } = await client.submit(graph);
		const { events, result } = follow(client, promptId);
		expect(await result).toHaveLength(1);
		expect(events.some((e) => e.type === "progress")).toBe(false);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("loses a prompt the server forgot", async () => {
		fake.holdQueue(true);
		const client = makeClient();
		const { promptId } = await client.submit(graph);
		fake.restart();
		await expect(follow(client, promptId).result).rejects.toMatchObject({
			code: "missing_result",
		});
	});

	it("keeps uploads across a restart and renders the input with a mark", async () => {
		const client = makeClient();
		const photo = await sharp({
			create: { width: 50, height: 50, channels: 3, background: "#ffffff" },
		})
			.png()
			.toBuffer();
		const ref = await client.uploadImage(photo, "in.png");
		fake.restart();
		expect(fake.uploads.has("in.png")).toBe(true);
		const { promptId } = await client.submit({
			"1": { class_type: "LoadImage", inputs: { image: ref.filename } },
			"3": { class_type: "KSampler", inputs: { seed: 1 } },
		});
		const [out] = await follow(client, promptId).result;
		const { data, info } = await sharp(await client.fetchImage(out))
			.raw()
			.toBuffer({ resolveWithObject: true });
		const center =
			(info.height / 2) * info.width * info.channels +
			(info.width / 2) * info.channels;
		expect(data[center]).not.toBe(255);
		expect(data[0]).toBe(255);
	});
});
