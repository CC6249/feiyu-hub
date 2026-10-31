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
3. **部署位置和访问设备必须先问，不能默认有内网，也不能默认是电脑。** 有人把 Hub 装在云服务器上——根本没有局域网这一说；有人只用手机看——宿主必须常开、地址不能给 `localhost`。第 2 步的三个问题都要问到。外网通道可以多选，不要逼用户四选一，也不要只勾一条就自作主张补齐。用户没选之前：不动路由器端口映射、不开 frp/DDNS、不装组网客户端、不 `ufw allow from any`。
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

## 2. 问清装在哪、从哪看、要不要出门（**安装之前必须问**）

装完之后「从哪儿打开」，由三个**互相独立**的问题决定。三个都要问，一个都不能默认——**尤其不要默认用户有内网**。装之前问，不要装完再补。

### 2.1 先问：Hub 装在哪台机器上？

> 「这个面板你打算装在哪——家里的 NAS / 小主机 / 旧电脑，还是云服务器上？」

| 回答 | 直连入口 | 关键差异 |
|---|---|---|
| **家里 / 办公室的内网机器**（NAS、小主机、旧电脑、树莓派、软路由） | `http://<局域网IP>:<端口>` | 同一个 Wi-Fi 直接开；出门要另加通道，见 2.3 |
| **云服务器** | `http://<公网IP>:<端口>` 或域名 | **没有「局域网」这一说**——云机本身就在公网上，任何设备直接可达；**必须设密码**；安全组只放面板端口 |

云服务器还要追问一句，否则装完可能谁也连不上：

- **有公网 IP**（轻量应用服务器一般都有）→ 直接用，配好安全组。
- **只有内网 IP**（VPC 里的 ECS、没绑 EIP）→ 先绑 EIP，或用一台已有公网 IP 的机器反代过去。**这个没解决就别装**，装完也是孤岛。

### 2.2 再问：从哪些设备看——只电脑、只手机，还是都要？

> 「你平时用什么打开它——电脑、手机，还是两个都用？」

| 回答 | 安装时 | 交付时 |
|---|---|---|
| **只电脑** | `bind` 保持 `0.0.0.0`；纯本机自用也可以 `127.0.0.1` | 给地址即可 |
| **只手机** | **必须** `bind: "0.0.0.0"` | 给局域网 / 公网地址（**绝不能给 `localhost`**）；教「添加到主屏幕」；**确认宿主常开** |
| **都要** | 按「只手机」准备 | 布局是移动优先响应式，电脑端自然可用；两边都要讲 |

手机相关的两条必须主动告知：

- **`http://` 下「添加到主屏幕」只是快捷方式级别**：有图标、能全屏，但 Service Worker 不工作（非安全上下文），没有离线能力。想要完整 PWA 得套 HTTPS。
- **只给手机用，宿主必须是常开的**。装在会关机的 Windows 电脑上，电脑一关手机就打不开——建议改装到 NAS / 软路由 / 云机，或至少启用 `-AutoStart` 并把这个限制讲清楚。

### 2.3 最后问：出门也要吗？（只有装在家里才需要问）

装云上就不用问了——云机本来在外面就能访问。装家里才问：

> 「除了在家用，你还要不要从外面也能连？下面几条可以同时开，也可以一条都不开：
> - **A 组网**（Tailscale / ZeroTier）：免公网 IP，只有你自己的设备能连
> - **B DDNS + 端口映射**：用域名访问，需要你有真公网 IP
> - **C 内网穿透**（frp / cloudflared / NPS）：用域名，不需要公网 IP，但要一台中转机
> - **D 云服务器固定 IP**：把入口放到云主机上
>
> 开哪几条？（可多选）」

| 通道 | 用户原话通常是 | 安装时怎么做 | 装完还要做什么 |
|---|---|---|---|
| **A 组网（Tailscale / ZeroTier）** | “人在外面也想连家里”“没有公网 IP” | `bind: "0.0.0.0"`；`auth` 必设 | 机器和手机装客户端、登录同一账号；`tailscale ip -4` 拿 `100.x.x.x`。**不要开 Tailscale Funnel** |
| **B DDNS + 端口映射** | “我有域名” | **先**设 `auth.password`，再对外 | 先确认真有公网 IP（`curl ifconfig.me` 与路由器 WAN 口对比，不一致 = 没有，转 C）；把面板端口映射到本机；80/443 多被封，用 8443 |
| **C 内网穿透（frp / cloudflared / NPS）** | “没公网 IP，但想要域名” | 同上，**先设密码** | 一台有公网的中转机；建隧道；**只暴露面板端口**，别把内网整段打通 |
| **D 云服务器固定 IP** | “想放云上” | 云主机装 Hub；安全组只放面板端口 | 家里服务靠反向隧道或组网接上云，否则卡片全离线 |

- **勾几条做几条，互不冲突**：所有通道共用同一个 `bind` 和 `port`，同一份 `config.json` 同时服务全部通道，不要为每条通道单独装一遍。
- **没勾的通道不要顺手配上**，尤其 B/C/D——那是把面板暴露到公网的不可逆动作。
- 用户勾了 B 但没有公网 IP（双层 NAT、运营商大内网）→ 告诉他 B 走不通，改勾 C。

