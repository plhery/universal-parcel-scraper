/**
 * The fresh-context skeleton the carrier capture helpers share: open a context (through the
 * request's proxy when `openContext` is given), count it, create a page, install the outbound
 * policy, then run the carrier's steps against a deadline and an optional abort signal.
 * Whatever happens, the context closes within `cleanupMs`; a close that does not finish asks
 * for the browser's replacement. A context that arrives after the deadline is closed on
 * arrival.
 *
 * The caller validates its budget before calling, and keeps its own capture state. Hooks run
 * in the order of a hand-written helper: `onExpire` when the deadline or the signal stops the
 * run, `onFailure` (before cleanup, so a reply keeps its timing and observed statuses)
 * when setup or the steps fail, and `onStop` before the context closes.
 */
export async function withHelperContext({
  handle, label, timeoutMs, signal, openContext, installPolicy, cleanupMs = 1500,
  check, closeOnAbort = false, replaceOpening = false, onExpire, onFailure, onStop,
}, steps) {
  const run = { context: undefined, page: undefined, expired: false };
  const closing = new WeakMap();
  let timer, abort, opening = false;
  const close = target => {
    if (closing.has(target)) return closing.get(target);
    const task = (async () => {
      let closed = false, cleanupTimer;
      try {
        await Promise.race([
          Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
          new Promise(resolve => { cleanupTimer = setTimeout(resolve, Math.max(1, cleanupMs)); }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
        if (!closed) handle.requestBrowserReplacement?.(`${label} context cleanup failed`);
      }
    })();
    closing.set(target, task);
    return task;
  };
  const checked = () => {
    if (run.expired) throw new Error(`${label} browser setup arrived after its deadline`);
    check?.();
  };
  const stopped = new Promise((_, reject) => {
    const stop = (kind, reason) => {
      run.expired = true;
      onExpire?.(kind);
      if (kind === 'abort' && closeOnAbort && run.context) void close(run.context);
      reject(reason);
    };
    timer = setTimeout(() => stop('deadline', new Error(`${label} browser deadline`)), Math.max(1, timeoutMs));
    if (signal) {
      abort = () => stop('abort', signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
  const work = (async () => {
    check?.();
    opening = true;
    const created = openContext ? await openContext() : await handle.browser.newContext();
    opening = false;
    if (!openContext) {
      try { handle.noteTemporaryContext?.(); } catch (error) { await close(created); throw error; }
    }
    if (run.expired) { await close(created); throw new Error(`${label} context arrived after its deadline`); }
    run.context = created;
    run.page = await created.newPage();
    checked();
    await installPolicy?.(run.page);
    checked();
    return steps(run);
  })();
  try {
    return await Promise.race([work, stopped]);
  } catch (error) {
    if (!onFailure) throw error;
    return await onFailure(error);
  } finally {
    run.expired = true;
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    try {
      onStop?.(run);
    } finally {
      if (opening && replaceOpening) handle.requestBrowserReplacement?.(`${label} context arrived after its deadline`);
      if (run.context) await close(run.context);
    }
  }
}
