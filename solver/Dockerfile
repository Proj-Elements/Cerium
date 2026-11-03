FROM python:3.13-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Keep the upstream solver separate from the Go runtime and pin its source.
RUN git init upstream && cd upstream \
    && git remote add origin https://github.com/Theyka/Turnstile-Solver.git \
    && git fetch --depth 1 origin a1fca97759defd2d6438ee05c3b09b887b8081e4 \
    && git checkout --detach FETCH_HEAD && rm -rf .git
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m patchright install --with-deps chromium \
    && chmod -R a+rX /opt/browsers \
    && useradd --create-home --uid 10002 solver
# Ten rapid upstream polls can end before a real widget finishes. Keep polling
# within runner.py's existing 70-second deadline; fail the build on source drift.
RUN python -c 'from pathlib import Path; \
    path = Path("upstream/api_solver.py"); source = path.read_text(); \
    needle = "for _ in range(10):"; \
    assert source.count(needle) == 1, "upstream polling loop changed"; \
    path.write_text(source.replace(needle, "for _ in range(120):"))'
COPY runner.py ./
USER solver
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8092/healthz',timeout=2)"
CMD ["xvfb-run", "-a", "python", "runner.py"]
