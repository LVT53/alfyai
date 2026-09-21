// Parse bundles had a per-DOCUMENT cap (`MINERU_BUNDLE_MAX_BYTES`, 32 MiB) and
// no total at all: a user could park unbounded gigabytes on the box one 32 MiB
// bundle at a time, and nothing anywhere would notice.
//
// A bundle is DERIVED data — the normalized text is in the database and
// "Re-extract" rebuilds one — so `MINERU_BUNDLE_USER_QUOTA_BYTES` is met by
// throwing the cheapest thing away first: other documents' figures, then whole
// bundles, least-recently-written first, and never the bundle just written.
//
// Real directories under `data/knowledge/`, because "how many bytes is this"
// and "is the reader safe against a concurrent removal" are properties of the
// filesystem, not of a mock.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	enforceMineruParseBundleQuota,
	MINERU_BUNDLE_IMAGES_DIR,
	MINERU_BUNDLE_MANIFEST,
	MINERU_BUNDLE_MARKDOWN,
	MINERU_BUNDLE_PAGES,
	MINERU_BUNDLE_STRUCTURED_CONTENT,
	MINERU_BUNDLE_TMP_INFIX,
	mineruBundleDir,
	readMineruFigure,
	readMineruNormalizedMarkdown,
	readMineruPageIndex,
	readMineruParseManifest,
} from "./bundle";

let userId: string;

beforeEach(() => {
	userId = `quota-user-${randomUUID()}`;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
});

/**
 * A bundle of a known size, written `ageMs` ago.
 *
 * Hand-built rather than produced through `writeMineruParseBundle`, because
 * these cases are about BYTES and AGE and the fixture zip gives neither a
 * choice. The layout is the documented one, so every reader in the module
 * treats it as a real bundle.
 */
async function seedBundle(params: {
	sourceArtifactId: string;
	textBytes: number;
	imageBytes: number;
	ageMs: number;
}): Promise<string> {
	const dir = mineruBundleDir(userId, params.sourceArtifactId);
	await mkdir(join(dir, MINERU_BUNDLE_IMAGES_DIR), { recursive: true });
	await writeFile(
		join(dir, MINERU_BUNDLE_MARKDOWN),
		"x".repeat(params.textBytes),
		"utf8",
	);
	await writeFile(join(dir, MINERU_BUNDLE_PAGES), "[]", "utf8");
	await writeFile(join(dir, MINERU_BUNDLE_STRUCTURED_CONTENT), "{}", "utf8");
	if (params.imageBytes > 0) {
		await writeFile(
			join(dir, MINERU_BUNDLE_IMAGES_DIR, "fig-1.jpg"),
			Buffer.alloc(params.imageBytes, 1),
		);
	}
	await writeFile(
		join(dir, MINERU_BUNDLE_MANIFEST),
		JSON.stringify({
			version: 1,
			sourceArtifactId: params.sourceArtifactId,
			normalizedArtifactId: null,
			createdAt: new Date().toISOString(),
			parserVersion: "4.0.4",
			producerVersion: null,
			serverParserVersion: "4.0.4",
			effectiveTier: "basic",
			jobTier: "basic",
			parseMode: null,
			pageCount: 1,
			pageCountKind: "exact",
			markdownBytes: params.textBytes,
			markdownSha256: "0".repeat(64),
			figures: [{ path: "images/fig-1.jpg", page: 1, index: 0 }],
			imagesOmitted: false,
			totalBytes: params.textBytes + params.imageBytes,
			stats: {},
		}),
		"utf8",
	);

	// The eviction order is "least recently WRITTEN", which is the bundle
	// directory's own mtime — set here rather than waiting real seconds.
	const when = new Date(Date.now() - params.ageMs);
	const { utimes } = await import("node:fs/promises");
	await utimes(dir, when, when);
	return dir;
}

async function bundleBytes(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += await bundleBytes(path);
			continue;
		}
		total += (await stat(path)).size;
	}
	return total;
}

