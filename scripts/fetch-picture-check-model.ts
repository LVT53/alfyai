#!/usr/bin/env tsx
/**
 * Puts the explicit-picture filter's model file where the app reads it
 * (PICTURE_CHECK_MODEL.path, under data/, which deploys share across releases).
 * Idempotent: a file already there that hashes to the pin is kept; anything
 * else is downloaded from the pinned revision, checked against the pinned
 * SHA-256 and only then moved into place.
 *
 * Run: npm run models:fetch
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { PICTURE_CHECK_MODEL } from "../src/lib/server/services/images/picture-check/model";

async function sha256Of(path: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}

export async function fetchPictureCheckModel(input: {
	url: string;
	sha256: string;
	bytes: number;
	dest: string;
	fetchImpl?: typeof fetch;
}): Promise<"present" | "fetched"> {
	const { url, sha256, bytes, dest } = input;
	const existing = await stat(dest).catch(() => null);
	if (existing?.isFile() && existing.size === bytes) {
		if ((await sha256Of(dest)) === sha256) return "present";
	}
	await mkdir(dirname(dest), { recursive: true });
	const partial = `${dest}.partial`;
	try {
		const response = await (input.fetchImpl ?? fetch)(url, {
			redirect: "follow",
		});
		if (!response.ok || !response.body) {
			throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
		}
		await pipeline(
			Readable.fromWeb(
				response.body as import("node:stream/web").ReadableStream,
			),
			createWriteStream(partial),
		);
		const digest = await sha256Of(partial);
		if (digest !== sha256) {
			throw new Error(
				`The downloaded file does not match the pinned SHA-256 (got ${digest}, want ${sha256}).`,
			);
		}
		await rename(partial, dest);
		return "fetched";
	} finally {
		await rm(partial, { force: true });
	}
}

const isMain =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const dest = resolve(process.cwd(), PICTURE_CHECK_MODEL.path);
	fetchPictureCheckModel({ ...PICTURE_CHECK_MODEL, dest }).then(
		(outcome) => {
			console.log(
				outcome === "present"
					? `Picture check model already in place: ${dest}`
					: `Picture check model fetched and verified: ${dest}`,
			);
		},
		(error: unknown) => {
			console.error(
				"Could not fetch the picture check model:",
				error instanceof Error ? error.message : error,
			);
			process.exit(1);
		},
	);
}
