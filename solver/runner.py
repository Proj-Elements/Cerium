"""Private, bounded wrapper around the separately licensed upstream solver."""
import asyncio
import logging
import os
import re
import sys
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

sys.path.insert(0, "/app/upstream")
from api_solver import TurnstileAPIServer, logger
from hypercorn.asyncio import serve
from hypercorn.config import Config
from quart import jsonify, request

# The reference solver logs token prefixes and writes results.json. Neither is
# needed for one-use login proofs; retain them in memory for at most 3 minutes.
logger.setLevel(logging.CRITICAL)


class PrivateSolver(TurnstileAPIServer):
    def __init__(self, *args, **kwargs):
        self.tasks = {}
        self.started = {}
        self.browsers = []
        super().__init__(*args, **kwargs)

    @staticmethod
    def _load_results():
        return {}

    def _save_results(self):
        pass

    async def _initialize_browser(self):
        await super()._initialize_browser()
        available = []
        while not self.browser_pool.empty():
            available.append(self.browser_pool.get_nowait())
        for entry in available:
            self.browsers.append(entry[1])
            self.browser_pool.put_nowait(entry)

    def prune_results(self):
        now = monotonic()
        for task_id, completed in list(self.started.items()):
            if task_id not in self.tasks and now - completed > 180:
                self.started.pop(task_id, None)
                self.results.pop(task_id, None)

    async def process_turnstile(self):
        if len(self.tasks) >= 4:
            return jsonify(error="solver busy"), 429
        task_id = str(uuid4())
        self.results[task_id] = "CAPTCHA_NOT_READY"
        self.started[task_id] = monotonic()
        self.tasks[task_id] = asyncio.create_task(
            self._solve_turnstile(
                task_id,
                request.args["url"],
                request.args["sitekey"],
                request.args.get("action"),
                request.args.get("cdata"),
            )
        )
        return jsonify(task_id=task_id), 202

    async def _solve_turnstile(self, task_id, *args, **kwargs):
        try:
            await asyncio.wait_for(super()._solve_turnstile(task_id, *args, **kwargs), 70)
        except Exception:
            self.results[task_id] = {"value": "CAPTCHA_FAIL"}
        finally:
            self.tasks.pop(task_id, None)
            self.started[task_id] = monotonic()


server = PrivateSolver(False, None, False, "chromium", 1, False)
# Do not contact the reference page's unrelated IP-discovery service.
server.HTML_TEMPLATE = """<!doctype html><html><head>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script>
</head><body><!-- cf turnstile --></body></html>"""
@server.app.before_request
async def bound_requests():
    server.prune_results()
    if request.path != "/turnstile":
        return None
    try:
        page = urlsplit(request.args.get("url", ""))
        valid_url = page.scheme in ("http", "https") and page.hostname and not (
            page.username or page.password or page.query or page.fragment
        )
    except ValueError:
        valid_url = False
    if not valid_url or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request.args.get("sitekey", "")):
        return jsonify(error="invalid page or sitekey"), 400
    for key in ("action", "cdata"):
        if key in request.args and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request.args[key]):
            return jsonify(error="invalid challenge metadata"), 400


@server.app.after_request
async def remember_task(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@server.app.get("/healthz")
async def health():
    return jsonify(ok=True)


@server.app.get("/readyz")
async def ready():
    try:
        connected = (
            bool(server.browsers)
            and all(browser.is_connected() for browser in server.browsers)
            and (not server.browser_pool.empty() or bool(server.tasks))
        )
    except Exception:
        connected = False
    return jsonify(
        ok=connected,
        browsers=len(server.browsers),
        active_tasks=len(server.tasks),
        capacity=4,
    ), 200 if connected else 503


if __name__ == "__main__":
    config = Config()
    host = os.environ.get("SOLVER_HOST", "127.0.0.1")
    port = int(os.environ.get("SOLVER_PORT", "8092"))
    if not 1 <= port <= 65535:
        raise ValueError("SOLVER_PORT must be between 1 and 65535")
    config.bind = [f"{host}:{port}"]
    config.accesslog = None
    config.loglevel = "warning"
    asyncio.run(serve(server.app, config))
