FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN sed -i \
    -e 's|http://deb.debian.org/debian$|https://snapshot.debian.org/archive/debian/20261110T000000Z/|' \
    -e 's|http://deb.debian.org/debian-security$|https://snapshot.debian.org/archive/debian-security/20261110T000000Z/|' \
    /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99snapshot
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Keep the upstream solver separate from the Go runtime and pin its source.
RUN git init upstream && cd upstream \
    && git remote add origin https://github.com/Theyka/Turnstile-Solver.git \
    && git fetch --depth 1 origin a1fca97759defd2d6438ee05c3b09b887b8081e4 \
    && git checkout --detach FETCH_HEAD && rm -rf .git
COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock \
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
