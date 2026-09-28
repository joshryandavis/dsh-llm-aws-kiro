English | [中文](README.zh.md)

# dsh-llm-kiro

A Kiro provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM seam.

The package is a standalone Cordis plugin: it mounts in any harness composition through
`cordis.yml`, registers the `kiro` provider route on `ctx.llm`, and needs no changes to the
harness itself.

## What it handles

| Concern | Implementation |
|---|---|
| **Existing credentials** | Picks up an existing kiro-cli login (the `auth_kv` table of kiro-cli's SQLite store, IDC and social tokens) and the Kiro IDE token (`~/.aws/sso/cache/kiro-auth-token.json` with its OIDC client registration) — no second sign-in. An optional `bearerTokenEnv` reference bypasses ambient discovery for CI/bots. |
| **Token refresh** | Silent refresh of expired tokens through the AWS SSO OIDC `/token` endpoint (Builder ID / IAM Identity Center) or the Kiro desktop auth service (Google/GitHub social), write-back into the kiro-cli store so both consumers stay in sync; a 403 mid-stream re-reads the shared store and falls back to `kiro-cli debug refresh-auth-token`; last-resort failure surfaces as `MISSING_CREDENTIAL`/AUTH with guidance. |
| **The backend** | Region/endpoint resolution (SSO region → Kiro API region), the management control plane (`List-Available-Profiles`, `List-Available-Models`, shared `~/.kiro-management-models-cache.json` catalog cache), and the runtime `generateAssistantResponse` call over the AWS event-stream protocol (Smithy framing via `@smithy/core`), with capacity backoff, first-token timeout, and the harness idle watchdog. |
| **Models** | A bootstrap catalog mirroring the kiro-cli-verified menu (21 models with context windows, output caps, reasoning capability, image modality), exact wire-id resolution (dashed harness ids ⇄ dotted wire ids), and the authenticated management catalog, which refreshes the served metadata and appends models that shipped after the bootstrap list — reaching the model picker, not just the Models page. Reasoning efforts map the harness `off`/`low`/`high`/`max` vocabulary onto each model's authenticated effort schema, with the Kiro thinking markers on the system prompt. |

Every runtime request carries the harness attribution `User-Agent` (from `@deepseek-ai/dsh-llm`
`attributionHeaders()`) plus the AWS SDK-shaped `x-amz-user-agent` telemetry header the backend expects.

## Install

The package is ESM and declares the harness packages it talks to as peer dependencies — the host
DSH installation provides them. It also declares the `dsh` bundle manifest
(`cordis.patch.yml` ships with the package), so it mounts as a profile bundle as well as a
plain plugin dependency.

```bash
dsh plugin --profile <profile> add @joshryandavis/dsh-llm-kiro
```

Mount it in `cordis.yml`:

```yaml
- id: llm-kiro
  name: '@joshryandavis/dsh-llm-kiro'
  config:
    region: us-east-1        # optional; the credential's region wins when omitted
    reasoningEffort: high    # optional; off | low | high | max (default high)
```

That is the whole configuration for an existing kiro-cli or Kiro IDE login: credentials are picked
up ambiently, refreshed silently, and written back. A static bearer token works too:

```yaml
- id: llm-kiro
  name: '@joshryandavis/dsh-llm-kiro'
  config:
    bearerTokenEnv: KIRO_BEARER_TOKEN   # stored via the harness credentials service
```

## Config reference

All fields are optional; the `llm-kiro` user-settings section uses the same schema and can be
edited at runtime — a change reaches the next request without a restart.

| Field | Default | Meaning |
|---|---|---|
| `region` | credential's region, else `us-east-1` | Kiro API region override. |
| `runtimeURL` | `https://runtime.<region>.kiro.dev` | Runtime endpoint override for gateway/proxy deployments. |
| `profileArn` | management discovery | Profile ARN override. |
| `bearerTokenEnv` | — | Credential reference for a static bearer token; bypasses ambient discovery. |
| `thinking` | `enabled` | Deployment lock; `disabled` limits every request to `off`. |
| `reasoningEffort` | `high` | Default effort; `off` disables thinking. |
| `maxTokens` | `8192` | Default per-request output cap; per-model caps and explicit values win. |
| `defaultContextWindow` | `200000` | Context capacity for models without an exact value. |
| `models` | bootstrap catalog + authenticated discovery | Explicit model list; a non-empty value is served verbatim and disables discovery. |
| `streamIdleTimeoutMs` | `300000` | Per-read idle budget. |
| `firstTokenTimeoutMs` | `90000` | First-event budget; per-model overrides exist for slow models. |
| `retryPolicy` | normal, five retries | Provider-owned retry policy for `dsh-llm-retry`. |
| `kiroCliDbPath` | platform application-support | kiro-cli SQLite store override. |
| `ssoCacheDir` | `~/.aws/sso/cache` | Kiro IDE token directory override. |
| `allowKiroCliRefresh` | `true` | Whether 403 recovery may shell out to `kiro-cli`. |

## Models

Bootstrap catalog (harness id → wire id):

| Harness id | Wire id | Context | Reasoning | Images |
|---|---|---|---|---|
| `claude-opus-5-5` / `claude-opus-5` | `claude-opus-5.5` / `claude-opus-5` | 1M | ✓ | ✓ |
| `claude-opus-4-8` / `claude-opus-4-7` | `claude-opus-4.8` / `claude-opus-4.7` | 1M | ✓ | ✓ |
| `claude-opus-4-6` / `claude-opus-4-5` | `claude-opus-4.6` / `claude-opus-4.5` | 1M / 200K | ✓ | ✓ |
| `claude-sonnet-5` / `claude-sonnet-4-6` | `claude-sonnet-5` / `claude-sonnet-4.6` | 1M | ✓ | ✓ |
| `claude-sonnet-4-5` / `claude-sonnet-4` | `claude-sonnet-4.5` / `claude-sonnet-4` | 200K | ✓ | ✓ |
| `claude-haiku-4-5` | `claude-haiku-4.5` | 200K | ✗ | ✓ |
| `claude-fable-5` | `claude-fable-5` | 1M | ✓ | ✓ |
| `gpt-5-6-sol` / `gpt-5-6-terra` / `gpt-5-6-luna` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | 1M | ✓ | ✗ |
| `deepseek-3-2` | `deepseek-3.2` | 164K | ✓ | ✗ |
| `minimax-m2-5` / `minimax-m2-1` | `minimax-m2.5` / `minimax-m2.1` | 196K | ✗ | ✗ |
| `glm-5` | `glm-5` | 200K | ✓ | ✗ |
| `qwen3-coder-next` | `qwen3-coder-next` | 256K | ✓ | ✗ |
| `auto` | `auto` | 1M | ✓ | ✓ |

Both dashed and dotted spellings resolve to the wire id. The bootstrap list is the pre-discovery
fallback and the curated menu order; the authenticated management catalog
(`List-Available-Models`, per credential, per region) refreshes matched entries' capacities,
effort schemas, and reasoning metadata and appends models the bootstrap list has not learned yet.
Discovery reaches the harness model picker: reading the model list serves the cache immediately
and refreshes it in the background for the next read, so a slow or unreachable management endpoint
never delays a picker or a request. An explicit non-empty `models` list replaces discovery
entirely and is served verbatim.

The catalog cache at `~/.kiro-management-models-cache.json` is shared with pi-provider-kiro:
that tool writes format version 1, this provider reads that layout and writes version 2.

## Development

```bash
pnpm install
pnpm run build       # tsc -b: compiles this package; deps resolve from the published @deepseek-ai packages
pnpm test            # vitest suite (105 tests): endpoints, store, refresh, models, effort, serialize,
                     # translate, adapter transport, real Loader composition
```

Tests resolve the harness packages from the published `@deepseek-ai/*` packages in `node_modules`
(peer dependencies plus the dev-dependency set at the versions the code is developed against), so
they exercise the exact published APIs. Credential tests are fully isolated from the host
machine's real kiro-cli / Kiro IDE stores.

## Known limitations and deferred work

- **Interactive login** is not bundled: with no ambient credentials the provider fails with
  `MISSING_CREDENTIAL` and points at `kiro-cli login` or the Kiro IDE. A device-code flow can be
  added later on the management seam.
- **Legacy inline thinking dialect**: reasoning arrives through the native `thinkingText` events;
  models that emit `<thinking>` tags inside content keep them in the visible text block.
- **Replay state** is not emitted; history is resent as provider-neutral content on follow-ups.
- The management catalog refresh is pull-based, not scheduled: reading the model list serves the
  cached or bootstrap catalog and refreshes the cache for the next read, so the first read after the
  TTL can lag one launch behind the authenticated catalog.

## License

MIT
