# pi-auto-continue

Pi 扩展：遇到指定上游 API 错误时自动续跑，省掉手动敲「继续」。

## 解决什么问题

上游模型服务偶发返回请求错误，例如：

```
Error: commandcode API error (400): {"message":"{\"type\":\"invalid_request_error\",\"code\":\"\",\"message\":\"invalid request error trace_id: ...\"}\n","type":"invalid_request_error"}
```

这类错误会结束当前轮，但上下文本身没坏 —— 重新发一次请求通常就能继续。
手动「继续」多了很打断节奏，本扩展在最终结算前自动补发一次请求。

## 工作方式

| 时机                             | 动作                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `agent_end`                      | 读取最后一条 assistant 消息的 `errorMessage`，命中匹配词则记为待续跑         |
| `agent_before_settle`            | 若本轮以 `error` 结束且有待续跑错误，追加一条提示消息并返回 `continue: true` |
| `before_agent_start`（用户消息） | 连击计数归零                                                                 |
| 某轮正常完成                     | 连击计数归零、清除状态栏                                                     |

状态栏显示 `自动续跑 n 次`；每次续跑都有通知，包含错误摘要与等待时长。

## 安全阀

- **只匹配白名单错误**：鉴权失败、额度不足等非白名单错误不会自动续跑
- **不设重试上限**：匹配错误持续出现就持续续跑，直到某轮正常完成或用户介入；退避等待封顶 60s
- **用户中断不续跑**：Escape 中断（`aborted`）不触发
- **人手介入重置**：发新消息即归零，不会吃掉新问题的额度
- **可随时关停**：`/auto-continue off`

## 配置

环境变量：

| 变量                        | 默认                                          | 说明                                         |
| --------------------------- | --------------------------------------------- | -------------------------------------------- |
| `PI_AUTO_CONTINUE`          | 开启                                          | 设为 `0` 关闭                                |
| `PI_AUTO_CONTINUE_MATCH`    | `commandcode API error,invalid_request_error` | 匹配词，逗号分隔，大小写不敏感               |
| `PI_AUTO_CONTINUE_DELAY_MS` | `1500`                                        | 退避基数（第 n 次等待 `n × 基数`，封顶 60s） |

命令：

```
/auto-continue          查看当前配置与连击数
/auto-continue on       开启
/auto-continue off      关闭
```

## 安装

pi-auto-continue 的主体是单个 TypeScript 文件 `index.ts`。Pi 内置 TypeScript 加载，不需要编译；`@earendil-works/pi-coding-agent` 由 Pi 宿主在运行时提供，因此普通用户不需要执行 `npm install`。

### 普通用户

推荐用 Pi 包安装，版本更新可用 `pi update --extensions` 统一处理：

```bash
# 用户级（写入 ~/.pi/agent/settings.json）
pi install git:github.com/jerryshell/pi-auto-continue

# 项目级（写入 .pi/settings.json）
pi install -l git:github.com/jerryshell/pi-auto-continue
```

卸载：

```bash
pi remove git:github.com/jerryshell/pi-auto-continue
```

手动安装：在仓库检出目录中把 `index.ts` 复制到扩展目录。

用户级（所有项目可用）：

```bash
mkdir -p ~/.pi/agent/extensions/pi-auto-continue
cp index.ts ~/.pi/agent/extensions/pi-auto-continue/index.ts
```

项目级（只对当前项目生效，需要项目信任）：

```bash
mkdir -p .pi/extensions/pi-auto-continue
cp index.ts .pi/extensions/pi-auto-continue/index.ts
```

Windows 的用户级路径为 `%USERPROFILE%\.pi\agent\extensions\pi-auto-continue\index.ts`。

不复制源码，直接按本地路径安装（在仓库目录中执行，改完执行 `/reload` 即生效）：

```bash
pi install "$(pwd)"
```

不改动配置，只试用一次：

```bash
pi --extension /path/to/pi-auto-continue
# 简写
pi -e /path/to/pi-auto-continue
```

`--extension` 接受单个扩展文件，也接受包含 `index.ts` 的目录。

验证：安装或复制完成后重启 Pi；已在会话中则执行 `/reload`。命令列表中出现 `/auto-continue` 即加载成功，执行 `/auto-continue` 可查看开关状态、匹配词与当前连击数。

### 扩展开发者

```bash
git clone https://github.com/jerryshell/pi-auto-continue.git
cd pi-auto-continue
bun install        # 开发依赖：类型检查与代码工具
bun run check      # tsc --noEmit + oxlint + oxfmt --check
pi -e .
```

把仓库目录链接到扩展目录，可省去手动复制，改完 `index.ts` 后在 Pi 中执行 `/reload` 即可生效：

```bash
# macOS / Linux
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-auto-continue

# Windows（目录联接）
mklink /J "%USERPROFILE%\.pi\agent\extensions\pi-auto-continue" "%CD%"
```

包清单：`package.json` 的 `pi.extensions` 声明入口 `./index.ts`，宿主包 `@earendil-works/pi-coding-agent` 放入 `peerDependencies`（`"*"`），`devDependencies` 只用于编辑器类型与 `bun run typecheck`。宿主提供的包不要放入 `dependencies`，否则会出现重复模块实例。日常用 `bun run format` 就地格式化，提交前用 `bun run check` 做总检查。

## 边界

- 上游若持续返回同一错误，本扩展会一直续跑（无次数上限）；要停下就发新消息、按 Escape 中断或 `/auto-continue off`
- 续跑会向上下文追加一条 `custom_message`（会显示在对话里），这是为了让请求体发生变化而不是原样重试
- 不修改历史消息，保持前缀缓存友好

## 许可

MIT，见 `LICENSE`。
