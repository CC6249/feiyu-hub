# 故障排查对照表

先跑自检拿到证据，再对表：

```bash
node <安装目录>/scripts/verify.mjs
curl -s http://127.0.0.1:18765/api/diag
```

---

## 安装阶段

| 报错 / 现象 | 根因 | 处理 |
|---|---|---|
| `在 ... 找不到 server.mjs` | 没在解压后的包目录里跑 | `cd` 到含 `server.mjs` 的目录再执行 `bash scripts/install.sh` |
| `没有找到 Node.js 18+` | 未安装 / 版本过低 / 不在 PATH | 装 LTS；fnOS 的 node 在 `/usr/local/nodejs/bin/node`，脚本已内置搜索，若仍失败直接 `--prefix` 手动装 |
| `Permission denied` | 没有执行位或没 sudo | `chmod +x scripts/*.sh`；用 `sudo bash`（不是 `sudo ./`） |
| 装到一半 `cp: cannot create` | 目标目录属主是 root | 别混用 `sudo` 与普通用户；先 `sudo rm -rf` 目标目录再来，或换 `--prefix ~/...` |
| Windows 执行 ps1 被拦 | 执行策略 | `powershell -ExecutionPolicy Bypass -File scripts\install.ps1` |
| Windows 脚本里中文乱码 | PowerShell 5.1 按 ANSI 读无 BOM 文件 | 发行包内的 ps1 全部是 ASCII，正常不会遇到；自己改过脚本请存成 UTF-8 **带 BOM** 或纯 ASCII |
| `node: command not found` 但系统明明装了 | PATH 未生效（常见于 fnOS 用应用中心装的 node） | `export PATH=/usr/local/nodejs/bin:$PATH`，或安装时用绝对路径 `ExecStart` |

## 启动阶段

| 报错 / 现象 | 根因 | 处理 |
|---|---|---|
| `EADDRINUSE` | `port` 或某个 `proxyPort` 被占用 | `ss -ltnp \| grep <端口>` 找出占用者；改 `config.json` 后重启 |
| 进程起来就退出，日志 `启动失败` | 配置 JSON 语法错 | `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"` 定位；修好或删掉 `config.json` 让它用默认配置 |
| 面板空白，`/api/services` 返回 `services: []` | 配置没读到，或 `services` 为空 | 看 `/api/config` 的 `loaded` 与 `path`；`loaded:false` = 用的是内置默认配置，检查路径和 JSON |
| `/api/config` 里 `warnings` 一堆 | 字段写错 | 按 warning 文案逐条改，通常是 `proxyPort` 重复或 `upstream.port` 缺失 |
| 容器里浏览器连不上 | `bind` 绑到了 `127.0.0.1` | 改 `0.0.0.0`，并确认容器端口已映射 |
| systemd 反复重启 | `ExecStart` 里 node 路径变了 | `sudo systemctl cat feiyu-hub` 核对；重跑 `install.sh` 覆盖 |
| `status=203/EXEC` | ExecStart 路径不可执行 | 同上，用 `command -v node` 的真实路径 |

## 面板显示

| 现象 | 根因 | 处理 |
|---|---|---|
| 卡片全「离线」 | 那些服务本身没跑 / 端口填错 | `curl -I http://127.0.0.1:<端口>` 逐个自查。上游不在 Hub 的责任范围 |
| 某个卡片显示「超时」 | 上游响应慢于 `probeTimeoutMs` | 调大该项，或把 `probePath` 指向更轻的路径（如 `/favicon.ico`） |
| 改了配置页面没变 | 没触发重载 | `curl http://127.0.0.1:<端口>/api/reload`；若返回 `restartRequired:true` 需重启进程 |
| 改了前端 / 图标没变 | Service Worker 缓存 | `Ctrl+Shift+R`；或在开发者工具 → Application → Service Workers 里 Unregister |
| 手机添加到主屏后打不开 | 用了 `localhost` | 必须用这台机器的局域网 IP，如 `http://192.168.1.50:18765` |
| 主屏图标名字不对 | 改的是 `config.json` 但没重装 PWA | `site.name` / `site.shortName` 改完，删掉主屏图标重新添加（manifest 变了需要重读） |
| 局域网 IP 能开，域名打不开 | 用域名访问时卡片地址也变成域名 | 这是设计：卡片地址跟随请求 `Host`。若域名未覆盖所有端口，给对应卡片写死 `url` 模板 |

## 访问方式（装在哪 / 从哪看 / 出门）

> 先分清三件事：**装在哪**决定有没有局域网；**从哪看**决定 `bind` 和交付什么地址；**出门**才涉及组网 / DDNS / 穿透 / 云机。最后一类可以同时开多条，共用同一个 `bind` 和 `port`，不需要装两遍。

### 云服务器部署

| 现象 | 根因 | 处理 |
|---|---|---|
| 云机上 `curl 127.0.0.1:<端口>` 通，外面打不开 | 云厂商**安全组**没放行（和系统防火墙是两回事） | 控制台加规则，只放面板这一个端口，来源能收窄就收窄；系统防火墙（ufw / firewalld）也要单独放行 |
| 云机只有内网 IP，外面进不来 | VPC 里的 ECS 没绑 EIP | 绑 EIP，或用一台有公网 IP 的机器反代过去。**没解决就别装**，装完是孤岛 |
| 云上 Hub 能开，但卡片全离线 | 被管理的服务在用户家里，云机到不了 | 靠隧道（frp / cloudflared）或两边组网把家里服务接上云。这是拓扑问题，不是 Hub 的问题 |
| 面板被大量扫描、登录框不断弹 | 公网 IP 上的服务必然被扫 | 云上部署**无例外必须设 `auth.password`**；能上 HTTPS 就上；强烈建议再用安全组限制来源 IP |

