"""Private, bounded wrapper around the separately licensed upstream solver."""
import asyncio
import logging
import re
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, "/app/upstream")
from api_solver import TurnstileAPIServer, logger
from hypercorn.asyncio import serve
from hypercorn.config import Config
from quart import jsonify, request

# The reference solver logs token prefixes and writes results.json. Neither is
# needed for one-use login proofs; retain them in memory for at most 3 minutes.
logger.setLevel(logging.CRITICAL)


class PrivateSolver(TurnstileAPIServer):
    @staticmethod
    def _load_results():
        return {}

    def _save_results(self):
        pass

    async def _solve_turnstile(self, task_id, *args, **kwargs):
        try:
            await asyncio.wait_for(super()._solve_turnstile(task_id, *args, **kwargs), 70)
        except Exception:
            self.results[task_id] = {"value": "CAPTCHA_FAIL"}


server = PrivateSolver(False, None, False, "chromium", 1, False)
# Do not contact the reference page's unrelated IP-discovery service.
server.HTML_TEMPLATE = """<!doctype html><html><head>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script>
</head><body><!-- cf turnstile --></body></html>"""
started = {}


@server.app.before_request
async def bound_requests():
    now = time.monotonic()
    for task_id, created in list(started.items()):
        if now - created > 180:
            started.pop(task_id, None)
            server.results.pop(task_id, None)
    if request.path != "/turnstile":
        return None
    if len(started) >= 4:
        return jsonify(error="solver busy"), 429
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
    if request.path == "/turnstile" and response.status_code == 202:
        task = await response.get_json()
        started[task["task_id"]] = time.monotonic()
    return response


@server.app.get("/healthz")
async def health():
    return jsonify(ok=True)


config = Config()
config.bind = ["127.0.0.1:8092"]
config.accesslog = None
config.loglevel = "warning"
asyncio.run(serve(server.app, config))
