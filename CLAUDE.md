# CLAUDE.md

这个项目的部署与配置说明全部写在 **AGENTS.md**，先读它。

@AGENTS.md

补充几条 Claude Code 特有的执行建议：

- 用 `Bash` 工具跑 `scripts/install.sh`（Linux/macOS）或 `powershell -ExecutionPolicy Bypass -File scripts/install.ps1`（Windows）。
- 用户没给出服务清单时，用一次提问把「名称 + 端口 + 是否只监听 127.0.0.1」问清，不要自己扫端口猜。
- 每步执行完把 `verify.mjs` 的**退出码和 FAIL/WARN 行**贴出来，不要只写结论。
- 不要提交 `config.json` 到 git（已在 `.gitignore`），它可能含密码。