### 手机 / 电脑访问

| 现象 | 根因 | 处理 |
|---|---|---|
| 手机打不开，电脑能开 | 电脑上用的是 `localhost` / `127.0.0.1`——手机上的 localhost 指手机自己 | 给手机局域网 / 公网 IP，并且 `bind` 必须是 `0.0.0.0` |
| 加到主屏幕后没有离线能力、图标像普通书签 | `http://` 不是安全上下文，Service Worker 不会注册 | 正常现象（代码里注册失败是静默的，不影响使用）。要完整 PWA 得套 HTTPS |
| 加到主屏幕后手机横屏被锁成竖屏 | 动态 manifest 里 `orientation: "portrait"` | 正常，桌面浏览器不受影响。这是写死在 `server.mjs` 里的，想改就得改代码（不建议，会失去可升级性） |
| 只手机用，但电脑一关机就打不开 | 宿主是会关机的机器 | 改装到 NAS / 软路由 / 云机，或至少开 `-AutoStart`，并把限制告诉用户 |

### 家里部署 + 外网通道

| 现象 | 根因 | 处理 |
|---|---|---|
| 局域网能开，`100.x` 地址打不开 | `bind` 是 `127.0.0.1`，只监听了回环 | 改 `"bind": "0.0.0.0"` 后重启；`ss -ltn \| grep <端口>` 确认监听的是 `0.0.0.0` |
| 局域网打开也弹登录框 | 设了 `auth` 是**无差别鉴权**，不区分请求来源 | 正常行为，不是 bug。想内网免密只能不设密码，或只保留内网 / 组网 |
| 想同时开两条通道，以为要装两遍 | 误解 | 不用。所有通道共用同一进程同一配置，多一条通道只是多一条能进来的网络路径 |
| 组网地址 ping 得通、网页一直转圈 | 本机防火墙拦了面板端口 | `sudo ufw allow <端口>/tcp`（firewalld 用 `firewall-cmd --add-port`），只放面板这一个端口 |
| 域名打不开 / 502 | 端口映射没生效，或运营商封了 80/443 | 换 8443 之类高位端口；确认光猫和路由器没有两层 NAT 叠加；从外网侧测 `curl -I http://<域名>:<端口>` |
| 以为有公网 IP，其实没有 | 双层 NAT / 运营商大内网 | `curl ifconfig.me` 的结果和路由器 WAN 口不一致 → DDNS 直连不通，改用 frp / cloudflared 这类穿透 |
| 外网能打开面板，但卡片全「离线」 | 卡片是 `direct`，地址指向内网，外网侧本来就到不了 | 这是预期。要么只在能进那个网段的设备上看，要么把那些服务也通过隧道暴露 |
| 面板出现大量陌生请求 / 被扫 | 直接映射到公网且没设密码 | 立刻设 `auth.password`，撤掉映射改走组网；必要时换端口 |
| Tailscale 里看不到这台机器 | 客户端未登录 / 容器里状态没持久化 | `tailscale status`、`tailscale ip -4`；容器部署要挂载 state 目录并用内核 TUN，别用 userspace 模式 |

## 反代（proxy 卡片）

| 现象 | 根因 | 处理 |
|---|---|---|
| 打开是 502 | 上游没起 / 地址错 | 先 `curl -I http://127.0.0.1:<upstream.port>` 确认上游活着 |
| 打开是 401 / 反复跳登录 | token 没注入成功 | `curl -s /api/diag` 看该 token 的 `len`，为 0 说明没读到；文件型查路径与读权限，命令型手动跑一遍那条命令看输出 |
| 打开无限 302 循环 | 上游靠 cookie 校验，但 cookie 没落到当前 host | 本发行版已在服务端注入 token（不靠 302），出现此现象多为 `inject` 没配或 `tokenId` 拼错 |
| 页面能开但样式/JS 全丢 | 上游前端写死了绝对路径，且被塞进子路径 | 本发行版用独立端口规避；若你把 `url` 改成子路径就会复现——改回独立端口 |
| 页面白屏，控制台大量 `frame-ancestors` / `X-Frame-Options` | 上游禁止被 iframe 嵌套 | 卡片是**新窗口打开**，不是 iframe；若你改了前端嵌套请改回去 |
| WebSocket 连不上（实时功能失效） | 上游的 WS 走了别的端口 | 确认 `upstream.port` 就是 WS 端口；多数场景同端口，个别产品分开 |
| 登录后 cookie 丢失 | 上游 `Set-Cookie` 带 `Domain` | 已在响应里抹掉 `Domain`，保持 host-only；若上游用 `SameSite=None; Secure` 且你是 http 访问，会失败——给面板套 HTTPS 反代 |

## 凭据自动复制（noVNC 等）

| 现象 | 根因 | 处理 |
|---|---|---|
| 点开卡片没复制 | 浏览器不支持/被拦 | 面板走 http（非安全上下文）时没有 `navigator.clipboard`，发行版已用 `execCommand` 兜底；若仍失败，检查是否给了 `autocopy:true` 且 `secret` 非空 |
| 复制了但粘贴不对 | VNC 协议只认前 8 位 | 粘贴完整串也能过（服务端按前 8 位校验），不必手截 |
| 提示复制成功但剪贴板空 | 某些浏览器在 `target=_blank` 后清空 | 手动从卡片复制：把 `secret` 值放在 `desc` 里临时看一眼 |

## 卸载

```bash
sudo bash <安装目录>/scripts/uninstall.sh            # 保留 config.json
sudo bash <安装目录>/scripts/uninstall.sh --purge    # 连目录一起删
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Purge
```
