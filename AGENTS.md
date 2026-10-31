# AGENTS.md — 给 AI 助手的部署手册

> 你（AI 助手）正在帮用户在一台机器上部署 **Feiyu Hub**：一个零依赖的 Node.js 服务聚合看板。
> 它把用户机器上散落的各种 Web 后台（NAS 面板、智能家居、远程桌面、自建工具……）收拢到一个页面里，
> 支持移动端 PWA「添加到主屏幕」，并且能给只监听 `127.0.0.1` 的服务做反代 + 服务端注入凭据。
>
> 这个文件是**自包含**的。按顺序执行即可，不需要额外资料。

---

## 0. 五条铁律（先读完再动手）

1. **不要改代码。** 这个发行包是成品，所有可配置项都在 `config.json` 里。改 `server.mjs` 会导致后续无法升级。
2. **不要猜服务清单。** 用户机器上有哪些服务、端口是多少，只有用户知道。第 4 步必须问，或让用户直接给你一份清单。
3. **访问方式必须先问，不能默认。** 只在内网用、Tailscale 组网、DDNS + 端口映射、云服务器固定 IP——这四条路要动的东西完全不同，第 2 步必须让用户选。用户没选之前：不动路由器端口映射、不开 frp/DDNS、不装组网客户端、不 `ufw allow from any`。
4. **不要在没装 Node 的机器上硬来。** 第 1 步探测失败就停下来告诉用户装什么，不要用 Python/Go 重写一遍。
5. **每一步都要有验证证据。** 装完必须跑 `verify.mjs` 并把结论贴给用户，不要只说「应该好了」。

---

## 1. 环境探测（约 30 秒）

先确认平台和 Node 版本，一条命令即可：

```bash
# Linux / macOS
node -v 2>/dev/null || echo NO_NODE
uname -s
```

```powershell
# Windows
node -v; if ($LASTEXITCODE -ne 0) { "NO_NODE" }
```

判定：

| 结果 | 动作 |
|---|---|
| `v18` / `v20` / `v22` 等 ≥ v18 | 继续第 2 步 |
| `NO_NODE` 或 v16 及以下 | **停下**，按下面提示用户装 Node，装完再继续 |

给用户的安装命令（不要自己乱选源）：

```bash
# Debian / Ubuntu / fnOS
sudo apt update && sudo apt install -y nodejs

# 版本太老时用 NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```
```powershell
# Windows
winget install OpenJS.NodeJS.LTS
```

> fnOS（飞牛）常见情况：系统自带 node 在 `/usr/local/nodejs/bin/node`，但不在普通用户 PATH 里。
> 此时 `node -v` 会失败，但下面的安装脚本自己会去这个路径找，可以直接继续。

---

## 2. 问清访问方式（**安装之前必须问**）

面板装完从哪儿打开，决定了三件事：`bind` 绑哪张网卡、要不要开密码、装完还要做哪些网络动作。**不要默认用户只在内网用，更不要先装了再问。**

用一句话把问题问清楚，别一次性甩四个方案让用户懵：

> 「你打算在什么网络下打开这个页面——**只在家里**、**人在外面也要连**、还是**想用域名 / 公网 IP** 访问？」

按他的回答对应到下面四种之一：

| 选项 | 用户原话通常是 | 安装时怎么做 | 装完还要做什么 |
|---|---|---|---|
| **A 只在内网** | “家里用用”“手机连同一个 Wi-Fi” | `bind: "0.0.0.0"`；`auth` 可以留空 | 不用做别的。给他 `http://<局域网IP>:<端口>` |
| **B 组网（Tailscale / ZeroTier）** | “人在外面也想连家里”“没有公网 IP” | 同上；`auth` 建议设，别长期留空 | 机器和手机装客户端、登录同一账号；`tailscale ip -4` 拿 `100.x.x.x`。**不要开 Tailscale Funnel**，那等于把面板挂到公网 |
| **C DDNS + 端口映射 / 内网穿透（frp、cloudflared、NPS）** | “我有域名”“想用域名访问” | **先**把 `auth.password` 填好，再对外 | 先确认真的有公网 IP（`curl ifconfig.me` 的结果和路由器 WAN 口不一致 = 没有）；路由器映射面板端口 → 本机；运营商多封 80/443，用 8443 这类高位端口；能上 HTTPS 就上 |
| **D 云服务器固定 IP** | “想放云上”“有台小服务器” | 在云主机上装 Hub；安全组**只**放面板端口 | 云机到家里的服务要么走反向隧道、要么两边组网；对外建议套 Caddy/Nginx 上 TLS |

拿到答案之后：

