import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import httpx

from alfyai_tei_transport import create_app, relay_host


NATIVE_HOST = "172.30.40.2"
EMBED = {
    "model": "/qwen3-embedding-4b",
    "input": ["synthetic text"],
    "dimensions": 1024,
    "encoding_format": "base64",
}
RERANK = {"query": "synthetic query", "texts": ["synthetic text"], "return_text": False}
AUTH = {"Authorization": "Bearer transport-synthetic"}


class TeiDeploymentTests(unittest.TestCase):
    def test_relay_will_only_bind_the_native_stacks_bridge(self):
        self.assertEqual(relay_host("172.30.40.0/28", "172.30.40.1", NATIVE_HOST), "172.30.40.1")
        for gateway in ("0.0.0.0", "192.168.1.96", "127.0.0.1", NATIVE_HOST):
            with self.assertRaises(ValueError):
                relay_host("172.30.40.0/28", gateway, NATIVE_HOST)
        with self.assertRaises(ValueError):
            relay_host("240.0.0.0/28", "240.0.0.1", "240.0.0.2")

    def test_resolved_compose_relay_separates_upstream_credentials_and_has_no_write_mount(self):
        if not shutil.which("docker"):
            self.skipTest("Docker Compose CLI unavailable")
        source = Path(__file__).parent
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for file in ("compose.yaml", "compose.gpu.yaml", "alfyai_tei_transport.py"):
                shutil.copy(source / file, root)
            for file in ("native-model.env", "native-tenants.env"):
                (root / file).touch()
            (root / "tei-upstreams.env").write_text(
                "ALFYAI_TEI_EMBEDDING_UPSTREAM_KEY=embed-synthetic\n"
                "ALFYAI_TEI_RERANKER_UPSTREAM_KEY=rerank-synthetic\n"
            )
            settings = {
                "HINDSIGHT_DB_PASSWORD": "synthetic",
                "HINDSIGHT_DB_PASSWORD_URI": "synthetic",
                "HINDSIGHT_API_WORKER_ID": "alfyai-memory-test",
                "ALFYAI_TEI_NATIVE_IMAGE": "alfyai-hindsight:validated-test",
                "ALFYAI_TEI_BRIDGE_SUBNET": "172.30.40.0/28",
                "ALFYAI_TEI_BRIDGE_GATEWAY": "172.30.40.1",
                "ALFYAI_TEI_NATIVE_HOST": NATIVE_HOST,
                "ALFYAI_TEI_POSTGRES_HOST": "172.30.40.3",
                "ALFYAI_TEI_EMBEDDING_TOKEN": "transport-synthetic",
                "ALFYAI_TEI_EMBEDDING_QUERY_PREFIX": "Instruct: Retrieve relevant passages.\nQuery: ",
            }
            resolved = subprocess.run(
                ["docker", "compose", "-f", "compose.yaml", "-f", "compose.gpu.yaml", "config", "--format", "json"],
                cwd=root, env={**os.environ, **settings}, check=True, capture_output=True, text=True,
            )
            services = json.loads(resolved.stdout)["services"]
            relay = services["tei_transport"]
            native = services["hindsight"]
            self.assertEqual(relay["network_mode"], "host")
            self.assertEqual(relay["cap_drop"], ["ALL"])
            self.assertTrue(relay["read_only"])
            self.assertFalse(relay.get("ports"))
            self.assertEqual(len(relay["volumes"]), 1)
            self.assertTrue(relay["volumes"][0]["read_only"])
            self.assertEqual(relay["environment"]["ALFYAI_TEI_BRIDGE_GATEWAY"], "172.30.40.1")
            self.assertEqual(native["depends_on"]["tei_transport"]["condition"], "service_healthy")
            self.assertIn("socket.create_connection", " ".join(relay["healthcheck"]["test"]))
            self.assertEqual(native["networks"]["default"]["ipv4_address"], NATIVE_HOST)
            self.assertIn("NET_RAW", native["cap_drop"])
            self.assertIn("NET_RAW", services["postgres"]["cap_drop"])
            self.assertEqual(native["environment"]["HINDSIGHT_API_EMBEDDINGS_PROVIDER"], "openai")
            self.assertEqual(native["environment"]["HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS"], "1024")
            self.assertEqual(native["environment"]["HINDSIGHT_API_EMBEDDINGS_QUERY_PREFIX"], settings["ALFYAI_TEI_EMBEDDING_QUERY_PREFIX"])
            self.assertEqual(native["environment"]["HINDSIGHT_API_RERANKER_PROVIDER"], "tei")
            self.assertNotIn("ALFYAI_TEI_EMBEDDING_UPSTREAM_KEY", native["environment"])
            self.assertNotIn("ALFYAI_TEI_RERANKER_UPSTREAM_KEY", native["environment"])


