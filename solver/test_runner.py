"""Check admission and readiness without requiring a browser or dependencies."""
import asyncio
import importlib.util
import logging
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


class FakeApp:
    def before_request(self, handler):
        return handler

    def after_request(self, handler):
        return handler

    def get(self, route):
        return lambda handler: handler


class UpstreamServer:
    def __init__(self, *args, **kwargs):
        self.app = FakeApp()
        self.results = self._load_results()
        self.browser_pool = asyncio.Queue()

    async def _solve_turnstile(self, task_id, *args, **kwargs):
        self.results[task_id] = {"value": "test-proof"}

    async def _initialize_browser(self):
        await self.browser_pool.put((1, MagicMock(is_connected=lambda: True)))


def load_runner():
    upstream = ModuleType("api_solver")
    upstream.TurnstileAPIServer = UpstreamServer
    upstream.logger = logging.getLogger("cerium-solver-test")
    quart = ModuleType("quart")
    quart.request = SimpleNamespace(
        path="/turnstile",
        args={"url": "https://example.invalid/login", "sitekey": "test-key"},
    )
    quart.jsonify = lambda **value: value
    hypercorn = ModuleType("hypercorn")
    hypercorn_asyncio = ModuleType("hypercorn.asyncio")
    hypercorn_asyncio.serve = AsyncMock()
    hypercorn_config = ModuleType("hypercorn.config")
    hypercorn_config.Config = SimpleNamespace
    spec = importlib.util.spec_from_file_location(
        "cerium_solver_runner", Path(__file__).with_name("runner.py")
    )
    runner = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        "api_solver": upstream,
        "quart": quart,
        "hypercorn": hypercorn,
        "hypercorn.asyncio": hypercorn_asyncio,
        "hypercorn.config": hypercorn_config,
    }):
        spec.loader.exec_module(runner)
    return runner


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runner = load_runner()
        self.server = self.runner.server

    async def finish_tasks(self):
        await asyncio.gather(*list(self.server.tasks.values()))

    async def test_completed_results_do_not_block_new_work(self):
        tasks = [await self.server.process_turnstile() for _ in range(4)]
        self.assertEqual([status for _, status in tasks], [202] * 4)
        await self.finish_tasks()
        self.assertEqual(len(self.server.results), 4)
        self.assertFalse(self.server.tasks)
        self.assertEqual((await self.server.process_turnstile())[1], 202)
        await self.finish_tasks()

    async def test_concurrent_admission_reserves_capacity_before_yielding(self):
        release = asyncio.Event()

        async def blocked(*args, **kwargs):
            await release.wait()

        with patch.object(UpstreamServer, "_solve_turnstile", side_effect=blocked):
            responses = await asyncio.gather(*(
                self.server.process_turnstile() for _ in range(12)
            ))
            self.assertEqual([status for _, status in responses].count(202), 4)
            self.assertEqual([status for _, status in responses].count(429), 8)
            self.assertEqual(len(self.server.tasks), 4)
            release.set()
            await self.finish_tasks()

    async def test_failed_solve_releases_capacity(self):
        with patch.object(UpstreamServer, "_solve_turnstile", side_effect=RuntimeError):
            response, status = await self.server.process_turnstile()
            self.assertEqual(status, 202)
            await self.finish_tasks()
        self.assertEqual(self.server.results[response["task_id"]], {"value": "CAPTCHA_FAIL"})
        self.assertFalse(self.server.tasks)

    async def test_retention_starts_at_completion_and_never_expires_active_work(self):
        release = asyncio.Event()

        async def blocked(*args, **kwargs):
            await release.wait()

        with patch.object(UpstreamServer, "_solve_turnstile", side_effect=blocked):
            with patch.object(self.runner, "monotonic", return_value=1):
                response, _ = await self.server.process_turnstile()
            with patch.object(self.runner, "monotonic", return_value=500):
                self.server.prune_results()
                self.assertIn(response["task_id"], self.server.results)
                release.set()
                await self.finish_tasks()
        with patch.object(self.runner, "monotonic", return_value=680):
            self.server.prune_results()
            self.assertIn(response["task_id"], self.server.results)
        with patch.object(self.runner, "monotonic", return_value=681):
            self.server.prune_results()
            self.assertNotIn(response["task_id"], self.server.results)

    async def test_invalid_metadata_does_not_allocate_task(self):
        self.runner.request.args["sitekey"] = "bad key"
        self.assertEqual((await self.runner.bound_requests())[1], 400)
        self.assertFalse(self.server.tasks)

    async def test_readiness_requires_live_browser_and_allows_busy_pool(self):
        self.assertEqual((await self.runner.ready())[1], 503)
        await self.server._initialize_browser()
        self.assertEqual((await self.runner.ready())[1], 200)
        _, browser = self.server.browser_pool.get_nowait()
        self.assertEqual((await self.runner.ready())[1], 503)
        release = asyncio.Event()
        self.server.tasks["busy"] = asyncio.create_task(release.wait())
        self.assertEqual((await self.runner.ready())[1], 200)
        browser.is_connected = lambda: False
        self.assertEqual((await self.runner.ready())[1], 503)
        release.set()
        await self.finish_tasks()


if __name__ == "__main__":
    unittest.main()
