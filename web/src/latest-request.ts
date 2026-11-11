type RequestResult<Value> =
  { current: true; value: Value } | { current: false };

export function createLatestRequest<Value>() {
  let sequence = 0;
  let controller: AbortController | undefined;
  return {
    cancel() {
      sequence++;
      controller?.abort();
      controller = undefined;
    },
    async run(
      request: (signal: AbortSignal) => Promise<Value>,
    ): Promise<RequestResult<Value>> {
      const current = ++sequence;
      controller?.abort();
      const next = new AbortController();
      controller = next;
      try {
        const value = await request(next.signal);
        return current === sequence
          ? { current: true, value }
          : { current: false };
      } catch (error) {
        if (current !== sequence) return { current: false };
        throw error;
      } finally {
        if (controller === next) controller = undefined;
      }
    },
  };
}
