import unittest
import time
from alfyai_admission import Budget

class BudgetTests(unittest.TestCase):
    def test_defaults_and_unknown_activity_are_one(self):
        for signal in (None, {}, {"idle": True}, {"idle": True, "active": False, "healthy": True, "observedAt": 0}, {"idle": True, "active": False, "healthy": False, "observedAt": time.time()*1000}, {"idle": True, "active": "false"}, {"idle": False, "active": False}):
            budget = Budget()
            self.assertTrue(budget.enter(signal))
            self.assertFalse(budget.enter(signal))
            budget.leave()
            self.assertTrue(budget.enter(signal))

    def test_explicit_idle_allows_six_then_foreground_downshifts_without_cancelling(self):
        budget = Budget()
        idle = {"idle": True, "active": False, "healthy": True, "observedAt": time.time()*1000}
        for _ in range(6): self.assertTrue(budget.enter(idle))
        self.assertFalse(budget.enter(idle))
        for _ in range(5):
            self.assertFalse(budget.enter({"idle": True, "active": True}))
            budget.leave()
        self.assertFalse(budget.enter({"idle": True, "active": True}))
        budget.leave()
        self.assertTrue(budget.enter({"idle": True, "active": True}))
        self.assertEqual(budget.peak, 6)

if __name__ == "__main__": unittest.main()

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