### 2.4 汇总：三个答案 → 一组配置

| 装在哪 | 从哪看 | 出门 | `bind` | `auth.password` | 交付的地址 |
|---|---|---|---|---|---|
| 家里 | 只电脑 | 不要 | `0.0.0.0` 或 `127.0.0.1` | 可留空 | 局域网地址 |
| 家里 | 手机也要 | 不要 | `0.0.0.0` | 建议设 | 局域网地址 + 加主屏幕说明 |
| 家里 | 任意 | 要（A/B/C/D 任选） | `0.0.0.0` | **必设** | 局域网地址 + 每条通道各一个地址 |
| 云上 | 任意 | —— | `0.0.0.0` | **必设，无例外** | 公网地址或域名（安全组已放行） |

三条通用结论：

- **密码是无差别的**：设了 `auth` 之后，从局域网打开也要输密码。本版本不支持「内网免密、外网要密」，用户坚持要这种效果时如实说明。
- **通道选择只影响 `bind` 和 `auth`，不影响 `services`**：卡片地址按访问时的 `Host` 动态生成。同一份 `config.json`，用局域网 IP 打开卡片就指向局域网 IP，用 `100.x` 打开就指向 `100.x`，用域名打开就指向域名。
- **云上部署要额外提醒**：云机上的 Hub 只能看到云机本机（和它网络能到达的地方）的服务。用户家里那些服务必须靠隧道或组网接过去，否则卡片全是离线。

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

### 4.5 更省事的做法：先扫描，让用户挑

用户说「我也不知道机器上有什么」时，别让他去 `netstat` 里翻。面板底部自带扫描：

```bash
curl -s http://127.0.0.1:18765/api/scan
# {"ok":true,"ports":52,"found":6,"items":[{"port":8080,"title":"后台管理","code":200,"state":"new"}, ...]}

# 用户点头要哪几个，再逐个写入（会改 config.json 并热加载，不用重启）
curl -s -X POST http://127.0.0.1:18765/api/services/add \
  -H 'Content-Type: application/json' -d '{"port":8080,"name":"后台管理"}'
```

要点：

- `state` 三态：`new` 可以加，`builtin` 已经是配置里的服务，`pinned` 是之前加过的自定义项。
- 加入的条目在 `config.json` 里带 `"custom": true`，界面上有「移除」，`/api/services/remove` 能删；
  **手写条目没有这个标记，扫描/删除都碰不到**，不会误删用户手工配的东西。
- 扫描只探本机 `127.0.0.1`，不扫局域网、不扫外网、不发包出去。
- 状态码 ≥400 且拿不到 `<title>` 的端口会被丢掉（那种 404 空壳接口加进面板也没用）。

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

1. **访问地址**：按 2.1 的答案给——**家里部署**给局域网地址（基线，一定可用），**云上部署**给公网 IP 或域名（没有局域网地址可给）。用户在 2.3 勾了 A 就再给 `http://100.x.x.x:<端口>`，勾了 B/C/D 就再给域名或云机地址。**勾了几条就给几个地址**，并说明它们同时可用、指向同一个面板。
2. **怎么改服务清单**：配置文件绝对路径 + 「改完访问 `/api/reload`」
3. **怎么开机自启 / 停掉**：`systemctl status|restart|stop feiyu-hub`，或 Windows 的 `-AutoStart`
4. **手机怎么用**（2.2 里用户要手机端才重点讲）：浏览器打开同一地址（**不能用 localhost**）→ 添加到主屏幕。顺带说明 `http://` 下这是快捷方式级别、没有离线能力，要完整 PWA 得套 HTTPS。
5. **安全提醒**：家里部署时，只有**一条外网通道都没开**才可以不设密码；**云上部署无例外必须设**（公网上的面板一定会被扫）。勾了 A/B/C/D 任意一条的也要设，B/C/D 还建议套 HTTPS。同时提醒：设了之后从局域网打开也要输密码（Basic Auth 不区分来源）。
6. **云上部署追加一句**：云机上的 Hub 只能看到云机能访问到的服务；家里的服务要靠隧道接过去，否则卡片是离线的。

---

## 附：HTTP 接口速查

| 路径 | 说明 |
|---|---|
| `GET /api/ping` | 存活探测，返回版本号 |
| `GET /api/services` | 面板数据：站点信息 + 每个服务的在线状态与地址 |
| `GET /api/config` | **脱敏**配置摘要（不含任何密码/token），含 `warnings` |
| `GET /api/reload` | 热加载 `config.json` |
| `GET /api/refresh` | 强制刷新所有 token |
| `GET /api/scan` | 扫本机监听端口并探 HTTP 标题；每项带 `state`: `new` / `builtin` / `pinned` |
| `POST /api/services/add` | 体 `{port,name}`。写进 `config.json` 的 `services`（`"custom": true`）并热加载 |
| `POST /api/services/remove` | 体 `{port}`。只删 `custom: true` 的条目，手写配置不受影响 |
| `GET /api/diag` | 进程、端口、每个 token 的长度与年龄 |
| `GET /healthz` | 纯文本 `ok`，给容器/负载均衡探活用 |
