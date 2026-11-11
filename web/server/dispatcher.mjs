import { diagnostic, workerDiagnostic } from "./diagnostics.mjs";

export class Dispatcher {
  constructor({
    store,
    backend,
    secret,
    sign,
    log,
    concurrency = 4,
    enabled = true,
    fetchWorker = fetch,
  }) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 16
    )
      throw new Error(
        "Dispatch concurrency must be an integer between 1 and 16",
      );
    Object.assign(this, {
      store,
      backend,
      secret,
      sign,
      log,
      concurrency,
      enabled,
      fetchWorker,
    });
    this.active = new Map();
    this.paused = false;
    this.stopped = false;
    this.lastStarted = null;
    this.lastCompleted = null;
    this.lastFailure = null;
  }

  async deliver(job) {
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await this.fetchWorker(
        `${this.backend.replace(/\/+$/, "")}/v1/sync`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(165000),
          headers: {
            "Content-Type": "application/json",
            "X-Cerium-Timestamp": timestamp,
            "X-Cerium-Signature": this.sign(
              this.secret,
              timestamp,
              job.payload,
            ),
          },
          body: job.payload,
        },
      );
      let result;
      if (!response.ok) {
        const bytes = [];
        let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > 8192) {
            await response.body?.cancel().catch(() => {});
            break;
          }
          bytes.push(chunk);
        }
        try {
          result = JSON.parse(Buffer.concat(bytes).toString("utf8"));
        } catch {}
      } else await response.body?.cancel();
      const current = this.store.db
        .prepare("SELECT state FROM jobs WHERE id=?")
        .get(job.id);
      if (current?.state === "running") {
        if (
          response.status === 422 &&
          ["callback_rejected", "result_too_large"].includes(result?.code)
        ) {
          this.store.reject(
            job,
            `${result.code} at callback; job ${job.id}; correct the provider data and retry manually`,
          );
        } else {
          const detail = response.ok
            ? {
                category: "callback_pending",
                stage: "callback",
                job_id: job.id,
              }
            : workerDiagnostic(response.status, result, job.id);
          this.store.retry(job, JSON.stringify(detail));
          this.lastFailure = { ...detail, at: new Date().toISOString() };
          this.log(JSON.stringify({ event: "sync_retry", ...detail }));
        }
      }
    } catch (error) {
      const detail = {
        ...diagnostic(error, "worker_transport"),
        job_id: job.id,
      };
      this.store.retry(job, JSON.stringify(detail));
      this.lastFailure = { ...detail, at: new Date().toISOString() };
      this.log(JSON.stringify({ event: "sync_retry", ...detail }));
    } finally {
      this.lastCompleted = new Date().toISOString();
    }
  }

  fill() {
    if (this.stopped || this.paused) return;
    try {
      this.store.schedule();
      while (this.active.size < this.concurrency) {
        const job = this.store.nextJob();
        if (!job) break;
        this.lastStarted = new Date().toISOString();
        const work = this.deliver(job).finally(() => {
          this.active.delete(job.id);
          if (this.enabled && !this.paused && !this.stopped)
            queueMicrotask(() => this.fill());
        });
        this.active.set(job.id, work);
      }
    } catch (error) {
      const detail = diagnostic(error, "dispatcher");
      this.lastFailure = { ...detail, at: new Date().toISOString() };
      this.log(JSON.stringify({ event: "dispatcher_failure", ...detail }));
    }
  }

  async tick() {
    this.fill();
    await Promise.allSettled([...this.active.values()]);
  }

  async pause() {
    this.paused = true;
    await Promise.allSettled([...this.active.values()]);
  }

  resume() {
    this.paused = false;
    if (this.enabled) setImmediate(() => this.fill());
  }

  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.active.values()]);
  }

  status() {
    const queue = this.store.db
      .prepare(
        "SELECT SUM(state='pending') AS pending,SUM(state='running') AS running,SUM(state='failed') AS failed,MIN(CASE WHEN state='pending' THEN due END) AS oldest_due FROM jobs WHERE state IN ('pending','running','failed')",
      )
      .get();
    const stalled = Boolean(
      this.enabled &&
      !this.paused &&
      queue.oldest_due != null &&
      queue.oldest_due < Date.now() - 180000 &&
      this.active.size === 0,
    );
    return {
      ready: this.enabled && !this.stopped && !this.paused && !stalled,
      enabled: this.enabled,
      paused: this.paused,
      active: this.active.size,
      capacity: this.concurrency,
      pending: queue.pending ?? 0,
      running: queue.running ?? 0,
      failed: queue.failed ?? 0,
      oldest_due:
        queue.oldest_due == null
          ? null
          : new Date(queue.oldest_due).toISOString(),
      last_started: this.lastStarted,
      last_completed: this.lastCompleted,
      ...(this.lastFailure ? { last_failure: this.lastFailure } : {}),
    };
  }
}
