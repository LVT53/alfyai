// SvelteKit serves this standalone ESM as a download. The browser never imports
// the helper's Node built-ins and the downloaded file has no npm dependencies.
import { build } from "esbuild";
/** @returns {import("vite").Plugin} */
export function boschRunnerAsset() {
	return {
		name: "bosch-personal-runner",
		enforce: "pre",
		async load(id) {
			const suffix = "/bosch-flow-runner-cli.ts?raw";
			if (!id.endsWith(suffix)) return;
			const result = await build({
				entryPoints: [id.slice(0, -4)],
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				write: false,
				metafile: true,
				legalComments: "none",
				logLevel: "silent",
			});
			for (const file of Object.keys(result.metafile.inputs))
				this.addWatchFile(file);
			return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
		},
	};
}
