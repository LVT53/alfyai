import asyncio
import json
import time
import unittest


class InferenceDestinationTests(unittest.TestCase):
    def test_public_or_link_local_destinations_are_rejected_at_installation(self):
        from fastapi import APIRouter
        from alfyai_admission import install_admission

        config = {
            "inference_key": "synthetic",
            "upstream_model": "synthetic",
            "upstream_url": "http://127.0.0.1:8889/v1",
            "activity_url": "http://127.0.0.1:3000/api/internal/memory-admission",
        }
        for key in ("upstream_url", "activity_url"):
            for url in ("https://public.example/v1", "http://1.1.1.1", "http://169.254.169.254"):
                with self.subTest(key=key, url=url), self.assertRaises(ValueError):
                    install_admission(APIRouter(), {**config, key: url})


class AddressPinningTests(unittest.IsolatedAsyncioTestCase):
    async def test_pins_docker_gateway_and_rechecks_every_resolution(self):
        import asyncio
        import socket
        from unittest.mock import patch
        from alfyai_admission import pin_address, private_url

        def resolved(address):
            return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 8888))

        target = private_url("http://host.docker.internal:8888/v1")
        with patch.object(
            asyncio.get_running_loop(), "getaddrinfo",
            side_effect=[[resolved("172.17.0.1")], [resolved("172.17.0.1"), resolved("1.1.1.1")]],
        ):
            self.assertEqual(
                await pin_address(target, 0.25),
                ("http://172.17.0.1:8888/v1", {"Host": "host.docker.internal:8888"}),
            )
            with self.assertRaises(ValueError):
                await pin_address(target, 0.25)


GATEWAY = {
    "inference_key": "synthetic",
    "upstream_model": "synthetic",
    "upstream_url": "http://127.0.0.1:8889/v1",
}
AUTH = {"Authorization": "Bearer synthetic"}


class AdmissionSettingsTests(unittest.TestCase):
    def test_an_invalid_queue_bound_stops_the_installation(self):
        from fastapi import APIRouter
        from alfyai_admission import install_admission

        for key, value in (
            ("admission_max_waiting", "-1"),
            ("admission_max_wait_s", "0"),
            ("admission_native_wait_s", "ten minutes"),
        ):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                install_admission(APIRouter(), {**GATEWAY, key: value})


