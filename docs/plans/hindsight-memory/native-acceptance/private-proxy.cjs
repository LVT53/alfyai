const { createServer } = require("node:http");
const { createConnection } = require("node:net");
const { execFile } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const assert = require("node:assert/strict");

const marker = "Bearer alfyai-synthetic-private-test";
const targetHits = { native: 0, redirect: 0, curation: 0 };
const proxyHits = { connections: 0, sawSyntheticAuthorization: false };
const native = createServer((req, res) => {
  if (req.url === "/redirected") targetHits.redirect++;
  else if (req.url === "/curation") targetHits.curation++;
  else targetHits.native++;
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/redirected" });
    res.end();
    return;
  }
  const body = [];
  req.on("data", (part) => body.push(part));
  req.on("end", () => {
    const expected = req.url === "/curation" ? "synthetic curation payload" : "";
    res.end(req.headers.authorization === marker && Buffer.concat(body).toString() === expected ? "ok" : "missing");
  });
});
const proxy = createServer((req, res) => {
  proxyHits.connections++;
  proxyHits.sawSyntheticAuthorization ||= req.headers.authorization === marker;
  req.resume();
  res.end("ok");
});
proxy.on("connect", (_req, client, head) => {
  proxyHits.connections++;
  const peer = createConnection(native.address().port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) peer.write(head);
    client.pipe(peer).pipe(client);
  });
  let prefix = "";
  client.on("data", (part) => {
    prefix = (prefix + part.toString()).slice(-8192);
    proxyHits.sawSyntheticAuthorization ||= prefix.includes(marker);
  });
  client.on("error", () => peer.destroy());
  peer.on("error", () => client.destroy());
  client.on("close", () => peer.destroy());
  peer.on("close", () => client.destroy());
});
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
(async () => {
  await listen(native);
  await listen(proxy);
  const child = (extraArgs, requestPath, ordinary = false) => {
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/server/services/memory-profile/private-endpoint.ts")).href;
    const script = `
      const mod = await import(${JSON.stringify(moduleUrl)});
      const fetchPrivate = ${ordinary ? "fetch" : "mod.fetchPrivateMemory ?? mod.default.fetchPrivateMemory"};
      try {
        const res = await fetchPrivate(${JSON.stringify("http://127.0.0.1:" + native.address().port + requestPath)}, {
          headers: { Authorization: ${JSON.stringify(marker)} },
          signal: AbortSignal.timeout(1500),
          ${requestPath === "/curation" ? 'method: "POST", body: "synthetic curation payload",' : ""}
        });
        console.log(await res.text());
      } catch (e) { console.log(e.cause?.message ?? e.message); }
    `;
    const proxyUrl = "http://127.0.0.1:" + proxy.address().port;
    return promisify(execFile)(process.execPath, [...extraArgs, "--import", "tsx", "--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "" },
      timeout: 3500,
    }).then(({ stdout }) => stdout.trim());
  };
  try {
    assert.equal(await child([], "/capabilities"), "ok");
    assert.deepEqual(proxyHits, { connections: 0, sawSyntheticAuthorization: false });
    assert.equal(await child([], "/redirect"), "unexpected redirect");
    assert.deepEqual(targetHits, { native: 2, redirect: 0, curation: 0 });
    assert.equal(await child(["--use-env-proxy"], "/capabilities", true), "ok");
    assert.equal(proxyHits.connections, 1);
    assert.equal(proxyHits.sawSyntheticAuthorization, true);
    const nativeBeforeNegativeControl = targetHits.native;
    proxyHits.connections = 0;
    proxyHits.sawSyntheticAuthorization = false;
    assert.equal(await child(["--use-env-proxy"], "/capabilities"), "ok");
    assert.equal(await child(["--use-env-proxy"], "/curation"), "ok");
    assert.equal(await child(["--use-env-proxy"], "/redirect"), "unexpected redirect");
    assert.deepEqual(proxyHits, { connections: 0, sawSyntheticAuthorization: false });
    assert.deepEqual(targetHits, { native: nativeBeforeNegativeControl + 2, redirect: 0, curation: 1 });
    console.log(JSON.stringify({ positiveProxyControl: true, proxyHits, targetHits }));
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    native.closeAllConnections();
    native.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
