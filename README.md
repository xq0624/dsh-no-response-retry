# dsh-no-response-retry

给 DeepSeek Harness（DSH）的「无反应重试」插件：**网络故障时服务将一直重试直到成功。仍可能随时停止，但开启后可能持续消耗 API 用量。**

复刻自 zcode 桌面端 设置 → AI → 无反应重试 开关的行为，做成 DSH 的 cordis 插件。

[English](README.en.md)

## 行为

- 挂在 agent loop 的请求恢复扩展点 `agent/request-error` 上：模型请求失败时，只要失败码属于「网络故障」集合（默认 `TRANSPORT`、`TIMEOUT`、`EMPTY_RESPONSE`、`SERVER`），就按指数退避**一直重试**，直到请求成功、你在界面上停止（随时可停），或插件被释放。
- 失败码不在集合内的失败（如限流 `RATE_LIMIT`、鉴权 `INVALID_CREDENTIAL`）不归它管，原样交给内置恢复链——DSH 自带的 `@deepseek-ai/dsh-llm-retry` 会按 provider 的 `retryPolicy`（默认最多 5 次）继续处理。
- 与内置重试共存：网络类失败先由内置策略试满 5 次，之后本插件接手无限重试；也可以在 provider 配置里把 `retryPolicy.mode` 设为 `always`，此时本插件就是唯一的重试执行者。
- 每次计划重试都会写入与会话事件 `llm/retry` / `llm/retry-started`（mode `always`），聊天界面里「等待重试模型请求」「正在重试模型请求」等提示直接复用宿主自带文案。

## 开关方式

- **配置**：插件页 / `cordis.patch.yml` 里 `enabled`（默认 `true`）。
- **会话内命令**：`/retry on`、`/retry off`、`/retry status`。手动开关只在当前进程内生效，优先于配置；`on`/`off` 之后再执行一次同参数即回显状态。

## 配置项

```yaml
- id: no-response-retry
  name: dsh-no-response-retry
  config:
    enabled: true                 # 总开关
    initialDelayMs: 1000          # 首次重试等待（毫秒），之后指数退避
    maxDelayMs: 30000             # 单次等待上限（毫秒）
    jitterRatio: 0.2              # 退避抖动比例（0~1）
    retryableCodes:               # 视为网络故障、参与无限重试的失败码
      - TRANSPORT
      - TIMEOUT
      - EMPTY_RESPONSE
      - SERVER
```

提供方返回有效且不超过 `maxDelayMs` 的 `Retry-After` 时，按提供方指示等待；超出上限则回到本地退避（无反应重试不会因等待过长而放弃）。

## 安装到其他电脑

前置条件：目标电脑装了 DeepSeek Harness（0.2.1-rc.2 及以上）并至少启动过一次（profile 已创建）。

**方式 0：从 GitHub 安装**

```bash
git clone https://github.com/xq0624/dsh-no-response-retry.git
powershell -NoProfile -ExecutionPolicy Bypass -File dsh-no-response-retry\install.ps1
```

不方便用 git 的话，直接下载 release 里的 tarball 交给 dsh 装也行：

```bash
dsh plugin --profile desktop add https://github.com/xq0624/dsh-no-response-retry/releases/latest/download/dsh-no-response-retry-0.1.0.tgz
```

**方式 A：一键脚本（推荐）**

把整个 `dsh-no-response-retry` 文件夹拷到目标电脑（至少要有 `install.ps1`、`install.cmd`、`dsh-no-response-retry-0.1.0.tgz` 三个文件），然后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1                # 装进 desktop profile
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Remove        # 卸载
```

或直接双击 `install.cmd`。脚本自动定位 dsh 安装目录（注册表 → 常见路径，找不到时加 `-DshDir` 参数）、自动用 dsh 自带的运行时跑 pnpm（不要求目标机装 Node）、自动维护 `dsh.profile.bundles`，全部落盘校验。装完重启 dsh 生效。

**方式 B：dsh 自带 CLI（干净的安装可用）**

```bash
dsh plugin --profile desktop add dsh-no-response-retry-0.1.0.tgz
```

注意：混装/手动升级过的 dsh（例如 rc.2 升 rc.3 后 `resources\app\runtime` 布局对不上）CLI 会因 pnpm 路径失效而报错，此时用方式 A。

**方式 C：手动**

1. 在 `%DSH_HOME%（默认 ~\.dsh）\profiles\desktop` 下用 dsh 自带 pnpm 安装包：
   `"D:\...\DSH\DeepSeek Harness.exe" --expose-internals "D:\...\DSH\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs" add <tgz 路径>`（设 `ELECTRON_RUN_AS_NODE=1`，或用任意 ≥22.5 的 node 跑同一个 pnpm.mjs）；
2. 编辑该目录 `package.json`：`dsh.profile.bundles` 数组加入 `"dsh-no-response-retry"`；
3. 重启 dsh。

**可选**：发布到 npm 后，任何机器都能 `dsh plugin add dsh-no-response-retry` 一行装好；目前是本地私有插件，用上面的离线方式即可。

## 安装

```bash
dsh plugin --profile desktop add dsh-no-response-retry-0.1.0.tgz
```

或手动安装：把包放进 profile 的 `node_modules`，在 profile 的 `package.json` 里：

1. `dependencies` 加入 `"dsh-no-response-retry": "file:…tgz"`（pnpm add 会自动做）；
2. `dsh.profile.bundles` 数组加入 `"dsh-no-response-retry"`。

包内自带 `dsh.bundle.patch`（`cordis.patch.yml`），重启 dsh 即生效。

> **兼容性**：面向 dsh 0.2.1-rc.2 / rc.3。宿主包走 `peerDependencies`，不随插件装进 profile。

## 文件

- `lib/index.js` — 插件本体（无反应重试 + `/retry` 命令）
- `cordis.patch.yml` — bundle patch，自插入默认配置
- `locale/zh.json`、`locale/en.json` — 插件页标题与描述

## License

MIT
