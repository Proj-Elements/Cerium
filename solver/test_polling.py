"""Exercise the image's patched upstream polling without a browser or network."""
import asyncio
import logging
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, "/app/upstream")
from api_solver import TurnstileAPIServer, logger

logger.setLevel(logging.CRITICAL)


class PollingTests(unittest.IsolatedAsyncioTestCase):
    async def solve(self, values):
        server = TurnstileAPIServer(False, None, False, "chromium", 1, False)
        server._save_results = MagicMock()
        server.results["test-task"] = "CAPTCHA_NOT_READY"
        page = MagicMock()
        for method in ("route", "goto", "eval_on_selector"):
            setattr(page, method, AsyncMock())
        page.input_value = AsyncMock(side_effect=values)
        page.locator.return_value.click = AsyncMock()
        context = MagicMock(new_page=AsyncMock(return_value=page), close=AsyncMock())
        browser = MagicMock(new_context=AsyncMock(return_value=context))
        await server.browser_pool.put((1, browser))
        with patch("api_solver.asyncio.sleep", new=AsyncMock()):
            await asyncio.wait_for(
                server._solve_turnstile("test-task", "https://example.invalid/login", "test-key"),
                2,
            )
        context.close.assert_awaited_once()
        self.assertEqual(server.browser_pool.qsize(), 1)
        return server.results["test-task"], page.input_value.await_count

    async def test_widget_ready_after_tenth_poll(self):
        result, polls = await self.solve([""] * 12 + ["unit-test-proof"])
        self.assertEqual(result["value"], "unit-test-proof")
        self.assertEqual(polls, 13)

    async def test_unfinished_widget_still_has_finite_poll_budget(self):
        result, polls = await self.solve([""] * 120)
        self.assertEqual(result["value"], "CAPTCHA_FAIL")
        self.assertEqual(polls, 120)


if __name__ == "__main__":
    unittest.main()
