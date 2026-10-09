# DiscoLurk

Discourse 论坛自动浏览工具。用本机的 Chrome（或 Edge）和单独的浏览器 Profile 打开板块、点开话题、逐楼阅读，结束后读站点的进度页核对结果。

- 支持站点：LINUX DO、卡粉论坛
- 桌面应用（Windows / macOS / Linux）、命令行 `lurk`、Docker 镜像
- 点赞、回复默认关闭
- 不保存密码，不自带浏览器，不绕过验证码

## 安装

从 [Releases](https://github.com/logicapogee/DiscoLurk/releases) 下载。需要本机装有 Chrome 或 Edge。

| 平台 | 文件 |
|---|---|
| Windows x64 | `DiscoLurk_*_x64-setup.exe`，或便携版 `DiscoLurk-windows-x64-portable.zip` |
| macOS Apple 芯片 | `DiscoLurk_*_aarch64.dmg` |
| macOS Intel | `DiscoLurk_*_x64.dmg` |
| Linux x64 | `*.deb` 或 `*.AppImage`（需要 webkit2gtk-4.1） |
| 命令行 | `lurk-windows-x64.exe`、`lurk-macos-arm64`、`lurk-macos-x64`、`lurk-linux-x64` |

安装包没有代码签名，首次打开需要放行：

- **Windows**：SmartScreen 拦截时点「更多信息」→「仍要运行」。
- **macOS**：右键应用 →「打开」，或执行 `xattr -cr /Applications/DiscoLurk.app`。
- **Linux**：`sudo apt install ./DiscoLurk_*_amd64.deb`，或给 AppImage 加执行权限后运行。

关闭窗口后应用留在托盘继续跑定时任务，从托盘菜单退出（macOS 用 ⌘Q）。

### 更新

- Windows / Linux：「关于」页一键更新，会中断正在进行的运行。
- macOS：下载新 DMG 覆盖安装，再执行一次 `xattr -cr`。
- 命令行：替换 `lurk-*` 文件。
- Docker：`docker compose pull && docker compose up -d`。`latest` 只跟正式版。

## 登录

登录由你在弹出的浏览器窗口里手动完成。

- 桌面应用：「Profile」页新建 Profile，点「登录」。
- 命令行：`lurk login --site linuxdo --profile default`，登录后程序自动检测（最多等 5 分钟）。

登录状态存在数据目录的 `profiles/<站点>/<名称>/` 下，相当于你的登录凭据，不要分享。

| 系统 | 数据目录 |
|---|---|
| Windows | `%APPDATA%\disco-lurk\` |
| macOS | `~/Library/Application Support/disco-lurk/` |
| Linux | `~/.local/share/disco-lurk/`（或 `$XDG_DATA_HOME/disco-lurk/`） |
| Docker | `/data/disco-lurk/` |

日志在数据目录的 `logs/` 下。

## 运行

桌面应用在「运行」页操作。命令行：

```bash
lurk run --site linuxdo                                   # 随机读 15–40 个话题
lurk run --site linuxdo --browse-mode quick --run-mode topics:30 --headless
lurk run --site linuxdo --categories develop,news
lurk run --run-mode time:45 --like --like-rate 30         # 45 分钟，30% 概率点赞
lurk run --preset <预设 id>                               # 用界面里保存的预设
```

`Ctrl+C` 停止，再按一次强制退出。`--json` 按行输出 JSON 事件。

退出码：`0` 完成，`2` 取消，`3` 需要登录或遇到验证页，`4` 浏览器或配置错误，`5` 页面结构变了，`6` 没有可读的话题。

## 定时任务

桌面应用在「定时任务」页管理。命令行：

```bash
# 每天 07:00–23:00 随机跑 2 次
lurk schedule add --name 日常 --site linuxdo --runs 2 --window 07:00-23:00

# 工作日 20:30，有头；没有图形界面时改用无头
lurk schedule add --name 晚间 --id evening --cron "30 20 * * 1-5" --headed --fallback-headless

lurk schedule list
lurk schedule pause|resume|run-now|remove evening
```

- 定时任务需要 `lurk serve` 或桌面应用在运行。
- 程序没开时错过的任务默认跳过，`--misfire run-once` 改为补跑一次。
- 同一个 Profile 正在运行时，新触发会跳过。
- `lurk serve` 或桌面应用运行时，`pause` / `resume` / `run-now` 请在 Web 界面里操作。

## lurk serve

```bash
lurk serve                                               # 只监听本机，启动时生成临时令牌
LURK_TOKEN=$(openssl rand -base64 48) lurk serve --host 0.0.0.0 --headless
```

提供 Web 界面（`http://<地址>:<端口>/`，用令牌登录）、API 和定时任务。监听非本机地址时必须设置至少 32 字节的 `LURK_TOKEN`，建议放在 HTTPS 反向代理后面。

## Docker

镜像 `ghcr.io/logicapogee/discolurk`，只有 linux/amd64（Chrome 没有 Linux arm64 版）。

```bash
cd docker
cp .env.example .env          # 至少填 LURK_TOKEN
mkdir -p data && sudo chown 10001:10001 data
docker compose up -d
```

容器里没法有头登录。先在电脑上登录，再把 Profile 复制进卷（以 macOS 为例）：

```bash
mkdir -p docker/data/disco-lurk/profiles/linuxdo
cp -R ~/Library/Application\ Support/disco-lurk/profiles/linuxdo/default docker/data/disco-lurk/profiles/linuxdo/
sudo chown -R 10001:10001 docker/data
```

注意：

- `LURK_RUNS_PER_DAY` 大于 0 才会自动排程。
- 不设 `TZ` 时容器用 UTC。
- 令牌也可以用 Docker secret 传入，见 `docker-compose.yml` 里的注释。

## 环境变量

优先级：命令行参数 > 环境变量 > 预设 > 默认值。

| 变量 | 说明 | 默认 |
|---|---|---|
| `LURK_SITE` | 站点 id，见 `lurk sites list` | `linuxdo` |
| `LURK_USERNAME` / `LURK_PASSWORD` | 用账号密码登录 `LURK_SITE`，需成对设置 | 无 |
| `LURK_TOKEN` / `LURK_TOKEN_FILE` | 远程访问令牌，或存放令牌的文件 | 无 |
| `LURK_TRUSTED_PROXIES` | 可信反向代理地址，逗号分隔 | 空 |
| `LURK_PORT` | 监听端口 | `8080` |
| `LURK_BROWSE_MODE` | `deep` / `quick` | `deep` |
| `LURK_RUN_MODE` | `endless` / `topics:<n>` / `topics:<min>-<max>` / `time:<分钟>` | `topics:15-40` |
| `LURK_RUNS_PER_DAY` | 每天自动运行次数，`0` 不排程 | 不排程 |
| `LURK_WINDOW` | 运行时间窗 | `07:00-23:00` |
| `LURK_JITTER_MIN` | 随机偏移（分钟） | `15` |
| `LURK_RUN_ON_START` | 首次启动时立即跑一次 | `true` |
| `LURK_LIKE` / `LURK_LIKE_RATE` | 点赞开关和概率（%） | `false` / `30` |
| `LURK_CATEGORIES` | 板块，逗号分隔 | 站点内置板块 |
| `LURK_PROXY` | `http://`、`https://` 或 `socks5://` 代理 | 直连 |
| `TZ` | 时区 | 系统时区，Docker 为 UTC |
| `LURK_DATA_DIR` / `LURK_UI_DIR` | 数据目录、界面目录 | 平台默认 |

自动回复不能用环境变量开启，只能在界面里确认，或用 `lurk run --reply --i-understand-auto-reply-risk`。

## 常见问题

- **找不到 Chrome**：安装 Chrome 或 Edge，`lurk doctor` 可以看检测路径。

- **需要登录（退出码 3）**：登录过期了，重新登录。Docker 用户需要重新复制 Profile。

- **遇到验证页**：程序不会绕过。有头运行时会等你手动通过（最多 5 分钟）；无头运行会直接停止，用有头模式打开同一个 Profile 通过验证后再跑。

- **站点统计比本次读的少**：进度页有缓存。

- **Profile 被占用**：同一个 Profile 同时只能开一个浏览器，`lurk doctor` 会显示占用的进程。

- **没有可读话题（退出码 6）**：用 `--categories` 指定板块。

- **容器写不了 `/data`**：`sudo chown -R 10001:10001 docker/data`。

- **定时任务没跑**：看 `lurk schedule list` 的记录，`missed` 是当时程序没开，`skipped` 后面写了原因。

## 命令

| 命令 | 说明 |
|---|---|
| `lurk login --site <id> [--profile <名称>]` | 登录并保存 Profile |
| `lurk run [选项]` | 运行一次，选项见 `lurk run --help` |
| `lurk schedule list\|add\|remove\|pause\|resume\|run-now` | 定时任务 |
| `lurk sites list` | 列出站点 |
| `lurk sites discover-categories --site <id>` | 读取站点板块 |
| `lurk doctor` | 检查浏览器、Profile、端口、网络 |
| `lurk serve` | 后台服务和 Web 界面 |

## 开发

```bash
pnpm install
pnpm vitest run && pnpm typecheck
pnpm lurk run --headless
pnpm build:sidecar && pnpm gate:sidecar
pnpm tauri dev
docker build -f docker/Dockerfile --platform linux/amd64 -t disco-lurk:dev .
```
