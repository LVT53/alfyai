// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillHasAlpha } from "./backfill-has-alpha";

let dir: string;

async function rgba(alphaAt: (i: number) => number): Promise<Buffer> {
	const data = Buffer.alloc(16 * 16 * 4, 120);
	for (let i = 0; i < 16 * 16; i++) data[i * 4 + 3] = alphaAt(i);
	return sharp(data, { raw: { width: 16, height: 16, channels: 4 } })
		.png()
		.toBuffer();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "backfill-alpha-"));
	await mkdir(join(dir, "data"), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("backfillHasAlpha", () => {
	it("recomputes the flag with the see-through rule and is idempotent", async () => {
		await writeFile(join(dir, "data/rounded.png"), await rgba(() => 254));
		await writeFile(
			join(dir, "data/cutout.png"),
			await rgba((i) => (i < 20 ? 0 : 255)),
		);
		const databasePath = join(dir, "db.sqlite");
		const sqlite = new Database(databasePath);
		sqlite.exec(
			"CREATE TABLE image_files (id TEXT PRIMARY KEY, storage_path TEXT NOT NULL, has_alpha INTEGER NOT NULL)",
		);
		const insert = sqlite.prepare("INSERT INTO image_files VALUES (?, ?, ?)");
		insert.run("rounded", "data/rounded.png", 1);
		insert.run("cutout", "data/cutout.png", 1);
		insert.run("gone", "data/gone.png", 1);
		sqlite.close();

		const first = await backfillHasAlpha({ databasePath, baseDir: dir });
		expect(first.checked).toBe(3);
		expect(first.changed).toEqual([{ id: "rounded", from: 1, to: 0 }]);
		expect(first.skipped.map((item) => item.id)).toEqual(["gone"]);

		const second = await backfillHasAlpha({ databasePath, baseDir: dir });
		expect(second.changed).toEqual([]);

		const check = new Database(databasePath);
		const flags = check
			.prepare("SELECT id, has_alpha FROM image_files ORDER BY id")
			.all();
		check.close();
		expect(flags).toEqual([
			{ id: "cutout", has_alpha: 1 },
			{ id: "gone", has_alpha: 1 },
			{ id: "rounded", has_alpha: 0 },
		]);
	});
});