class TeiTransportTests(unittest.IsolatedAsyncioTestCase):
    def client(self, upstream, host=NATIVE_HOST):
        app = create_app(
            native_host=NATIVE_HOST,
            embedding_token="transport-synthetic",
            embedding_upstream_key="embed-synthetic",
            reranker_upstream_key="rerank-synthetic",
            transport=httpx.MockTransport(upstream),
        )
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, client=(host, 12345)),
            base_url="http://172.30.40.1:17998",
        )

    async def test_only_allowed_peer_and_embedding_bearer_can_dispatch(self):
        def upstream(request):
            self.fail("unauthenticated request reached upstream")

        for host in ("172.30.40.3", "127.0.0.1", "::1"):
            async with self.client(upstream, host) as client:
                headers = {**AUTH, "X-Forwarded-For": NATIVE_HOST}
                self.assertEqual((await client.post("/v1/embeddings", json=EMBED, headers=headers)).status_code, 403)
                self.assertEqual((await client.post("/rerank", json=RERANK, headers=headers)).status_code, 403)
                self.assertEqual((await client.get("/status")).status_code, 403)
        async with self.client(upstream) as client:
            self.assertEqual((await client.post("/v1/embeddings", json=EMBED)).status_code, 401)
            self.assertEqual((await client.get("/docs")).status_code, 404)
            self.assertEqual((await client.get("/info/")).status_code, 404)

    async def test_passes_supported_wires_unchanged_with_fixed_destination_and_credentials(self):
        observed = []

        def upstream(request):
            observed.append((str(request.url), request.headers["authorization"], request.content))
            self.assertNotIn("x-hindsight-bank-id", request.headers)
            self.assertNotIn("x-forwarded-for", request.headers)
            if request.url.path == "/info":
                return httpx.Response(200, json={"model_id": "/bge-reranker-v2-m3"})
            return httpx.Response(200, json={"synthetic": True})

        async with self.client(upstream) as client:
            headers = {**AUTH, "X-Hindsight-Bank-Id": "should-not-travel", "X-Forwarded-For": "wrong"}
            self.assertEqual((await client.post("/v1/embeddings", json=EMBED, headers=headers)).json(), {"synthetic": True})
            self.assertEqual((await client.get("/info")).json(), {"model_id": "/bge-reranker-v2-m3"})
            self.assertEqual((await client.post("/rerank", json=RERANK)).json(), {"synthetic": True})
            self.assertEqual((await client.get("/status")).json(), {"embeddings": 1, "rerank": 1})
        self.assertEqual(
            [(url, token, json.loads(body) if body else None) for url, token, body in observed],
            [
                ("http://127.0.0.1:7999/v1/embeddings", "Bearer embed-synthetic", EMBED),
                ("http://127.0.0.1:7998/info", "Bearer rerank-synthetic", None),
                ("http://127.0.0.1:7998/rerank", "Bearer rerank-synthetic", RERANK),
            ],
        )

    async def test_rejects_bad_model_shape_and_size_before_upstream(self):
        def upstream(request):
            self.fail("invalid request reached upstream")

        async with self.client(upstream) as client:
            for invalid in (
                {**EMBED, "model": "another"},
                {**EMBED, "dimensions": 2560},
                {**EMBED, "input": ["synthetic"] * 9},
                {**EMBED, "input": [1]},
                {**EMBED, "user": "unnecessary"},
            ):
                self.assertEqual((await client.post("/v1/embeddings", json=invalid, headers=AUTH)).status_code, 400)
            duplicate = json.dumps(EMBED).replace('"dimensions": 1024', '"dimensions": 2560, "dimensions": 1024')
            self.assertEqual((await client.post(
                "/v1/embeddings", content=duplicate, headers={**AUTH, "Content-Type": "application/json"}
            )).status_code, 400)
            self.assertEqual((await client.post("/rerank", json={**RERANK, "return_text": True})).status_code, 400)
            self.assertEqual((await client.post("/rerank", json={**RERANK, "texts": ["synthetic"] * 9})).status_code, 400)
            self.assertEqual((await client.post("/rerank?forward=1", json=RERANK)).status_code, 400)
            self.assertEqual((await client.post("/rerank", content=b"not-json")).status_code, 415)
            self.assertEqual((await client.post("/rerank", content=b"{" * (4 * 1024 * 1024 + 1),
                                                headers={"Content-Type": "application/json"})).status_code, 413)

    async def test_sanitizes_error_body_and_blocks_redirects_and_oversize_replies(self):
        def upstream(request):
            if request.url.path == "/info":
                return httpx.Response(200, json={"model_id": "unexpected provider"})
            if request.url.path == "/rerank":
                return httpx.Response(302, text="synthetic canary", headers={"Location": "https://example.invalid/"})
            if json.loads(request.content)["input"] == ["oversize reply"]:
                return httpx.Response(200, content=b"[" * (1024 * 1024 + 1), headers={"Content-Type": "application/json"})
            return httpx.Response(422, json={"detail": "synthetic canary"})

        async with self.client(upstream) as client:
            for response, status in (
                (await client.get("/info"), 502),
                (await client.post("/rerank", json=RERANK), 502),
                (await client.post("/v1/embeddings", json=EMBED, headers=AUTH), 422),
                (await client.post("/v1/embeddings", json={**EMBED, "input": ["oversize reply"]}, headers=AUTH), 502),
            ):
                self.assertEqual(response.status_code, status)
                self.assertNotIn("synthetic canary", response.text)
                self.assertNotIn("location", response.headers)

    async def test_caps_each_gpu_endpoint_independently(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def upstream(request):
            if request.url.path == "/v1/embeddings":
                entered.set()
                await release.wait()
            return httpx.Response(200, json={"synthetic": True})

        async with self.client(upstream) as client:
            first = asyncio.create_task(client.post("/v1/embeddings", json=EMBED, headers=AUTH))
            try:
                await asyncio.wait_for(entered.wait(), 1)
                busy = await client.post("/v1/embeddings", json=EMBED, headers=AUTH)
                self.assertEqual(busy.status_code, 429)
                self.assertEqual(busy.headers["retry-after"], "1")
                self.assertEqual((await client.post("/rerank", json=RERANK)).status_code, 200)
            finally:
                release.set()
                self.assertEqual((await first).status_code, 200)
