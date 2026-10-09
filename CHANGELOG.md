# 更新日志

## 0.1.0

首个版本。

- 支持 Discourse 论坛，内置 LINUX DO 等站点
- 用本机的 Chrome / Edge 浏览话题，有深度和快速两种模式，可以按话题数或时长运行
- 运行结束后读取站点进度页核对结果
- 点赞、回复默认关闭
- 桌面应用（Windows / macOS / Linux）：托盘、通知、开机自启，Windows / Linux 支持应用内更新
- 定时任务：每天随机若干次，或用 cron
- Docker 镜像 `ghcr.io/logicapogee/discolurk`，带 Web 界面
- 命令行 `lurk`

### 已知问题

- 安装包没有代码签名，首次打开需要手动放行
- macOS 不支持自动更新
- linux.do 的统计有约 3 分钟延迟
- Docker 镜像只有 linux/amd64
