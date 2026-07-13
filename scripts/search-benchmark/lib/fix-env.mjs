import fs from "node:fs";

const p = ".env";
const before = fs.readFileSync(p, "utf8");
let s = before;

// Repair: a value got glued directly in front of PARALLEL_API_KEY= (missing newline).
// Insert a newline before any PARALLEL_API_KEY= that is not already at line start.
s = s.replace(/([^\n])PARALLEL_API_KEY=/g, "$1\nPARALLEL_API_KEY=");
if (!s.endsWith("\n")) s += "\n";

fs.writeFileSync(p, s);

const ownTracksClean = /^OWNTRACKS_RECORDER_URL=http:\/\/127\.0\.0\.1:8084$/m.test(s);
const parallelPresent = /^PARALLEL_API_KEY=\S+$/m.test(s);
const parallelCount = (s.match(/^PARALLEL_API_KEY=/gm) || []).length;
const keys = s.split("\n").filter(Boolean).map((l) => l.split("=")[0]);
const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];

console.log("changed:", before !== s);
console.log("OWNTRACKS_RECORDER_URL line clean:", ownTracksClean);
console.log("PARALLEL_API_KEY on its own line:", parallelPresent);
console.log("PARALLEL_API_KEY line count:", parallelCount);
console.log("duplicate keys:", dupes.length ? dupes.join(",") : "(none)");
