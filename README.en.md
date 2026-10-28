# dsh-no-response-retry

A "no-response retry" plugin for DeepSeek Harness (DSH): **on network failure the service keeps retrying the model request until success. It may still stop at any time, but when enabled it may continuously consume API usage.**

Mirrors the toggle in zcode desktop (Settings → AI → No-response retry) as a DSH cordis plugin.

[简体中文](README.md)

## Behavior

- Hooks the agent loop's request-recovery extension point `agent/request-error`: when a model request fails with a failure code in the network-fault set (default `TRANSPORT`, `TIMEOUT`, `EMPTY_RESPONSE`, `SERVER`), it retries with exponential backoff **forever** until the request succeeds, you stop it in the UI, or the plugin is disposed.
- Failures outside that set (e.g. `RATE_LIMIT`, `INVALID_CREDENTIAL`) are delegated downstream untouched — the bundled `@deepseek-ai/dsh-llm-retry` keeps handling them under each provider's `retryPolicy` (5 bounded retries by default).
- Coexists with the built-in retry: network-class failures first consume the built-in's 5 attempts, then this plugin takes over indefinitely; or set the provider's `retryPolicy.mode` to `always` and this plugin becomes the sole retrier.
- Every scheduled retry appends the same session events as the built-in plugin (`llm/retry` / `llm/retry-started`, mode `always`), so the chat UI's native retry hints keep working.

## Toggling

- **Config**: `enabled` in the plugin page / `cordis.patch.yml` (default `true`).
- **In-chat command**: `/retry on`, `/retry off`, `/retry status`. Manual overrides live in-process and win over config.

## Config

```yaml
- id: no-response-retry
  name: dsh-no-response-retry
  config:
    enabled: true
    initialDelayMs: 1000
    maxDelayMs: 30000
    jitterRatio: 0.2
    retryableCodes: [TRANSPORT, TIMEOUT, EMPTY_RESPONSE, SERVER]
```

A valid provider `Retry-After` within `maxDelayMs` is honored; a longer one falls back to local backoff (never gives up because a delay is long).

## Install

```bash
git clone https://github.com/xq0624/dsh-no-response-retry.git
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-no-response-retry\install.ps1
```

Or hand the release tarball straight to dsh:

```bash
dsh plugin --profile desktop add https://github.com/xq0624/dsh-no-response-retry/releases/latest/download/dsh-no-response-retry-0.1.0.tgz
```

Or manually: place the package in the profile's `node_modules`, add it to `dependencies` via pnpm, and list `"dsh-no-response-retry"` under `dsh.profile.bundles`. The bundled `dsh.bundle.patch` self-inserts the default config; restart dsh to load.

## License

MIT