- **A / B**：直接装，别动路由器。
- **C / D**：**先在 `config.json` 里把 `auth.password` 设好，再开端口**，顺序不要反。默认无密码的面板被扫到就是全裸。
- 用户选 C 但其实没有公网 IP（双层 NAT、运营商大内网）→ 停下来告诉他直连这条路不通，改用「穿透」变体：frp / cloudflared 只需要一台有公网的中转机，家里不需要公网 IP。
- 用户说“都想要”→ 按最严格的那条走（先设密码），再补网络。

> 访问方式只影响 `bind` 和 `auth`，**不影响 `services`**：卡片地址是按你访问时用的 `Host` 动态生成的。同一份 `config.json`，用局域网 IP 打开卡片就指向局域网 IP，用 `100.x` 打开就指向 `100.x`，用域名打开就指向域名。

---

## 3. 安装（选一个平台）

解压发行包后，**在包目录里**执行。两个脚本都是幂等的，重复执行不会搞坏已有配置。

### Linux / NAS（fnOS、Debian、Ubuntu、群晖宿主、ARM 也行）

```bash
chmod +x scripts/*.sh
sudo bash scripts/install.sh
```

它会做六件事：找 node → 复制到 `/opt/feiyu-hub` → 生成 `config.json` → 注册 systemd（`feiyu-hub.service`，开机自启）→ 启动 → 自检。

常用变体：

```bash
bash scripts/install.sh --prefix ~/feiyu-hub     # 不用 sudo，装到用户目录
bash scripts/install.sh --port 18800             # 首次安装就换面板端口
bash scripts/install.sh --no-service             # 只铺文件，不装 systemd（容器环境用这个）
bash scripts/install.sh --force                  # 覆盖已有 config.json（会丢配置）
```

> 没有 sudo 权限时脚本会自动退到 `~/.local/share/feiyu-hub` 并跳过 systemd，这是设计行为，不是失败。

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

它会复制到 `%LOCALAPPDATA%\FeiyuHub`、生成 `config.json`、建桌面快捷方式 `Feiyu Hub`、启动并自检。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Port 18800
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -AutoStart    # 顺手加开机自启
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NoStart      # 只装不启动
```

### macOS（无 systemd，手动跑）

```bash
bash scripts/install.sh --prefix ~/feiyu-hub --no-service
node scripts/verify.mjs --url http://127.0.0.1:18765
```

需要常驻就自己写 launchd plist，或在 tmux 里 `bash ~/feiyu-hub/scripts/start.sh`。

---

## 4. 配置服务清单（**必须问用户**）

装好的 `config.json` 是一份示例模板（里面举了 Home Assistant / noVNC / NAS 面板等例子），
用户机器上大概率端口对不上。**不要假设，去问**，一次问清三件事：

1. 想放哪些服务？每个服务的**名称**和它在机器上的**端口**。
2. 其中有没有**只监听 127.0.0.1** 的（比如自建的后台管理页面）？这类要用 `proxy` 类型。
3. 有没有「打开时要自动复制密码」的（典型是 noVNC 远程桌面）？

拿到答案后编辑 `<安装目录>/config.json`，两种卡片写法：

```jsonc
// direct：浏览器直连目标端口，最常用，零配置负担
{
  "id": "ha",                    // 唯一 id，也是前端图标的 key
  "name": "Home Assistant",
  "desc": "智能家居面板",
  "group": "核心",
  "accent": "amber",             // blue|amber|violet|green|cyan|pink
  "badge": "8123",
  "type": "direct",
  "port": 8123,
  "path": "/"                    // 可选，默认 "/"
}

