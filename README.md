# Feiyu Hub

把散落在机器上的 Web 后台收拢到**一个页面**：NAS 面板、智能家居、远程桌面、自建工具……
手机浏览器打开 → 添加到主屏幕 → 得到一个像 App 一样的入口，点一下直达。

零依赖（只用 Node.js 内置模块），单进程，跨平台，配置全在一个 `config.json` 里。

![肥鱼控制中心界面](docs/screenshot.png)

<sub>真实运行的截图：8 个服务全部在线，右侧是实时状态码与耗时。`🔑 打开即复制` 表示点「打开」时先把密钥写进剪贴板；反代卡片会标出 token 是否已自动带上。图中服务地址与账号已打码。</sub>

---

## 30 秒上手

需要 **Node.js 18+**（`node -v` 能打出版本就行）。

**Linux / NAS（fnOS、Debian、Ubuntu）**

```bash
tar -xzf feiyu-hub-1.0.0.tar.gz && cd feiyu-hub-1.0.0
sudo bash scripts/install.sh
```

装到 `/opt/feiyu-hub`，注册 systemd 开机自启，最后自动跑一遍自检并打印访问地址。

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

装到 `%LOCALAPPDATA%\FeiyuHub`，桌面会多一个 `Feiyu Hub` 快捷方式。

**从源码 / git clone**

```bash
git clone https://github.com/CC6249/feiyu-hub.git && cd feiyu-hub
cp config.example.json config.json
node server.mjs
# 浏览器打开 http://127.0.0.1:18765
```

**只想先看一眼效果**（不装、不改系统）

```bash
cp config.example.json config.json
node server.mjs
# 浏览器打开 http://127.0.0.1:18765
```

> 用 AI 助手部署？把这个包丢给它，让它先读 **AGENTS.md**——那里有完整的、自包含的部署剧本和排错表。它会在动手前先问你**从哪儿访问**（内网 / 组网 / DDNS / 云服务器），别嫌啰嗦，这一步决定要不要开密码。

---

## 配置：加自己的服务

编辑安装目录下的 `config.json`，保存后访问 `http://<地址>/api/reload` 热加载（不用重启）。

最简一条——**直连**（浏览器直接访问那个端口）：

```jsonc
{
  "id": "ha",
  "name": "Home Assistant",
  "desc": "智能家居面板",
  "group": "核心",
  "accent": "amber",
  "badge": "8123",
  "type": "direct",
  "port": 8123
}
```

目标是**只监听 127.0.0.1** 的后台？用 `proxy`，Hub 帮它开一个新端口转发，顺便注入 token：

```jsonc
{
  "id": "myapp",
  "name": "我的后台",
  "group": "控制",
  "type": "proxy",
  "proxyPort": 18766,
  "upstream": { "host": "127.0.0.1", "port": 8080 },
  "inject": { "kind": "query-token", "tokenId": "myapp" }
}
```

