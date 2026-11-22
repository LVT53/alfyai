"""Private transport to the host's existing TEI services."""
import asyncio
from collections.abc import AsyncIterable
import hmac
import ipaddress
import json
import os
import re

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from starlette.requests import ClientDisconnect


EMBED_MODEL = "/qwen3-embedding-0.6b"
RERANK_MODEL = "/bge-reranker-v2-m3"
EMBED_DIMENSIONS = 1024
MAX_BATCH = 8
MAX_REQUEST = 4 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024
PRIVATE_BRIDGES = tuple(ipaddress.IPv4Network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


async def read_limited(chunks: AsyncIterable[bytes], limit: int) -> bytes | None:
    result = bytearray()
    async for chunk in chunks:
        if len(result) + len(chunk) > limit:
            return None
        result.extend(chunk)
    return bytes(result)


def is_batch(value: object) -> bool:
    return (
        isinstance(value, list)
        and 1 <= len(value) <= MAX_BATCH
        and all(isinstance(item, str) for item in value)
    )


def unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError("Duplicate JSON field")
    return value


async def read_json(request: Request) -> tuple[bytes, dict]:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "JSON required")
    try:
        async with asyncio.timeout(5):
            body = await read_limited(request.stream(), MAX_REQUEST)
    except (TimeoutError, ClientDisconnect):
        raise HTTPException(408, "Request body unavailable") from None
    if body is None:
        raise HTTPException(413, "Request body too large")
    try:
        value = json.loads(body, object_pairs_hook=unique_json_object)
    except (ValueError, RecursionError):
        raise HTTPException(400, "Invalid JSON") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "Invalid JSON")
    return body, value