class QueueingGatewayTests(unittest.IsolatedAsyncioTestCase):
    """The installed gateway holds a call over the budget for the model instead of refusing it."""

    async def asyncSetUp(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        import httpx

        import alfyai_admission

        self.model_free = asyncio.Event()
        self.prompts = []
        self.reading = lambda: None  # what the app's activity endpoint answers
        self.readings = 0
        test = self

        class Model:
            """The upstream model, busy until the test frees it."""

            def __init__(self, **options):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, headers, content):
                test.prompts.append(json.loads(content)["messages"][0]["content"])
                await test.model_free.wait()
                return SimpleNamespace(status_code=200, content=b'{"choices": []}')

            async def get(self, url, headers, timeout):
                test.readings += 1
                return SimpleNamespace(status_code=200, json=test.reading)

        patcher = patch.object(
            alfyai_admission, "httpx", SimpleNamespace(AsyncClient=Model, HTTPError=httpx.HTTPError)
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.model_free.set)

    def install(self, **config):
        import httpx
        from fastapi import APIRouter, FastAPI

        from alfyai_admission import install_admission

        router = APIRouter()
        # One call may wait, and Hindsight's own wait one second.
        install_admission(router, {**GATEWAY, "admission_max_waiting": "1", "admission_native_wait_s": "1", **config})
        self.app = FastAPI()
        self.app.include_router(router)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://gateway")
        self.addAsyncCleanup(self.client.aclose)

    def call(self, prompt, headers=None):
        return asyncio.create_task(
            self.client.post(
                "/alfyai/inference/v1/chat/completions",
                headers={**AUTH, **(headers or {})},
                json={"model": "synthetic", "messages": [{"role": "user", "content": prompt}]},
            )
        )

    async def status(self):
        return (await self.client.get("/alfyai/inference/status", headers=AUTH)).json()

    async def until(self, condition, timeout_s=3.0):
        deadline = asyncio.get_running_loop().time() + timeout_s
        while not condition(await self.status()):
            if asyncio.get_running_loop().time() > deadline:
                self.fail("the gateway did not get there in time")
            await asyncio.sleep(0.01)

    async def test_a_call_over_the_budget_waits_for_the_model_instead_of_getting_429(self):
        self.install()  # no activity endpoint: one call at a time
        first = self.call("first")
        await self.until(lambda status: status["active"] == 1)
        live = self.call("live", {"X-AlfyAI-Admission-Priority": "interactive", "X-AlfyAI-Admission-Lane": "ab"})
        await self.until(lambda status: status["waiting"] == 1)
        self.model_free.set()
        answers = await asyncio.wait_for(asyncio.gather(first, live), 3)
        self.assertEqual([answer.status_code for answer in answers], [200, 200])
        self.assertEqual(self.prompts, ["first", "live"])
        status = await self.status()
        self.assertEqual((status["completed"], status["waited"], status["rejected"]), (2, 1, 0))

    async def test_a_full_queue_and_a_spent_wait_answer_429_with_retry_after(self):
        self.install()  # no activity endpoint: one call at a time
        first = self.call("first")
        await self.until(lambda status: status["active"] == 1)
        native = self.call("native")
        await self.until(lambda status: status["waiting"] == 1)
        full = await asyncio.wait_for(self.call("full", {"X-AlfyAI-Admission-Priority": "background"}), 3)
        self.assertEqual(
            (full.status_code, full.headers["retry-after"], full.json()["detail"]),
            (429, "5", "Memory inference queue full"),
        )
        spent = await asyncio.wait_for(native, 3)
        self.assertEqual(
            (spent.status_code, spent.headers["retry-after"], spent.json()["detail"]),
            (429, "5", "Memory inference wait exceeded"),
        )
        self.model_free.set()
        self.assertEqual((await asyncio.wait_for(first, 3)).status_code, 200)
        self.assertEqual(self.prompts, ["first"])
        status = await self.status()
        self.assertEqual((status["refused_full"], status["refused_wait"], status["rejected"]), (1, 1, 2))

    async def test_a_caller_that_leaves_while_it_waits_never_reaches_the_model(self):
        self.install()  # no activity endpoint: one call at a time
        first = self.call("first")
        await self.until(lambda status: status["active"] == 1)
        body = json.dumps({"model": "synthetic", "messages": [{"role": "user", "content": "gone"}]}).encode()
        request = [{"type": "http.request", "body": body, "more_body": False}]
        gone = asyncio.Event()
        sent = []

        async def receive():
            if request:
                return request.pop()
            await gone.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        path = "/alfyai/inference/v1/chat/completions"
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [(b"authorization", b"Bearer synthetic")],
            "client": ("127.0.0.1", 50000),
            "server": ("gateway", 80),
        }
        leaving = asyncio.create_task(self.app(scope, receive, send))
        await self.until(lambda status: status["waiting"] == 1)
        gone.set()
        await asyncio.wait_for(leaving, 3)
        self.assertEqual(sent[0]["status"], 499)
        self.assertEqual((await self.status())["waiting"], 0)
        self.model_free.set()
        self.assertEqual((await asyncio.wait_for(first, 3)).status_code, 200)
        self.assertEqual(self.prompts, ["first"])
        self.assertEqual((await self.status())["active"], 0)

    async def test_a_reading_taken_while_a_call_waits_decides_its_admission(self):
        self.install(activity_url="http://127.0.0.1:3000/api/internal/memory-admission", activity_key="synthetic")
        self.reading = lambda: {"idle": False, "active": True}
        first = self.call("first")
        await self.until(lambda status: status["active"] == 1)
        second = self.call("second")
        await self.until(lambda status: status["waiting"] == 1)
        readings = self.readings
        # The household goes idle: the next reading allows six, and the waiting call goes in
        # while the first still holds the model.
        self.reading = lambda: {"idle": True, "active": False, "healthy": True, "observedAt": time.time() * 1000}
        await self.until(lambda status: status["active"] == 2)
        self.assertGreater(self.readings, readings)
        self.assertEqual(self.prompts, ["first", "second"])
        self.model_free.set()
        answers = await asyncio.wait_for(asyncio.gather(first, second), 3)
        self.assertEqual([answer.status_code for answer in answers], [200, 200])

    async def test_every_call_reads_the_activity_once_before_its_admission(self):
        self.install(activity_url="http://127.0.0.1:3000/api/internal/memory-admission", activity_key="synthetic")
        self.reading = lambda: {"idle": True, "active": False, "healthy": True, "observedAt": time.time() * 1000}
        calls = [self.call(f"call-{number}") for number in range(3)]
        await self.until(lambda status: status["active"] == 3)
        status = await self.status()
        self.assertEqual((status["waited"], status["waiting"], self.readings), (0, 0, 3))
        self.model_free.set()
        answers = await asyncio.wait_for(asyncio.gather(*calls), 3)
        self.assertEqual([answer.status_code for answer in answers], [200, 200, 200])


if __name__ == "__main__":
    unittest.main()
