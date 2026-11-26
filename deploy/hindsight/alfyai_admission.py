"""Bound inference transport in front of the one private model, with a fair waiting queue.

A call within the budget goes to the model at once. A call over it waits in the queue
(alfyai_admission_queue.py) instead of being refused, and gets 429 only when the queue is
full or its wait runs out. The queue lives in this process's memory: no persistence,
scheduler or memory semantics live here. A waiting call is lost with the process, and its
caller's own retries own what happens then.
"""
import asyncio
import hmac
import ipaddress
import json
import socket
import time
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import HTTPException, Request, Response

from alfyai_admission_queue import (
    AdmissionQueue,
    AdmissionRefused,
    admission_limit,
    admission_settings,
    ticket_from_headers,
)

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


REFUSALS = {
    "queue_full": "Memory inference queue full",
    "wait_exceeded": "Memory inference wait exceeded",
}
# A waiting call reads the activity endpoint again once the last reading is this old.
ACTIVITY_REREAD_S = 1.0


def install_admission(router, config):
    # One deployment process is required: the native engine's global semaphore
    # and this queue must observe every worker's call.
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
    settings = admission_settings(config)
    reads_activity = bool(activity_target and activity_key)
    # The latest activity reading. Unknown until a read succeeds, and unknown is the daytime budget.
    activity = {"signal": None, "asked_at": float("-inf"), "answer_to": float("-inf")}

    async def read_activity():
        asked_at = time.monotonic()
        activity["asked_at"] = asked_at
        signal = None
        try:
            target, headers = await pin_address(activity_target, 0.25)
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False) as client:
                answer = await client.get(
                    target, headers={**headers, "Authorization": "Bearer " + activity_key}, timeout=0.5
                )
            if answer.status_code == 200:
                signal = answer.json()
        except (httpx.HTTPError, ValueError):
            pass  # Unknown activity is always the daytime budget.
        if asked_at >= activity["answer_to"]:  # an older reading never replaces a newer one
            activity["signal"], activity["answer_to"] = signal, asked_at

    async def refresh():
        if reads_activity and time.monotonic() - activity["asked_at"] > ACTIVITY_REREAD_S:
            await read_activity()

    queue = AdmissionQueue(
        max_waiting=settings.max_waiting,
        limit=lambda: admission_limit(activity["signal"], time.time() * 1000),
    )

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
        if reads_activity:
            await read_activity()  # every call reads it once before admission
        ticket = ticket_from_headers(
            request.headers, native_wait_s=settings.native_wait_s, max_wait_s=settings.max_wait_s
        )
        left = False

        async def abandoned():
            nonlocal left
            left = await request.is_disconnected()
            return left

        try:
            await queue.acquire(ticket, abandoned=abandoned, refresh=refresh)
        except AdmissionRefused as refused:
            raise HTTPException(429, REFUSALS[refused.reason], headers={"Retry-After": "5"}) from None
        except asyncio.CancelledError:
            if not left:
                raise
            # The caller left while it waited, so nobody reads this answer. Returning one
            # ends the request quietly instead of reporting the queue's leave as a crash.
            return Response(status_code=499)
        start = time.monotonic()
        try:
            target, headers = await pin_address(upstream_target, 0.5)
            async with httpx.AsyncClient(timeout=180, follow_redirects=False, trust_env=False) as client:
                result = await client.post(
                    target,
                    headers={**headers, "Authorization": "Bearer " + upstream_key, "Content-Type": "application/json"},
                    content=bytes(body),
                )
            return Response(result.content, status_code=result.status_code, media_type="application/json")
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, "Memory inference unavailable") from None
        finally:
            queue.release(round((time.monotonic() - start) * 1000))

    @router.get("/alfyai/inference/status")
    async def status(request: Request):
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + token).encode()):
            raise HTTPException(401, "Authentication required")
        return queue.status()