字段全集、token 两种来源、完整 JSON 模板都在 **[AGENTS.md 的「配置服务清单」](AGENTS.md#4-配置服务清单必须问用户)**。
写错了不会崩——非法项会被跳过并记进 `warnings`，用 `verify.mjs` 或 `/api/config` 能看到。

---

## 从哪儿访问：内网 / 外网四种接法

Hub 只负责「把服务摆到一个页面上」，**怎么把流量送到这台机器**是另一件事。常见四种：

| 方式 | 适合 | 需要什么 | 代价 |
|---|---|---|---|
| **① 只在内网** | 手机、电脑都在同一个 Wi-Fi | 什么都不用 | 出门就用不了 |
| **② 组网（Tailscale / ZeroTier）** | 人在外面，设备不多 | 两端各装一个客户端 | 免公网 IP、不用开端口；多一层客户端 |
| **③ DDNS + 端口映射**，或 **内网穿透（frp / cloudflared / NPS）** | 想用域名访问 | 有公网 IP（直连），或一台有公网的中转机（穿透） | 暴露在公网，**必须设密码**，最好套 HTTPS |
| **④ 云服务器固定 IP** | 想把入口放云上 | 一台云主机 | 要管证书和安全组；家里服务还得能连到云机 |

几个要点：

- **卡片地址会自动跟着走。** 卡片里的地址是按你访问时用的 `Host` 生成的：用 `192.168.2.10:18765` 打开就指向 `192.168.2.10:xxxx`，用 `100.x.x.x:18765` 打开就指向 `100.x.x.x:xxxx`。所以同一份 `config.json`，四种方式通用，不用改配置。
- **② 别开 Tailscale Funnel。** 那等于把面板挂到公网，跟「只有我自己能连」正好相反。
- **③ 先设密码，再开端口。** 面板默认没有密码，`auth.password` 填好再对外，顺序别反。运营商普遍封 80/443，用 8443 这类高位端口。**能不能直连要看你有没有真公网 IP**：`curl ifconfig.me` 拿到的地址和路由器 WAN 口不一致，就是在大内网里，只能走穿透。
- **④ 云机只是入口。** Hub 装在云上，家里那些服务仍然要能连过去（反向隧道或两边组网），否则卡片全是离线。

> 用 AI 助手部署时，它会**先问你要哪种访问方式再动手**，见 [AGENTS.md 第 2 步](AGENTS.md#2-问清访问方式安装之前必须问)。

---

## 手机当 App 用

1. 手机连同一个局域网（或连上你的 VPN，只要能访问到这台机器）
2. 浏览器打开 `http://<这台机器的IP>:18765`
3. iOS Safari：分享 → 添加到主屏幕；Android Chrome：菜单 → 添加到主屏幕

之后从桌面图标进去就是全屏，无地址栏。图标和名字可以在 `config.json` 的 `site` 段改。

> ⚠️ 用 `localhost` 加主屏幕是打不开的，必须用实际 IP。

---

## 安全

- **默认没有密码。** 面板把所有服务入口都摆在明面上：只在①内网用可以不开；要走③/④对外，**先把 `auth.password` 设好再开端口**（见上面「从哪儿访问」）。
- 需要密码就在 `config.json` 里填 `auth`，浏览器会弹原生登录框：

  ```json
  "auth": { "user": "admin", "password": "换成你的密码", "realm": "Feiyu Hub" }
  ```

  密码也可以写成 `"${HUB_PASSWORD}"`，从环境变量读，避免落盘。
- `config.json` 已在 `.gitignore` 里，别提交。
- 反代只做「本机到本机」转发，不做公网穿透。

---

## 目录结构

```
feiyu-hub-1.0.0/
├── server.mjs              主程序（零依赖，约 500 行）
├── config.example.json     配置模板，复制成 config.json 用
├── public/                 前端（PWA：index.html / sw.js / 图标）
├── docs/screenshot.png     README 里的界面截图
├── scripts/
│   ├── install.sh          Linux / NAS 一键安装（systemd）
│   ├── install.ps1         Windows 一键安装
│   ├── start.sh            前台启动（调试）
│   ├── verify.mjs          自检，输出结构化结果
│   └── uninstall.*         卸载
├── skills/feiyu-hub-deploy/  给 WorkBuddy 用的技能包（可选）
├── AGENTS.md               给 AI 的部署手册 ★
├── CLAUDE.md               Claude Code 入口（指向 AGENTS.md）
└── LICENSE                  MIT
```

---

## 常用命令

```bash
# 服务状态 / 重启 / 停
sudo systemctl status feiyu-hub
sudo systemctl restart feiyu-hub
sudo systemctl stop feiyu-hub

# 看日志
sudo journalctl -u feiyu-hub -n 60 --no-pager -o cat

# 自检
node /opt/feiyu-hub/scripts/verify.mjs

# 卸载（保留配置） / 彻底删
sudo bash /opt/feiyu-hub/scripts/uninstall.sh
sudo bash /opt/feiyu-hub/scripts/uninstall.sh --purge
```

---

## 排错

| 现象 | 多半是 |
|---|---|
| 启动就报 `EADDRINUSE` | 端口被占了，改 `config.json` 的 `port` 或某个 `proxyPort` |
| 卡片全离线 | 那些服务本身没跑，或端口填错。`curl -I http://127.0.0.1:<端口>` 自查 |
| 反代 502 | 上游没起。Hub 只负责转发，不负责把上游拉起来 |
| 反代 401 / 反复跳登录 | `tokens` 没配或路径不对。看 `curl http://127.0.0.1:18765/api/diag` 里 token 的 `len` |
| 页面改了没变化 | Service Worker 缓存。Ctrl+Shift+R，或开发者工具里注销 SW |
| 手机图标打不开 | 用了 localhost，要用局域网 IP |

更完整的排查表在 [AGENTS.md 第 6 节](AGENTS.md#6-故障--处理表)。

---

## 许可

MIT。随便改、随便分发。
