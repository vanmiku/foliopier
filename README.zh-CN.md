<div align="center">

<img src="docs/brand/mark.svg" width="72" height="72" alt="FolioPier AI 标识">

# FolioPier AI

**阅读、审阅与分享 AI 生成的成果。**

Claude Code 和 Codex 发布文件，你在电脑或手机上查看内容、回答问题、比较版本，再把准备好的成果分享给他人。

[![正式版本](https://img.shields.io/github/v/release/vanmiku/foliopier?color=b7441c&label=release)](https://github.com/vanmiku/foliopier/releases)
[![测试](https://github.com/vanmiku/foliopier/actions/workflows/test.yml/badge.svg)](https://github.com/vanmiku/foliopier/actions/workflows/test.yml)
[![MIT](https://img.shields.io/badge/license-MIT-555)](LICENSE)

[开始使用](#开始使用) · [工作流程](#工作流程) · [文档分享](#分享选定的成果) · [会话连接说明](docs/sessions.zh-CN.md) · [English](README.md)

</div>

<img src="docs/readme/zh-hero.png" width="100%" alt="FolioPier AI 的电脑和手机界面，展示项目成果列表和渲染后的文档。">

## Agent 工作，你来审阅

方案、报告、原型和表格，都需要一个方便阅读与确认的地方。FolioPier AI 把编码 Agent 生成的成果整理成工作台，提供文件渲染、项目归档、版本记录、提问和批注。

发布的文件保存在自己的机器上，不需要注册托管账号。远程访问和临时文档分享期间，部署机器需要保持在线。

## 工作流程

1. **Agent 发布。** 文件或目录成为项目中的一篇成果；同一 slug 再发布，会生成新版本。
2. **你来审阅。** 在电脑或手机上阅读内容、批注选段、回答问题或填写审批单。
3. **继续修改与交付。** Agent 读取反馈并发布修订，你比较变化，再分享选定文件。

安装时会把发布与读取反馈的说明接入 Claude Code 和 Codex，之后由 Agent 使用这些命令。

## 开始使用

把下面这句话发给 Claude Code 或 Codex：

```text
请按照 https://github.com/vanmiku/foliopier/blob/main/INSTALL.md 的说明，帮我安装 FolioPier AI。
```

Agent 会检查电脑，引导你选择访问方式和语言，完成安装并给出地址。账号授权或系统密码等需要本人操作的步骤，仍由你确认。

**运行环境：** macOS、Linux 或 Windows 10/11，Node.js 20 及以上。Word 和 PowerPoint 预览可选安装 LibreOffice。跨设备访问可以使用 Tailscale；同一网络下也支持访问码和设备批准。

在部署电脑上，只要服务运行，`http://127.0.0.1:4870/` 就能使用，不依赖 Tailscale。自定义端口时运行 `foliopier url --local` 查看地址。

<details>
<summary>从源码安装</summary>

```bash
git clone https://github.com/vanmiku/foliopier
cd foliopier
./setup.sh check --json
./setup.sh install --access local --lang zh --json
foliopier doctor --json
```

Windows 使用 `setup.cmd` 代替 `./setup.sh`。其他访问方式、自启动和已有安装的更新方法见 [INSTALL.md](INSTALL.md) 与[兼容说明](docs/compatibility.md)。

</details>

## 阅读真正的文件

- **文档与数据：** Markdown 目录、表格、代码和 Mermaid 图；PDF、图片、HTML、CSV 与 Excel 表格、Office 排版预览，以及源代码、音视频。
- **版本：** 保留历史并比较变化，受支持的文本对比可标出改动词句。新版本出现时，不丢弃正在填写的答案或批注。
- **手机阅读：** 适配窄屏的导航、明暗主题、中英文，以及打印与 PDF 视图。
- **结合原文的反馈：** 选段批注、审批单、选择题和待办。Agent 可以读取反馈，并在发布修改后标记已处理。

<img src="docs/readme/zh-phones.png" width="100%" alt="FolioPier AI 的手机文档阅读、提问和分享界面。">

## 边读文章，边继续对话

文章旁提供「目录 / Codex / Claude Code」切换。设置中分别开启会话查看和消息发送。受支持的连接可以发送文字，Codex App 连接还支持上传或粘贴图片。排队、已送达和处理完成分别显示。

这些连接是**需要主动开启的预览功能**，支持范围比工作台本身窄。Codex App 连接依赖受支持的本地 IPC 环境，自动唤醒目前在 macOS 实现；经过验证的 tmux 连接、Claude App Code Remote Control 各有条件。原账号、额度和 Agent 权限仍然适用。普通已批准的局域网浏览器可以看会话，但不能发送。

开启前请阅读[连接能力表与排查说明](docs/sessions.zh-CN.md)。

## 分享选定的成果

开启「设置 → 互联网文档分享」，再从文章点击「分享」。选择文件、访问码、有效期、版本跟随方式，以及是否允许 PDF 下载和访客私密留言。

访客直接打开浏览器链接，无须加入你的 Tailscale 网络。专门的 Funnel 阅读入口只提供选定的文档包，Agent 对话和工作台控制保持私有。HTML 附件使用不运行脚本的静态预览；PDF 下载取决于分享电脑上的浏览器配置。

**分享期间保持部署电脑在线。** 这是从自己机器提供的临时分享。配置方法和限制见[分享说明](docs/sharing.zh-CN.md)。

## 围绕自己的机器运行

服务器使用 Node.js HTTP，版本文件保存在本地。工作台与可运行脚本的文件预览采用不同源；可信的本机、Tailnet 和普通已批准局域网访问具有不同能力。公开分享还有独立的监听入口和访问控制。

支持 launchd、systemd、Windows Startup 或普通后台进程。更新跟随经过测试的正式版本，安装保留原数据与访问设置。[安全模型](SECURITY.md) · [连接限制](docs/sessions.zh-CN.md) · [已有安装兼容](docs/compatibility.md)

## 给 Agent 和贡献者

```bash
foliopier publish report.md --slug review --title "项目复核"
foliopier feedback --json
foliopier doctor --json
```

[Agent skill](skills/mydash/SKILL.md) 说明了发布、提问、审批和待办的用法。修改源码前请阅读 [AGENTS.md](AGENTS.md)。安全问题请通过 [GitHub 私密安全报告](https://github.com/vanmiku/foliopier/security/advisories/new)提交。

FolioPier AI 独立于 OpenAI 和 Anthropic。Claude Code、Codex 及其他产品名称属于其各自所有者。

[MIT 许可证](LICENSE) · 作者 [vanmiku](https://github.com/vanmiku)
