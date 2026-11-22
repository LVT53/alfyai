"""Bound inference transport. No queue, scheduler, persistence or memory semantics."""
import asyncio
import hmac
import ipaddress
import json
import socket
import threading
import time
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, Request, Response

PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7")
)


def private_address(host):
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    return address if any(address in network for network in PRIVATE_NETWORKS) else None


def private_url(value):
    url = urlsplit(value)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or url.port == 0
        or (
            not private_address(url.hostname)
            and not (url.scheme == "http" and url.hostname in ("localhost", "host.docker.internal"))
        )
    ):
        raise ValueError("Inference endpoint must be a private service address")
    return url


async def pin_address(url, timeout):
    if private_address(url.hostname):
        return url.geturl(), {}
    try:
        entries = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(
                url.hostname, url.port or 80, type=socket.SOCK_STREAM
            ),
            timeout,
        )
    except (OSError, TimeoutError):
        raise ValueError("Private service resolution unavailable") from None
    addresses = [private_address(entry[4][0]) for entry in entries]
    if not addresses or None in addresses:
        raise ValueError("Private service resolution rejected")
    selected = next((address for address in addresses if address.version == 4), addresses[0])
    host = f"[{selected}]" if selected.version == 6 else str(selected)
    if url.port:
        host += f":{url.port}"
    return urlunsplit(url._replace(netloc=host)), {"Host": url.netloc}


class Budget:
    def __init__(self):
        self.active = 0
        self.peak = 0
        self.rejected = 0
        self.completed = 0
        self.duration_ms = 0
        self.lock = threading.Lock()

    def enter(self, signal):
        fresh = isinstance(signal, dict) and isinstance(signal.get("observedAt"), (int, float)) and 0 <= time.time() * 1000 - signal["observedAt"] <= 2000
        limit = 6 if fresh and signal.get("healthy") is True and signal.get("idle") is True and signal.get("active") is False else 1
        with self.lock:
            if self.active >= limit:
                self.rejected += 1
                return False
            self.active += 1
            self.peak = max(self.peak, self.active)
            return True

    def leave(self, elapsed=0):
        with self.lock:
            self.active -= 1
            self.completed += 1
            self.duration_ms += elapsed

def install_admission(router, config):
    # One deployment process is required: the native engine's global semaphore
    # and this transport budget must observe every worker's call.
    from hindsight_api.config import get_config
    if get_config().workers != 1:
        raise ValueError("AlfyAI inference admission requires one Hindsight process")
    token = config.get("inference_key", "")
    upstream = config.get("upstream_url", "").rstrip("/")
    upstream_key = config.get("upstream_key", "")
    model = config.get("upstream_model", "")
    activity_url = config.get("activity_url", "")
    activity_key = config.get("activity_key", "")
    if not token or not upstream or not model:
        raise ValueError("AlfyAI inference admission requires private key, upstream and model")
    upstream_target = private_url(upstream + "/chat/completions")
    activity_target = private_url(activity_url) if activity_url else None
    budget = Budget()

    @router.post("/alfyai/inference/v1/chat/completions")
    async def infer(request: Request):
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()):
            raise HTTPException(401, "Authentication required")
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > 4 * 1024 * 1024:
                raise HTTPException(413, "Inference request too large")
        try:
            value = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(400, "Invalid inference request") from None
        if not isinstance(value, dict) or value.get("model") != model or value.get("stream") is True:
            raise HTTPException(400, "Unsupported inference request")
        signal = None
        async with httpx.AsyncClient(timeout=180, follow_redirects=False, trust_env=False) as client:
            if activity_target and activity_key:
                try:
                    target, headers = await pin_address(activity_target, 0.25)
                    status = await client.get(
                        target, headers={**headers, "Authorization": "Bearer " + activity_key}, timeout=0.5
                    )
                    if status.status_code == 200:
                        signal = status.json()
                except (httpx.HTTPError, ValueError):
                    pass  # Unknown activity is always the daytime budget.
            if not budget.enter(signal):
                raise HTTPException(429, "Memory inference budget busy", headers={"Retry-After": "1"})
            start = time.monotonic()
            try:
                target, headers = await pin_address(upstream_target, 0.5)
                result = await client.post(
                    target,
                    headers={**headers, "Authorization": "Bearer " + upstream_key, "Content-Type": "application/json"},
                    content=bytes(body),
                )
                return Response(result.content, status_code=result.status_code, media_type="application/json")
            except (httpx.HTTPError, ValueError):
                raise HTTPException(503, "Memory inference unavailable") from None
            finally:
                budget.leave(round((time.monotonic() - start) * 1000))

    @router.get("/alfyai/inference/status")
    async def status(request: Request):
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()):
            raise HTTPException(401, "Authentication required")
        with budget.lock:
            return {"active": budget.active, "peak": budget.peak, "rejected": budget.rejected, "completed": budget.completed, "duration_ms": budget.duration_ms}