describe("enforceMineruParseBundleQuota", () => {
	it("does nothing when the quota is 0 — unlimited, as before the key existed", async () => {
		const old = await seedBundle({
			sourceArtifactId: randomUUID(),
			textBytes: 1_000,
			imageBytes: 500_000,
			ageMs: 100_000,
		});
		const fresh = randomUUID();
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 1_000,
			imageBytes: 500_000,
			ageMs: 0,
		});

		const result = await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 0,
		});

		expect(result).toBeNull();
		expect(existsSync(join(old, MINERU_BUNDLE_IMAGES_DIR, "fig-1.jpg"))).toBe(
			true,
		);
	});

	it("does nothing while the user is under the quota", async () => {
		const fresh = randomUUID();
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 100,
			imageBytes: 1_000,
			ageMs: 0,
		});

		expect(
			await enforceMineruParseBundleQuota({
				userId,
				keepSourceArtifactId: fresh,
				quotaBytes: 10_000_000,
			}),
		).toBeNull();
	});

	it("drops the oldest bundle's figures first and keeps its text", async () => {
		const oldest = randomUUID();
		const middle = randomUUID();
		const fresh = randomUUID();
		const oldestDir = await seedBundle({
			sourceArtifactId: oldest,
			textBytes: 1_000,
			imageBytes: 400_000,
			ageMs: 300_000,
		});
		await seedBundle({
			sourceArtifactId: middle,
			textBytes: 1_000,
			imageBytes: 400_000,
			ageMs: 200_000,
		});
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 1_000,
			imageBytes: 400_000,
			ageMs: 0,
		});

		// Over by roughly one bundle's figures.
		const result = await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 900_000,
		});

		expect(result).not.toBeNull();
		expect(result?.imagesEvicted).toBe(1);
		expect(result?.bundlesRemoved).toBe(0);
		expect(result?.usedBytesAfter).toBeLessThanOrEqual(900_000);

		// The oldest lost its figures...
		expect(
			existsSync(join(oldestDir, MINERU_BUNDLE_IMAGES_DIR, "fig-1.jpg")),
		).toBe(false);
		// ...and kept everything a citation or a page read needs.
		expect(await readMineruNormalizedMarkdown(userId, oldest)).toHaveLength(
			1_000,
		);
		expect(await readMineruPageIndex(userId, oldest)).toEqual([]);
		const manifest = await readMineruParseManifest(userId, oldest);
		expect(manifest?.imagesEvicted).toBe(true);
		// The manifest's figure list is the endpoint's allow-list AND what any
		// surface enumerating figures reads, so an evicted bundle advertises
		// none rather than a list that 404s one by one.
		expect(manifest?.figures).toEqual([]);
		expect(
			await readMineruFigure({
				userId,
				sourceArtifactId: oldest,
				name: "fig-1.jpg",
			}),
		).toBeNull();

		// The middle one, being newer, was not touched.
		expect(
			existsSync(
				join(
					mineruBundleDir(userId, middle),
					MINERU_BUNDLE_IMAGES_DIR,
					"fig-1.jpg",
				),
			),
		).toBe(true);
	});

	it("removes whole bundles, oldest first, when figures are not enough", async () => {
		const oldest = randomUUID();
		const middle = randomUUID();
		const fresh = randomUUID();
		await seedBundle({
			sourceArtifactId: oldest,
			textBytes: 300_000,
			imageBytes: 10,
			ageMs: 300_000,
		});
		await seedBundle({
			sourceArtifactId: middle,
			textBytes: 300_000,
			imageBytes: 10,
			ageMs: 200_000,
		});
		const freshDir = await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 300_000,
			imageBytes: 10,
			ageMs: 0,
		});

		const result = await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 650_000,
		});

		expect(result?.bundlesRemoved).toBe(1);
		expect(existsSync(mineruBundleDir(userId, oldest))).toBe(false);
		expect(existsSync(mineruBundleDir(userId, middle))).toBe(true);
		expect(existsSync(freshDir)).toBe(true);
	});

	it("never evicts the bundle that was just written, however old the rest are", async () => {
		const fresh = randomUUID();
		// The fresh bundle is also, deliberately, the oldest on disk: a real
		// re-extract can rewrite a bundle whose directory keeps an older mtime
		// on some filesystems, and "keep what was just written" must not depend
		// on it winning a timestamp comparison.
		const freshDir = await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 500_000,
			imageBytes: 100,
			ageMs: 900_000,
		});
		const other = randomUUID();
		await seedBundle({
			sourceArtifactId: other,
			textBytes: 500_000,
			imageBytes: 100,
			ageMs: 0,
		});

		await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 600_000,
		});

		expect(existsSync(freshDir)).toBe(true);
		expect(await readMineruNormalizedMarkdown(userId, fresh)).toHaveLength(
			500_000,
		);
	});

	it("accounts by real directory size, not by the manifest's claim", async () => {
		const fresh = randomUUID();
		const other = randomUUID();
		const otherDir = await seedBundle({
			sourceArtifactId: other,
			textBytes: 1_000,
			imageBytes: 400_000,
			ageMs: 100_000,
		});
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 1_000,
			imageBytes: 1_000,
			ageMs: 0,
		});

		// A manifest that lies about its size — the accounting must ignore it.
		await writeFile(
			join(otherDir, MINERU_BUNDLE_MANIFEST),
			JSON.stringify({ version: 1, totalBytes: 1 }),
			"utf8",
		);

		const result = await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 100_000,
		});

		expect(result?.usedBytesBefore).toBeGreaterThan(400_000);
		expect(result?.freedBytes).toBeGreaterThan(0);
		expect(await bundleBytes(otherDir).catch(() => 0)).toBeLessThan(400_000);
	});

	it("leaves nothing half-removed for a concurrent figure read to trip on", async () => {
		const fresh = randomUUID();
		const other = randomUUID();
		await seedBundle({
			sourceArtifactId: other,
			textBytes: 1_000,
			imageBytes: 400_000,
			ageMs: 100_000,
		});
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 1_000,
			imageBytes: 1_000,
			ageMs: 0,
		});

		const [read] = await Promise.all([
			readMineruFigure({
				userId,
				sourceArtifactId: other,
				name: "fig-1.jpg",
			}),
			enforceMineruParseBundleQuota({
				userId,
				keepSourceArtifactId: fresh,
				quotaBytes: 100_000,
			}),
		]);

		// Either the whole file or nothing — never a truncated stream. A later
		// read, after the eviction, is null, which is what the endpoint turns
		// into a 404.
		if (read) expect(read.bytes).toBe(400_000);
		expect(
			await readMineruFigure({
				userId,
				sourceArtifactId: other,
				name: "fig-1.jpg",
			}),
		).toBeNull();

		// And no parked directory is left behind under a name the disk report
		// or the temp sweep would not recognise.
		const remaining = await readdir(
			join(process.cwd(), "data", "knowledge", userId),
		);
		for (const name of remaining) {
			expect(
				name.endsWith(".parse") || name.includes(MINERU_BUNDLE_TMP_INFIX),
				name,
			).toBe(true);
		}
	});

	it("bounds the work it does per write", async () => {
		const fresh = randomUUID();
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 1_000,
			imageBytes: 1_000,
			ageMs: 0,
		});
		for (let index = 0; index < 5; index += 1) {
			await seedBundle({
				sourceArtifactId: randomUUID(),
				textBytes: 100_000,
				imageBytes: 10,
				ageMs: 10_000 * (index + 1),
			});
		}

		const result = await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 1_000,
			maxExamined: 3,
		});

		// Three: the fresh one plus the two oldest others.
		expect(result?.examined).toBe(3);
	});

	it("logs counts and bytes, and nothing that identifies a document", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const fresh = randomUUID();
		const other = randomUUID();
		await seedBundle({
			sourceArtifactId: other,
			textBytes: 1_000,
			imageBytes: 400_000,
			ageMs: 100_000,
		});
		await seedBundle({
			sourceArtifactId: fresh,
			textBytes: 1_000,
			imageBytes: 1_000,
			ageMs: 0,
		});

		await enforceMineruParseBundleQuota({
			userId,
			keepSourceArtifactId: fresh,
			quotaBytes: 100_000,
		});

		const lines = info.mock.calls.filter(
			(call) => call[0] === "[MINERU] Parse bundle quota enforced",
		);
		expect(lines).toHaveLength(1);
		const payload = JSON.stringify(lines[0]?.[1]);
		expect(payload).not.toContain(other);
		expect(payload).not.toContain(fresh);
		expect(payload).not.toContain(userId);
		expect(lines[0]?.[1]).toMatchObject({
			quotaBytes: 100_000,
			imagesEvicted: 1,
		});
	});
});
