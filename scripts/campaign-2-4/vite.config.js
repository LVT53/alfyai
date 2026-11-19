// The dev server the 2.4 campaign's pictures are drawn in (`render.ts`): the
// app's own config, so the pictures get the app's CSS, fonts, icons and words,
// plus this folder among the files the server may hand to the browser.
import { fileURLToPath } from "node:url";
import base from "../../vite.config.js";

export default {
	...base,
	server: {
		...base.server,
		fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
	},
};
