# Optional Turnstile sidecar

Builds the referenced [Theyka/Turnstile-Solver](https://github.com/Theyka/Turnstile-Solver)
at `a1fca97759defd2d6438ee05c3b09b887b8081e4`. Its upstream license is
**CC BY-NC 4.0**: commercial use requires permission from the rights holder.
This optional integration does not relicense or vendor its implementation into Cerium.

Enable with `docker compose --profile solver up -d --build`. For an existing
compatible deployment, configure `CERIUM_TURNSTILE_SOLVER_URL` instead.
When keeping this local sidecar enabled, set `COMPOSE_PROFILES=solver` in `.env`
so subsequent deployments also reconnect it when `web` is recreated. A solver
left in an old network namespace can be healthy but unreachable from `sync`.
The browser is intentionally isolated in its own image, without RDP, public ports,
account passwords, or database mounts. Only a login URL and public sitekey are sent.
The wrapper disables upstream token logging/disk persistence and bounds pending tasks.
The image extends upstream's ten-attempt polling loop to 120 attempts; the wrapper's
70-second task deadline remains authoritative. The build rejects an unexpected
upstream loop rather than silently skipping this adjustment.

Offline polling regression tests (no browser, credentials, or network requests):

```sh
docker run --rm --network none --entrypoint python \
  --mount type=bind,source="$(pwd)/solver/test_polling.py",target=/app/test_polling.py,readonly \
  cerium-solver -m unittest -v test_polling
```

Uses headed Chromium inside Xvfb. No guarantee of successful challenges: upstream
policy, IP reputation, widget settings, WAFs, and other CAPTCHA providers can prevent
login. This handles an embedded Turnstile widget, not Cloudflare's full-page WAF
challenge or MFA. Only use with accounts and sites you are authorized to access.
