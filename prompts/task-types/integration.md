# Integration Task Playbook

The user is integrating an external service (payment provider, messaging API,
auth provider, third-party SDK). Apply this playbook in addition to the mode
prompt.

External integrations are **failure-mode-rich**: network errors, rate limits,
partial failures, replay attacks, secret leaks. The playbook focuses on those.

## Mandatory exploration

1. **Find the canonical existing integration** in the same folder. Cite it.
   Mirror its structure: client setup, auth, retry wrapper, error mapping,
   env-var reading.
2. **Identify env-var conventions.** Where do secrets live? How are they read
   (a config module, raw `process.env`)? How are they surfaced to the user
   when missing? Match this exactly.
3. **Identify the retry / timeout / circuit-breaker utility** the rest of
   the codebase uses. Reuse it.
4. **For webhooks**: read the existing signature-verification helper.
   Confirm replay protection (timestamp check, nonce, idempotency key).
5. **For long-running operations**: identify the queue / job runner pattern.
6. **Read the vendor's documentation** for the specific operation. Cite the
   URL. Confirm against the *installed SDK version*, not the latest docs.
7. **Read the existing test pattern** for integrations (mocked? recorded?
   sandbox?). The new integration must follow it.

## Required Risks coverage

Integration Risks must explicitly address each:

- **Secret leakage** — every place a secret could be logged, returned in
  an error message, exposed in a stack trace, or committed to source.
  Confirm none of these happen.
- **Rate-limit handling** — vendor limits (per second / minute / day),
  detection (status codes / headers), backoff strategy. For high-volume
  paths, queue or batch.
- **Partial failure semantics** — what happens if the call returns 500,
  times out, or partially succeeds? Retry? Idempotent? User-visible
  error?
- **Idempotency for write operations** — if the call could be retried,
  the vendor side must dedupe. State the idempotency key strategy
  (request ID, business key).
- **Webhook replay attacks** — timestamp window, signature verification,
  nonce / event ID dedup. Each is a separate bullet.
- **Graceful degradation** — when the external service is fully down,
  what's the user-facing behavior? Hard fail? Cached fallback? Queue?
- **Cost** — per-call pricing for paid APIs (Stripe, Twilio, OpenAI,
  Anthropic). Note how a runaway loop would be bounded.
- **Timeout values** — SDK / HTTP client default timeouts are often too
  long. State the timeout you chose and why.
- **Vendor outage / deprecation** — is this vendor a single point of
  failure? Is there a fallback or just a hard dependency?
- **Compliance / data residency** — if the integration sends user data
  abroad or to a third party, note the compliance implications.

## Required Verification coverage

- **Local env setup** — exact env vars to set, sandbox credentials
- **Test command** — both mocked unit tests and (if applicable) the
  command to run against the sandbox
- **End-to-end manual recipe** — `curl` or app flow to trigger the
  integration; what success looks like; what failure looks like
- **Log shape on success / failure** — what to grep for in logs
- **Webhook replay test** — if applicable, command to replay an event
  and confirm idempotency

## Anti-patterns to flag

- Hardcoded API keys (even in tests)
- New integration that doesn't use the existing retry / timeout helper
- Logging the full request body (often contains secrets / PII)
- No timeout on HTTP calls (default infinite-wait kills processes)
- `try/catch` that swallows the error and returns success
- Webhook handler without signature verification
- Webhook handler without dedup (vendor will replay on transient failures)
- Synchronous / blocking call in a request handler that should be async
- "Test in production" — no sandbox / mock setup at all
- Storing PII without checking against the project's data classification
- Reading `process.env.X` inline instead of through the config module
