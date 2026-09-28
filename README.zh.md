# dsh-llm-kiro

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM 接入层提供 Kiro 提供方。

该包是一个独立的 Cordis 插件：通过 `cordis.yml` 挂载到任意 harness 组合中，在 `ctx.llm` 上注册 `kiro`
提供方路由，无需改动 harness 本身。

## 它处理什么

| 关注点 | 实现 |
| --- | --- |
| **现有凭据** | 自动拾取已有的 kiro-cli 登录（kiro-cli SQLite 存储的 `auth_kv` 表，IDC 和社会登录 token）以及
  Kiro IDE token（`~/.aws/sso/cache/kiro-auth-token.json` 及其 OIDC 客户端注册）——无需二次登录。可选的
  `bearerTokenEnv` 引用可绕过环境发现，供 CI/机器人使用。 |
| **Token 刷新** | 通过 AWS SSO OIDC `/token` 端点（Builder ID / IAM Identity Center）或 Kiro 桌面认证服务
  （Google/GitHub 社会登录）静默刷新过期 token，并写回 kiro-cli 存储，保证两个使用方保持同步；流中途
  收到 403 时重新读取共享存储，并回退到 `kiro-cli debug refresh-auth-token`；最后的兜底失败以
  `MISSING_CREDENTIAL`/AUTH 及指引形式呈现。 |
| **后端** | 区域/端点解析（SSO 区域 → Kiro API 区域）、管理控制面（`List-Available-Profiles`、
  `List-Available-Models`、共享的 `~/.kiro-management-models-cache.json` 目录缓存），以及通过 AWS
  event-stream 协议（经 `@smithy/core` 的 Smithy 组帧）发起的运行时 `generateAssistantResponse` 调用，
  带容量退避、首 token 超时和 harness 空闲看门狗。 |
| **模型** | 一份镜像 kiro-cli 已验证菜单的引导目录（21 个模型，含上下文窗口、输出上限、推理能力、图像模态），
  精确的线上 id 解析（带连字符的 harness id ⇄ 带点的线上 id），以及经过认证的管理目录：它会刷新所服务的元数据，
  并追加引导清单发布之后才上线的模型——不仅作用于 Models 页面，也直接作用于模型选择器。
  推理强度把 harness 的 `off`/`low`/`high`/`max` 词汇映射到每个模型各自认证的 effort schema，
  并在系统提示上带上 Kiro 的思考标记。 |

每个运行时请求都携带 harness 属性化的 `User-Agent`（来自 `@deepseek-ai/dsh-llm` 的
`attributionHeaders()`），以及后端期望的 AWS SDK 风格的 `x-amz-user-agent` 遥测头。

## 安装

该包是 ESM，并把所依赖的 harness 包声明为 peer dependencies——由宿主 DSH 安装提供。它还声明了 `dsh`
bundle 清单（`cordis.patch.yml` 随包发布），因此既可以作为普通插件依赖挂载，也可以作为 profile bundle 挂载。

```bash
dsh plugin --profile <profile> add @joshryandavis/dsh-llm-kiro
```

在 `cordis.yml` 中挂载：

```yaml
- id: llm-kiro
  name: '@joshryandavis/dsh-llm-kiro'
  config:
    region: us-east-1        # 可选；省略时以凭据的区域为准
    reasoningEffort: high    # 可选；off | low | high | max（默认 high）
```

对于已有的 kiro-cli 或 Kiro IDE 登录，这已经是全部配置：凭据被自动拾取、静默刷新并写回。静态 bearer token
也可以：

```yaml
- id: llm-kiro
  name: '@joshryandavis/dsh-llm-kiro'
  config:
    bearerTokenEnv: KIRO_BEARER_TOKEN   # 通过 harness 凭据服务存储
```

## 配置参考

