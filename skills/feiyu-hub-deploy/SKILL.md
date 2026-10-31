---
name: feiyu-hub-deploy
description: 在用户自己的机器上部署 Feiyu Hub（肥鱼控制中心）——一个零依赖 Node.js 的服务聚合看板，把 NAS 面板、智能家居、远程桌面、自建后台收拢到一个页面，支持手机 PWA 与 127.0.0.1 服务的 token 注入反代。当用户提到「部署肥鱼控制中心 / Feiyu Hub」「把家里的服务做成一个入口页」「装个服务看板 / 导航页」「把几个后台合成一个页面」时使用；也用于部署后的配置修改、服务增删和故障排查。
agent_created: true
---

# Feiyu Hub 部署

## 概述

Feiyu Hub 是一个零依赖的 Node.js 单进程 Web 面板：读一份 `config.json`，把配置里的每一行渲染成一张卡片，显示在线状态与延迟，点一下新窗口打开目标服务。需要凭据的服务（如 noVNC）可在点开时自动把密码写进剪贴板；只监听 `127.0.0.1` 的服务可通过内置反代暴露，并由服务端注入 token。

发行包结构固定：`server.mjs` + `public/` + `scripts/`（install / verify / uninstall）+ `config.example.json` + `AGENTS.md`。**不要修改 `server.mjs`**，所有可变项都在 `config.json`。

## 何时使用本技能

- 用户要把自建服务做成一个统一入口页 / 导航页
- 用户要在 NAS（fnOS、群晖、Debian/Ubuntu 主机）或 Windows 电脑上装这个面板
- 已经装好，要加服务、改端口、换品牌、排错

## 第一步：定位发行包

部署源是用户手上这个发行包目录（解压后含 `server.mjs` 与 `AGENTS.md`）。按以下顺序确认：

1. 用户直接给了目录路径 → 用 `ls <目录>/server.mjs` 确认存在。
2. 用户给的是压缩包（`feiyu-hub-1.0.0.zip` / `.tar.gz`）→ 先解压到工作目录再继续。
3. 两者都没有 → 向用户要路径，**不要凭猜测去搜整个磁盘**。

确认后，把该目录记为 `<包目录>`，后续命令都用绝对路径。

## 第二步：环境探测

```bash
node -v            # 需要 >= v18
uname -s           # Linux / Darwin
```

Windows 用 PowerShell 跑 `node -v`。

判定与处理：

| 结果 | 动作 |
|---|---|
| v18 及以上 | 直接进第三步 |
| 命令不存在 | 停下，让用户装 Node（见下），装完再继续。**不要用 Python/Go 重写** |
| 版本低于 18 | 同上，装 LTS |

```bash
# Debian / Ubuntu / fnOS
sudo apt update && sudo apt install -y nodejs
# 太老时
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```
```powershell
winget install OpenJS.NodeJS.LTS
```

> fnOS 特有：系统 node 常在 `/usr/local/nodejs/bin/node` 且不在普通用户 PATH 里，`node -v` 会失败。安装脚本自己会去这个路径找，可以直接继续。

## 第三步：问清装在哪、从哪看、要不要出门（**安装之前必须问**）

三个独立的问题，都要问，一个都不能默认——**尤其不要默认用户有内网**。

### 3.1 装在哪台机器上？

> 「这个面板装在家里的 NAS / 小主机 / 旧电脑上，还是云服务器上？」

| 回答 | 直连入口 | 关键差异 |
|---|---|---|
| **家里的内网机器** | `http://<局域网IP>:<端口>` | 同一 Wi-Fi 直接开；出门要另加通道，见 3.3 |
| **云服务器** | `http://<公网IP>:<端口>` 或域名 | **没有「局域网」这一说**；**必须设密码**；安全组只放面板端口 |

云机若「只有内网 IP、没绑 EIP」→ 先绑 EIP，或用一台有公网 IP 的机器反代过去，否则装完谁也连不上。

### 3.2 从哪些设备看？

> 「平时用电脑打开、手机打开，还是两个都用？」

| 回答 | 安装时 | 交付时 |
|---|---|---|
| **只电脑** | `bind` 保持 `0.0.0.0`；纯本机自用可 `127.0.0.1` | 给地址即可 |
| **只手机** | **必须** `bind: "0.0.0.0"` | 给局域网 / 公网地址（**绝不能 `localhost`**）；教「添加到主屏幕」；**确认宿主常开**——装在会关机的电脑上，手机就打不开 |
| **都要** | 按「只手机」准备 | 布局是移动优先响应式，电脑端自然可用；两边都讲 |

