<script>
import "../app.css";
import { onMount } from "svelte";
import { browser } from "$app/environment";
import { uiLanguage } from "$lib/stores/settings";
import { initTheme } from "$lib/stores/theme";

let { children } = $props();

// Every server render starts from the baseline language. The shell layout
// below sets the signed-in reader's own before anything is drawn (so the
// first frame is in it), and this puts the baseline back for the next
// request: the login page must never be drawn in the language of whoever was
// rendered before it. The browser keeps its own value.
if (!browser) uiLanguage.set("en");

onMount(() => {
	initTheme();
});
</script>

{@render children()}
