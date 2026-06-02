// Derive an AbortSignal from an Express response that fires only when the client
// disconnects *before the response is finished* — i.e. a genuine cancel (browser
// fetch aborted, tab closed, network drop) rather than the normal end of a
// request. Long-running route handlers that proxy a streamed upstream call (e.g.
// the Local LLM playground streaming a model's tokens) can forward this signal so
// the upstream reader tears down the moment the user hits Cancel instead of
// running on to a multi-minute timeout with no one left to receive the response.
//
// We key off `res`'s `close` event, NOT `req`'s: `req` (the IncomingMessage) can
// emit `close` once the request body is fully consumed — which, after body
// parsing, is before the handler even runs — so a `req`-based signal would abort
// every normal request immediately. `res` `close` fires when the response is done
// OR the connection drops; we only treat it as a cancel when the response had not
// finished writing (`writableEnded` false), which is the disconnect case.
//
// The listener only calls `controller.abort()`, which can't throw — safe to attach
// outside the request lifecycle without a try/catch.
export function abortSignalFromResponse(res) {
  const controller = new AbortController();
  if (res?.writableEnded || res?.destroyed) return controller.signal;
  res?.once?.('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