// proxy：目标只监听 127.0.0.1，由 Hub 反代 + 服务端注入 token
{
  "id": "myapp",
  "name": "我的后台",
  "group": "控制",
  "type": "proxy",
  "proxyPort": 18766,            // Hub 自己监听的新端口，不能和别的重复
  "upstream": { "host": "127.0.0.1", "port": 8080, "probePath": "/" },
  "inject": { "kind": "query-token", "tokenId": "myapp" }
}
```

token 从哪来，在顶层 `tokens` 里定义（两种来源，二选一）：

```jsonc
"tokens": {
  // 从文件读（每次请求都会重读，文件变了立即生效）
  "myapp": { "type": "file", "path": "/opt/myapp/state/token" },

  // 从命令输出里正则提取（带 TTL 缓存 + 并发去重）
  "dsh": {
    "type": "command",
    "cmd": "sudo",
    "args": ["-n", "journalctl", "-u", "dsh", "--no-pager", "-o", "cat"],
    "regex": "token=([A-Za-z0-9_-]{20,})",
    "pick": "last",
    "ttlSec": 300
  }
}
```

改完保存，热加载：

```bash
curl -s http://127.0.0.1:18765/api/reload
# {"ok":true,"services":5,"warnings":[],"restartRequired":false,"note":"已热加载"}
```

`restartRequired: true` 说明改了 `port` / `proxyPort` / `upstream`，需要重启进程：

```bash
sudo systemctl restart feiyu-hub          # Linux / systemd
```
```powershell
# Windows：关掉旧的黑窗口，重新双击桌面 Feiyu Hub
```

> **字段写错不会让程序崩。** 非法项会被跳过并写进 `warnings`，用 `/api/config` 或 `verify.mjs` 都能看到。
> 所以放心改，改坏了看警告。

---

## 5. 验证（必须做，且把结论贴给用户）

```bash
node <安装目录>/scripts/verify.mjs
# 或者显式指定地址
node <安装目录>/scripts/verify.mjs --url http://127.0.0.1:18765
# 给程序/CI 用
node <安装目录>/scripts/verify.mjs --json
```

判定标准：

| 输出 | 含义 | 动作 |
|---|---|---|
| 退出码 0，所有行 `PASS` | 部署成功 | 交付 |
| 有 `WARN  services ... 离线` | 面板自己活着，只是某个上游没起 | 正常现象，如实告诉用户「X 服务当前没运行」 |
| 有 `FAIL panel /api/ping` | 进程没起来 | 去看日志，见第 6 节 |
| 有 `FAIL 反代端口 :18766` | 反代没监听 | 端口被占用或配置重复，看日志 |

日志在哪：

```bash
sudo journalctl -u feiyu-hub -n 60 --no-pager -o cat     # Linux
```
```powershell
# Windows：把 start-hub.cmd 拖到终端里跑，输出直接上屏
```

---

## 6. 故障 → 处理表

| 现象 | 根因 | 处理 |
|---|---|---|
| `EADDRINUSE` 端口被占用 | 面板端口或 proxyPort 撞了 | 改 `config.json` 的 `port` / `proxyPort`，重启 |
| `panel /api/ping FAIL` 但进程在 | 绑错网卡 | 检查 `bind`，容器里常要 `0.0.0.0` |
| 浏览器打开一片空白，`/api/services` 返回 200 | 浏览器缓存了旧 Service Worker | 强制刷新（Ctrl+Shift+R），或开发工具里注销 SW |
| 卡片全是「离线」 | 目标服务的端口填错 / 目标只在别的机器上 | `curl -I http://127.0.0.1:<端口>` 自己确认一遍 |
| 反代页面 502 | 上游没起 | 先让上游跑起来；Hub 只负责转发 |
| 反代页面 401/302 死循环 | 上游校验 token，但 `tokens` 没配或路径错 | 看 `curl /api/diag` 里 token 的 `len`，为 0 就是没读到 |
| Windows 双击没反应 | Node 路径含空格 / 被杀软拦 | 用 `start-hub.cmd` 前台跑，看报错 |
| systemd 服务起不来 | `ExecStart` 里的 node 路径不对 | `sudo systemctl cat feiyu-hub` 核对，重跑 install.sh |
| 手机加主屏幕后打不开 | 用了 `localhost` | 必须用这台机器的**局域网 IP**，如 `http://192.168.1.50:18765` |

---

## 7. 交付给用户的话术

装完不要只回一句「好了」。至少给到：

1. **访问地址**：按第 2 步选的方式给——A 给 `http://<局域网IP>:<端口>`，B 给 `http://100.x.x.x:<端口>`，C/D 给域名或云机地址。
2. **怎么改服务清单**：配置文件绝对路径 + 「改完访问 `/api/reload`」
3. **怎么开机自启 / 停掉**：`systemctl status|restart|stop feiyu-hub`，或 Windows 的 `-AutoStart`
4. **手机怎么用**：浏览器打开同一地址 → 添加到主屏幕
5. **安全提醒**：面板默认没有密码。A 方式且不出网可以不开；**B/C/D 一律要设 `auth.password`**，C/D 还建议套 HTTPS。

---

## 附：HTTP 接口速查

| 路径 | 说明 |
|---|---|
| `GET /api/ping` | 存活探测，返回版本号 |
| `GET /api/services` | 面板数据：站点信息 + 每个服务的在线状态与地址 |
| `GET /api/config` | **脱敏**配置摘要（不含任何密码/token），含 `warnings` |
| `GET /api/reload` | 热加载 `config.json` |
| `GET /api/refresh` | 强制刷新所有 token |
| `GET /api/diag` | 进程、端口、每个 token 的长度与年龄 |
| `GET /healthz` | 纯文本 `ok`，给容器/负载均衡探活用 |
