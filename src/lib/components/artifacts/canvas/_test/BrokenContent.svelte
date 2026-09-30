<script lang="ts">
// A test stand-in for a block whose content cannot be drawn: it throws while it
// renders, for as long as `broken.on` says, and draws a word once it does not.
import { broken } from "./broken-content";

if (broken.on) throw new Error("this block cannot be drawn");
</script>

<p data-testid="content-recovered">recovered</p>
