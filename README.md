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

用户扩展目录加软链（与 `pi-loop` 同款做法）：

```bash
ln -s /Users/jerry/project/pi-auto-continue ~/.pi/agent/extensions/pi-auto-continue
```

或临时加载：

```bash
pi --extension ./index.ts
```

## 开发

```bash
bun install
bun run check     # tsc --noEmit + oxlint + oxfmt --check
```

## 边界

- 上游若持续返回同一错误，本扩展会一直续跑（无次数上限）；要停下就发新消息、按 Escape 中断或 `/auto-continue off`
- 续跑会向上下文追加一条 `custom_message`（会显示在对话里），这是为了让请求体发生变化而不是原样重试
- 不修改历史消息，保持前缀缓存友好