两条必须主动告知：`http://` 下「添加到主屏幕」只是快捷方式级别（Service Worker 不生效、无离线能力，完整 PWA 要 HTTPS）；只给手机用就别把宿主装在会关机的机器上。

### 3.3 出门也要吗？（只有装在家里才需要问）

装云上不用问——云机本来在外就能访问。装家里才问，四条通道**可以多选**：

| 通道 | 典型说法 | 安装时 | 装完还要做 |
|---|---|---|---|
| **A 组网（Tailscale / ZeroTier）** | “外面也想连”“没公网 IP” | `bind: "0.0.0.0"`，必设密码 | 机器和手机装客户端、登录同一账号，`tailscale ip -4` 拿 `100.x.x.x`。**不要开 Tailscale Funnel**（等于挂公网） |
| **B DDNS + 端口映射** | “我有域名” | **先**设 `auth.password`，再对外 | 确认真有公网 IP（`curl ifconfig.me` 与路由器 WAN 口对比，不一致 = 没有，转 C）；映射面板端口；80/443 多被封，用 8443 |
| **C 内网穿透（frp / cloudflared / NPS）** | “没公网 IP，但想要域名” | 同上，**先设密码** | 一台有公网的中转机；建隧道；**只暴露面板端口**，别把内网整段打通 |
| **D 云服务器固定 IP** | “放云上” | 云主机装 Hub，安全组只放面板端口 | 家里服务靠反向隧道或组网接上云，否则卡片全离线 |

### 3.4 汇总：三个答案 → 一组配置

| 装在哪 | 从哪看 | 出门 | `bind` | `auth.password` | 交付 |
|---|---|---|---|---|---|
| 家里 | 只电脑 | 不要 | `0.0.0.0` / `127.0.0.1` | 可留空 | 局域网地址 |
| 家里 | 手机也要 | 不要 | `0.0.0.0` | 建议设 | 局域网地址 + 加主屏幕说明 |
| 家里 | 任意 | 要（A/B/C/D 任选） | `0.0.0.0` | **必设** | 局域网 + 每通道各一个地址 |
| 云上 | 任意 | —— | `0.0.0.0` | **必设，无例外** | 公网地址 / 域名（安全组已放行） |

- **勾几条做几条，互不冲突**：所有通道共用同一个 `bind` 和 `port`，同一份 `config.json` 服务全部通道，不要为每条通道单独装一遍。
- **没勾的通道不要顺手配上**，尤其 B/C/D。
- **密码无差别**：设了之后从局域网打开也要输密码，本版本不支持「内网免密、外网要密」。
- **云上部署额外提醒**：云机上的 Hub 只能看到云机可达的服务，家里的服务要靠隧道接过去，否则卡片全离线。
- 通道选择只影响 `bind` 和 `auth`，**不影响 `services`**：卡片地址按访问时的 `Host` 动态生成，同一份配置多通道通用。

## 第四步：安装

两个安装脚本都是幂等的，重复跑不会破坏已有 `config.json`（除非显式 `--force`）。

### Linux / NAS

```bash
chmod +x <包目录>/scripts/*.sh
sudo bash <包目录>/scripts/install.sh
```

它会：找 node → 复制到 `/opt/feiyu-hub` → 生成 `config.json` → 注册 `feiyu-hub.service`（开机自启）→ 启动 → 自检并打印访问地址。

变体：`--prefix <目录>`、`--port <端口>`、`--no-service`（不装 systemd，容器环境用）、`--no-start`、`--force`。

无 sudo 时自动退到 `~/.local/share/feiyu-hub` 并跳过 systemd——这是设计行为，不是错误。

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File <包目录>\scripts\install.ps1
```

变体：`-Port 18800`、`-Prefix "D:\apps\feiyu-hub"`、`-AutoStart`、`-NoStart`、`-Force`。

### macOS

```bash
bash <包目录>/scripts/install.sh --prefix ~/feiyu-hub --no-service
```
常驻需自行写 launchd plist；临时用 `bash ~/feiyu-hub/scripts/start.sh`。

## 第五步：配置服务清单（必须问用户）

安装生成的 `config.json` 只是示例模板，端口大概率对不上目标机器。**不要扫端口猜**，一次问清：

1. 要放哪些服务？各自的**名称**和**端口**。
2. 有没有只监听 `127.0.0.1` 的后台（这类必须用 `proxy` 类型）。
3. 有没有需要「打开时自动复制密码」的（典型是 noVNC / 远程桌面）。

两种卡片：

```jsonc
// direct —— 浏览器直连，最常用
{ "id":"ha", "name":"Home Assistant", "desc":"智能家居", "group":"核心",
  "accent":"amber", "badge":"8123", "type":"direct", "port":8123, "path":"/" }