所有字段都可选；`llm-kiro` 用户设置区使用同一套 schema，可以在运行时编辑——修改无需重启即可作用于下一个请求。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `region` | 凭据的区域，否则 `us-east-1` | Kiro API 区域覆盖。 |
| `runtimeURL` | `https://runtime.<region>.kiro.dev` | 运行时端点覆盖，用于网关/代理部署。 |
| `profileArn` | 管理发现 | Profile ARN 覆盖。 |
| `bearerTokenEnv` | — | 静态 bearer token 的凭据引用；绕过环境发现。 |
| `thinking` | `enabled` | 部署锁；设为 `disabled` 会把每个请求都限制为 `off`。 |
| `reasoningEffort` | `high` | 默认推理强度；`off` 禁用思考。 |
| `maxTokens` | `8192` | 默认的每请求输出上限；按模型的上限和显式值优先。 |
| `defaultContextWindow` | `200000` | 没有精确值时的上下文容量。 |
| `models` | 引导目录 + 认证发现 | 显式模型列表；非空时原样提供并关闭发现。 |
| `streamIdleTimeoutMs` | `300000` | 每次读取的空闲预算。 |
| `firstTokenTimeoutMs` | `90000` | 首事件预算；慢模型另有按模型覆盖。 |
| `retryPolicy` | normal，五次重试 | 提供给 `dsh-llm-retry` 的提供方自有重试策略。 |
| `kiroCliDbPath` | 平台应用支持目录 | kiro-cli SQLite 存储覆盖。 |
| `ssoCacheDir` | `~/.aws/sso/cache` | Kiro IDE token 目录覆盖。 |
| `allowKiroCliRefresh` | `true` | 403 恢复是否允许调用 `kiro-cli`。 |

## 模型

引导目录（harness id → 线上 id）：

| Harness id | 线上 id | 上下文 | 推理 | 图像 |
| --- | --- | --- | --- | --- |
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

带连字符和带点的两种写法都会解析到线上 id。引导清单是发现之前的回退项，也决定精选菜单顺序；经过认证的
管理目录（`List-Available-Models`，按凭据、按区域）会刷新已匹配条目的容量、推理强度阶梯和推理元数据，
并追加引导清单尚未收录的模型。发现会直达 harness 模型选择器：读取模型列表时立即返回缓存内容，并在后台为
下一次读取刷新缓存，因此管理端点缓慢或不可达都不会拖慢选择器或请求。显式配置的非空 `models` 列表会完全
替代发现，并原样提供。

`~/.kiro-management-models-cache.json` 的目录缓存与 pi-provider-kiro 共享：该工具写入格式版本 1，
本提供方读取该布局，并写入版本 2。

## 开发

```bash
pnpm install
pnpm run build       # tsc -b：编译本包；依赖从已发布的 @deepseek-ai 包解析
pnpm test            # vitest 套件（105 个测试）：端点、存储、刷新、模型、推理强度、序列化、
                     # 翻译、适配器传输、真实 Loader 组合
```

测试从 `node_modules` 中已发布的 `@deepseek-ai/*` 包解析 harness 包（peer dependencies 加上按代码开发所
针对版本固定的 dev-dependency 集合），因此它们验证的是确切发布的 API。凭据测试与宿主机器真实的 kiro-cli /
Kiro IDE 存储完全隔离。

## 已知限制与待办工作

- **未捆绑交互式登录**：没有环境凭据时，提供方以 `MISSING_CREDENTIAL` 失败，并指向 `kiro-cli login` 或
  Kiro IDE。设备码流程可以日后在管理接缝上补充。
- **遗留的内联思考方言**：推理通过原生的 `thinkingText` 事件到达；在内容里发出 `<thinking>` 标签的模型会
  在可见文本块中保留它们。
- **不发出回放状态**：跟进时历史会以提供方无关的内容重新发送。
- 管理目录刷新是拉取式的，并非定时任务：读取模型列表时返回缓存或引导目录，并为下一次读取刷新缓存，
  因此超过 TTL 后的首次读取可能比已认证目录落后一次启动。

## 许可证

MIT