def create_app(
    *,
    native_host: str,
    embedding_token: str,
    embedding_upstream_key: str,
    reranker_upstream_key: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    address = ipaddress.IPv4Address(native_host)
    if not any(address in network for network in PRIVATE_BRIDGES):
        raise ValueError("Native TEI peer must be a private bridge IPv4 address")
    if not all(re.fullmatch(r"[!-~]+", key) for key in (embedding_token, embedding_upstream_key, reranker_upstream_key)):
        raise ValueError("TEI transport credentials are required")

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    active: set[str] = set()
    completed = {"embeddings": 0, "rerank": 0}

    def check_peer(request: Request) -> None:
        if not request.client or request.client.host != native_host:
            raise HTTPException(403, "Forbidden")
        if request.url.query:
            raise HTTPException(400, "Unsupported query parameters")

    async def forward(endpoint: str, url: str, credential: str, body: bytes | None) -> bytes:
        if endpoint in active:
            raise HTTPException(429, "GPU inference busy", headers={"Retry-After": "1"})
        active.add(endpoint)
        try:
            async with asyncio.timeout(20), httpx.AsyncClient(
                transport=transport,
                trust_env=False,
                follow_redirects=False,
                timeout=httpx.Timeout(20, connect=1, pool=1),
            ) as client:
                headers = {
                    "Authorization": "Bearer " + credential,
                    "Accept": "application/json",
                    "Accept-Encoding": "identity",
                }
                if body is not None:
                    headers["Content-Type"] = "application/json"
                async with client.stream("POST" if body is not None else "GET", url, content=body, headers=headers) as upstream:
                    status = upstream.status_code
                    if status != 200:
                        if 400 <= status < 500:
                            retry = {"Retry-After": "1"} if status == 429 else None
                            raise HTTPException(status, "GPU inference declined request", headers=retry)
                        raise HTTPException(502, "Invalid GPU inference response")
                    if (
                        upstream.headers.get("content-type", "").split(";", 1)[0] != "application/json"
                        or upstream.headers.get("content-encoding", "identity") != "identity"
                    ):
                        raise HTTPException(502, "Invalid GPU inference response")
                    result = await read_limited(upstream.aiter_bytes(), MAX_RESPONSE)
                    if result is None:
                        raise HTTPException(502, "Invalid GPU inference response")
                    return result
        except (TimeoutError, httpx.HTTPError):
            raise HTTPException(503, "GPU inference unavailable") from None
        finally:
            active.remove(endpoint)

    @app.get("/info")
    async def rerank_info(request: Request):
        check_peer(request)
        body = await forward("rerank", "http://127.0.0.1:7998/info", reranker_upstream_key, None)
        try:
            info = json.loads(body)
        except (ValueError, RecursionError):
            raise HTTPException(502, "Invalid reranker metadata") from None
        if not isinstance(info, dict) or info.get("model_id") != RERANK_MODEL:
            raise HTTPException(502, "Unexpected reranker model")
        return Response(body, media_type="application/json")

    @app.post("/rerank")
    async def rerank(request: Request):
        check_peer(request)
        body, value = await read_json(request)
        if (
            value.keys() != {"query", "texts", "return_text"}
            or not isinstance(value.get("query"), str)
            or not is_batch(value.get("texts"))
            or value.get("return_text") is not False
        ):
            raise HTTPException(400, "Unsupported reranker request")
        result = await forward("rerank", "http://127.0.0.1:7998/rerank", reranker_upstream_key, body)
        completed["rerank"] += 1
        return Response(result, media_type="application/json")

    @app.post("/v1/embeddings")
    async def embeddings(request: Request):
        check_peer(request)
        supplied = request.headers.get("authorization", "").encode()
        if not hmac.compare_digest(supplied, ("Bearer " + embedding_token).encode()):
            raise HTTPException(401, "Authentication required")
        body, value = await read_json(request)
        if (
            not value.keys() <= {"model", "input", "dimensions", "encoding_format"}
            or value.get("model") != EMBED_MODEL
            or not is_batch(value.get("input"))
            or type(value.get("dimensions")) is not int
            or value["dimensions"] != EMBED_DIMENSIONS
            or value.get("encoding_format", "float") not in ("float", "base64")
        ):
            raise HTTPException(400, "Unsupported embedding request")
        result = await forward("embeddings", "http://127.0.0.1:7999/v1/embeddings", embedding_upstream_key, body)
        completed["embeddings"] += 1
        return Response(result, media_type="application/json")

    @app.get("/status")
    async def status(request: Request):
        check_peer(request)
        return dict(completed)

    return app


def create_from_env() -> FastAPI:
    return create_app(
        native_host=os.environ["ALFYAI_TEI_NATIVE_HOST"],
        embedding_token=os.environ["ALFYAI_TEI_EMBEDDING_TOKEN"],
        embedding_upstream_key=os.environ["ALFYAI_TEI_EMBEDDING_UPSTREAM_KEY"],
        reranker_upstream_key=os.environ["ALFYAI_TEI_RERANKER_UPSTREAM_KEY"],
    )


def relay_host(subnet: str, gateway: str, peer: str) -> str:
    network = ipaddress.IPv4Network(subnet)
    address = ipaddress.IPv4Address(gateway)
    native = ipaddress.IPv4Address(peer)
    if (
        not any(network.subnet_of(private) for private in PRIVATE_BRIDGES)
        or address not in network
        or native not in network
        or address in {native, network.network_address, network.broadcast_address}
        or native in {network.network_address, network.broadcast_address}
    ):
        raise ValueError("TEI transport must bind the native deployment's private bridge gateway")
    return str(address)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        create_from_env(),
        host=relay_host(
            os.environ["ALFYAI_TEI_BRIDGE_SUBNET"],
            os.environ["ALFYAI_TEI_BRIDGE_GATEWAY"],
            os.environ["ALFYAI_TEI_NATIVE_HOST"],
        ),
        port=17998,
        workers=1,
        proxy_headers=False,
        access_log=False,
        log_level="warning",
        limit_concurrency=8,
        timeout_keep_alive=2,
    )