// proxy —— 目标只监听 127.0.0.1，用 Hub 的端口转发并注入 token
{ "id":"myapp", "name":"我的后台", "group":"控制", "type":"proxy",
  "proxyPort":18766,
  "upstream": { "host":"127.0.0.1", "port":8080, "probePath":"/" },
  "inject": { "kind":"query-token", "tokenId":"myapp" } }
```

token 来源写在顶层 `tokens`：

```jsonc
"tokens": {
  "myapp": { "type":"file", "path":"/opt/myapp/state/token" },
  "dsh": { "type":"command", "cmd":"sudo",
           "args":["-n","journalctl","-u","dsh","--no-pager","-o","cat"],
           "regex":"token=([A-Za-z0-9_-]{20,})", "pick":"last", "ttlSec":300 }
}
```

完整字段表见 `references/config-schema.md`。

改完热加载，不必重启：

```bash
curl -s http://127.0.0.1:<端口>/api/reload
```

返回 `restartRequired: true` 说明改动了 `port` / `proxyPort` / `upstream`，此时需重启：`sudo systemctl restart feiyu-hub`（Windows 关掉 `start-hub.cmd` 窗口重开）。

**写错的字段不会让程序崩溃**——非法项被跳过并记入 `warnings`，`/api/config` 和 `verify.mjs` 都能看到。

## 第六步：验证（必做）

```bash
node <安装目录>/scripts/verify.mjs
node <安装目录>/scripts/verify.mjs --json     # 结构化，便于程序判断
```

| 输出 | 含义 | 动作 |
|---|---|---|
| 退出码 0，全 PASS | 部署成功 | 交付 |
| `WARN services … 离线` | 面板正常，某个上游没跑 | 如实告知用户，不算失败 |
| `FAIL panel /api/ping` | 进程没起来 | 看日志：`sudo journalctl -u feiyu-hub -n 60 --no-pager -o cat` |
| `FAIL 反代端口 :18766` | 反代未监听 | 端口被占用或配置重复 |

## 第七步：交付

至少给用户这些信息：

1. **访问地址**：按 3.1 的答案给——家里部署给局域网地址，云上部署给公网 IP 或域名（没有局域网地址可给）。3.3 勾了 A 再给 `100.x`，勾了 B/C/D 再给域名或云机地址。**勾几条就给几个**，说明它们同时有效
2. **配置文件绝对路径** + 「改完访问 `/api/reload`」
3. **启停命令**：`systemctl status|restart|stop feiyu-hub`，Windows 用 `-AutoStart`
4. **手机用法**（3.2 里要手机端才重点讲）：浏览器打开同一地址 → 添加到主屏幕（**必须用 IP，不能 localhost**）；顺带说明 `http://` 下是快捷方式级别、要完整 PWA 得 HTTPS
5. **安全提醒**：家里部署时，**一条外网通道都没开**才可以不设密码；**云上部署无例外必须设**；勾了 A/B/C/D 任意一条的也必须设，B/C/D 还建议套 HTTPS。同时说明：设了之后局域网访问同样要输密码
6. **云上部署追加**：云机上的 Hub 只能看到云机可达的服务，家里的服务要靠隧道接过去，否则卡片全离线

## 红线

- 不改 `server.mjs`；不把用户的服务清单硬编码进代码。
- 未经用户在第 3 步明确回答，**不要预设用户有内网、也不要预设只用电脑**：云上部署没有局域网地址可给，只手机访问时宿主必须常开且不能给 localhost。
- 未经用户在 3.3 明确**勾选**，不动路由器端口映射 / DDNS / frp / 组网客户端；勾了 B/C/D 任意一条时必须先设 `auth.password` 再开端口。没勾的通道不要顺手配上。
- 不提交 `config.json`（可能含密码）。
- 每个结论都要有 `verify.mjs` 或接口返回作为证据，不要只说「应该好了」。

## 参考

- `references/config-schema.md` —— `config.json` 全部字段、默认值、示例
- `references/troubleshooting.md` —— 报错 → 根因 → 处理对照表
- 发行包根目录的 `AGENTS.md` —— 同等内容的完整版（可直接让 AI 读）
