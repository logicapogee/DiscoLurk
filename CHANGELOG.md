# 更新日志

## 0.2.0

- 卡粉论坛域名更新为 `https://time.fly`（进度页 `https://time.fly/my/trust-level`）
- 适配卡粉论坛未登录落地页（`/pub` 公开资讯页），修复登录态检查空等超时的问题
- 修复卡粉论坛 TL2→TL3 信任等级进度页解析：修复带百分比/括号单元格（如连续有效活跃天数）的数字拼接错误，补全 TL2→TL3 指标映射，并将「最多 N 个」上限项正确标记为限制项

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
