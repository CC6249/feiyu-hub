# config.json 字段表

默认位置：安装目录下的 `config.json`。可用环境变量 `FEIYU_CONFIG=/path/to/other.json` 覆盖。

**任何字符串字段都支持 `${ENV_NAME}` 占位符**，启动时从环境变量展开——密码、token 路径都可以不落盘。

写错的字段不会导致启动失败：非法项被跳过并记入 `warnings`（`GET /api/config` 可查）。

---

## 顶层

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `site.name` | string | `肥鱼控制中心` | 页面标题、PWA 应用名 |
| `site.shortName` | string | 同 `name` | 主屏图标下的短名（建议 ≤4 字） |
| `site.subtitle` | string | `feiyu hub` | 副标题，空服务时也显示 |
| `site.footer` | string | `feiyu hub` | 页脚文字 |
| `bind` | string | `0.0.0.0` | 监听地址。容器里必须是 `0.0.0.0`；只给本机用可设 `127.0.0.1` |
| `port` | number | `18765` | 面板端口 |
| `auth` | object\|null | `null` | 访问鉴权，见下 |
| `tokens` | object | `{}` | 凭据来源，被 `proxy` 卡片引用 |
| `services` | array | `[]` | 卡片列表 |

### `auth`（可选）

| 字段 | 类型 | 说明 |
|---|---|---|
| `user` | string | 用户名 |
| `password` | string | 密码。**留空等于关闭鉴权**。支持 `${ENV}` 写法 |
| `realm` | string | 浏览器登录框标题，默认 `Feiyu Hub` |

开启后整个面板（含 API）走 HTTP Basic Auth，`/healthz` 除外（供探活）。
浏览器会用原生弹窗要账号密码，前端无需改动。

---

## `services[]` 每张卡片

### 公共字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | **必填** | 唯一标识；同时决定前端图标（见「图标」） |
| `name` | string | **必填** | 卡片标题 |
| `desc` | string | `''` | 副标题，一行省略号截断 |
| `group` | string | `服务` | 分组标题，空值归入「服务」 |
| `accent` | string | `blue` | 主题色：`blue` `amber` `violet` `green` `cyan` `pink` |
| `badge` | string | `''` | 右侧的小标签文字，通常是端口号 |
| `type` | string | `direct` | `direct` 或 `proxy` |
| `path` | string | `/` | 目标路径，可带 query |
| `probePath` | string | 同 `path` | 探活路径。目标首页慢时可指向 `/favicon.ico` 之类 |
| `probeTimeoutMs` | number | `2500` | 单次探活超时 |
| `enabled` | bool | `true` | 设 `false` 可暂时隐藏而不删配置 |
| `openInNewTab` | bool | `true` | `false` 则当前标签页打开 |
| `url` | string | `''` | 完全自定义地址模板，支持 `{host}` `{port}` `{path}` `{proto}`；填了就不再按 type 拼地址 |
| `secret` | string | `''` | 点开卡片时自动复制的密钥（剪贴板） |
| `secretLabel` | string | `密钥` | 复制成功提示里的名字，如 `VNC 密码` |
| `autocopy` | bool | `false` | 是否启用「点开即复制」。`secret` 非空时才有意义 |

### `direct` 专有

| 字段 | 类型 | 说明 |
|---|---|---|
| `port` | number | 目标端口，**必填**（除非给了 `url`） |

卡片地址 = `http://<浏览器访问面板用的主机名>:<port><path>`。
用请求的 `Host` 动态拼，所以同一个面板在局域网 IP、内网域名、VPN IP 下访问都对。

### `proxy` 专有

| 字段 | 类型 | 说明 |
|---|---|---|
| `proxyPort` | number | Hub 为这张卡片额外监听的端口，**必填**，不能与 `port` 或其他 `proxyPort` 重复 |
| `upstream.host` | string | 上游地址，默认 `127.0.0.1` |
| `upstream.port` | number | 上游端口，**必填** |
| `upstream.probePath` | string | 探活路径，默认 `/` |
| `inject.kind` | string | `query-token` 或 `none` |
| `inject.tokenId` | string | 引用 `tokens` 里的键名 |
| `probeWithToken` | bool | 探活时也带上 token（上游对未带 token 的请求返回 401 时打开） |

反代会把 `Host` / `Origin` / `Referer` 改写为上游地址，并抹掉响应里 `Set-Cookie` 的 `Domain`，
让 cookie 跟随浏览器实际访问的主机名。WebSocket（`Upgrade`）同样转发并注入 token。

**为什么每张卡片独占一个端口**：上游常常带 `X-Frame-Options: DENY`、CSP `default-src 'self'`，
前端也常写死绝对路径 `/static/...`。用 `/sub/` 子路径反代必然碎，独立端口才稳。

---

## `tokens.<id>`

两种来源，二选一。不配也不报错，只是不注入。

### 文件型

```json
{ "type": "file", "path": "/opt/myapp/state/token" }
```

每次需要时重读文件（文件小，开销可忽略），内容变了立即生效。

### 命令型

```json
{
  "type": "command",
  "cmd": "sudo",
  "args": ["-n", "journalctl", "-u", "dsh", "--no-pager", "-o", "cat"],
  "regex": "token=([A-Za-z0-9_-]{20,})",
  "pick": "last",
  "ttlSec": 300,
  "timeoutMs": 12000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `cmd` | `sudo` | 可执行文件 |
| `args` | `[]` | 参数数组 |
| `regex` | `([A-Za-z0-9_-]{20,})` | 捕获组 1 即凭据。**必须带捕获组** |
| `pick` | `last` | 多条命中时取第一条还是最后一条 |
| `ttlSec` | `300` | 缓存时长；`0` 表示每次都跑 |
| `timeoutMs` | `12000` | 命令超时 |

命令以 Hub 进程的身份执行。需要读 root 日志时用 `sudo -n`（免密），没配免密会失败并在日志里告警——
不配也别慌，代理照常工作，只是浏览器会看到上游的 401。

---

## 图标

前端内置这些图标 key：`snowluma` `ha` `novnc` `fnos` `invr` `bridge` `dsh`。
`icon` 字段可显式指定；不填则用 `id` 去匹配；都匹配不上用通用方块图标。
自定义图标需要改 `public/index.html` 里的 `ICONS` 对象，其余情况不用碰前端。

---

## 最小可用示例

```json
{
  "port": 18765,
  "services": [
    { "id": "nas", "name": "NAS 面板", "type": "direct", "port": 5000, "badge": "5000" }
  ]
}
```

启动后访问 `http://<IP>:18765` 就能看到一张卡片。

## 完整示例

见发行包根目录的 `config.example.json`（含 direct / proxy / 密钥自动复制 / 两种 token 来源）。
