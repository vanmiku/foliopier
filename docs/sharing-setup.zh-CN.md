# 更新后如何开启互联网文档分享

适用于 FolioPier AI 已更新到 0.3.0 或更新版本、工作台可以打开，但“互联网文档分享”无法开启的情况。

更新 FolioPier AI 后，还需要开启分享并完成 Tailscale Funnel 授权。访客只需浏览器、分享链接和访问码，无需安装 Tailscale。

## 方法一：在网页中开启

### 1. 在运行 FolioPier AI 的电脑上打开设置

刷新 FolioPier AI 页面，进入“设置 → 互联网文档分享”。也可以在运行 FolioPier AI 的电脑上直接打开：

```text
http://127.0.0.1:4870/settings#internet-sharing
```

如果安装时改过端口，在终端运行以下命令，用输出的网址打开工作台，再进入设置：

```sh
foliopier url --local
```

这些本机地址只能在运行 FolioPier AI 的电脑上使用。通过普通局域网授权打开工作台的设备没有管理互联网分享的权限；请换到这台电脑，或使用可信的 Tailscale 连接。

### 2. 检查 Tailscale 登录

普通安装：在这台电脑上打开 Tailscale，确认已登录并连接。

独立节点安装（`tailscale-node`）：需要登录和批准的是 FolioPier AI 的独立节点。运行 `foliopier doctor`，如果提示节点需要登录，打开它给出的链接完成批准。电脑上另一个 Tailscale 客户端已连接，不代表独立节点也已登录。

### 3. 开启并完成授权

点击“开启互联网分享”。如果出现“前往 Tailscale 授权”，点击它，在 Tailscale 页面中完成授权。公司或团队的网络可能需要管理员批准。

授权完成后，回到 FolioPier AI，再点一次“开启互联网分享”。

当前 0.3.0 的“重新检测”只检查状态，不会重试配置。即使 Tailscale 授权已经完成，只点“重新检测”也可能继续显示之前的授权错误。

成功后，页面会显示：

> 分享入口已配置，外网访问尚未独立验证。

如果没有授权按钮，或提示需要开启 MagicDNS、HTTPS，请按下面的“手动完成 Tailscale 后台设置”操作。

### 4. 创建链接并测试

打开要分享的文档，点击“分享”，选择文件和有效期，再点击“生成链接和访问码”。把分享链接与访问码一起发给访客。

用手机关闭 Wi-Fi、断开 Tailscale，通过移动数据打开这条分享链接并输入访问码。这样才能确认普通互联网用户也能访问。首次公网 DNS 生效可能需要最多约 10 分钟。[Tailscale DNS 排障说明](https://tailscale.com/docs/features/tailscale-funnel#dns-propagation)

## 手动完成 Tailscale 后台设置

如果网页授权没有完成，请用该 Tailscale 网络的管理员账号操作：

1. 打开 [Tailscale 管理后台](https://console.tailscale.com/)，确认选中分享节点所在的网络。
2. 进入“DNS”，开启“MagicDNS”。
3. 在 DNS 页找到“HTTPS Certificates”，启用 HTTPS 证书。设备域名会出现在公开证书记录中。
4. 进入“Access controls”，找到“Funnel”区域，选择“Add Funnel to policy”。如果网络已有自定义策略，由管理员确认分享所用节点的用户或标签已获得 `funnel` 权限，保留其他现有规则。
5. 回到 FolioPier AI，再点击“开启互联网分享”。

没有后台管理权限时，请把这几步交给管理员。Funnel 的具体权限与授权要求见 [Tailscale 官方说明](https://tailscale.com/docs/features/tailscale-funnel)。

## 方法二：用命令行重试开启

以下命令在运行 FolioPier AI 的电脑上执行。它们调用 FolioPier AI 的本机接口，与网页的“开启互联网分享”作用相同，会按已有安装配置选择系统 Tailscale 或独立节点，并保存分享状态。

这一步会尝试开启文档分享的公网入口；文档仍需在“分享”中生成链接和访问码后才能提供给访客。Tailscale 要求的登录和管理员授权仍需完成。

### macOS / Linux

打开终端，完整复制运行：

```sh
MYDASH_LOCAL_URL="$(foliopier url --local)"
MYDASH_LOCAL_URL="${MYDASH_LOCAL_URL%/}"

curl --noproxy '*' --silent --show-error --max-time 90 \
  -H 'X-Mydash: 1' \
  -H "Origin: $MYDASH_LOCAL_URL" \
  -H 'Content-Type: application/json' \
  --data '{"action":"enable"}' \
  "$MYDASH_LOCAL_URL/api/sharing/setup"
```

如果提示 `foliopier: command not found`，默认安装可以把第一行中的 `foliopier` 换成 `"$HOME/.local/bin/mydash"`；自定义安装请使用原来的命令路径。

### Windows PowerShell

打开 PowerShell，完整复制运行：

```powershell
$MydashLocalUrl = (foliopier url --local).Trim().TrimEnd('/')
$MydashHeaders = @{
  'X-Mydash' = '1'
  'Origin' = $MydashLocalUrl
}

try {
  Invoke-RestMethod -Method Post `
    -Uri "$MydashLocalUrl/api/sharing/setup" `
    -Headers $MydashHeaders `
    -ContentType 'application/json' `
    -Body '{"action":"enable"}' `
    -TimeoutSec 90 | ConvertTo-Json -Depth 8
} catch {
  $_.ErrorDetails.Message
  $_.Exception.Message
}
```

### 看返回结果

| 返回内容 | 下一步 |
| --- | --- |
| `"phase":"configured"` | 已配置。回文档生成链接和访问码，再用手机移动数据测试 |
| `AUTHORIZATION_REQUIRED` | 打开返回结果中 `status.authUrl` 的 HTTPS 链接完成授权，然后重新运行开启命令 |
| `TAILSCALE_MISSING` | 安装 Tailscale；独立节点安装则用 `foliopier doctor` 检查节点是否完整 |
| `TAILSCALE_LOGIN`，或状态为 `login` | 登录分享所用的 Tailscale 节点，再重新运行开启命令 |
| `MAGICDNS_REQUIRED` | 按上面的后台步骤开启 MagicDNS 和 HTTPS，再重试 |
| `TAILSCALE_PERMISSION` | 参考下面的“权限不足”；Funnel 的网络授权与本机操作权限需要分别处理 |
| `SHARE_PORT_BUSY` | `8443` 和 `10000` 两个分享端口均被占用。先确认占用它们的服务，调整其中一个服务后重试 |
| `404` 或返回的是网页 | 确认连的是工作台本机地址，并确认运行中的服务已更新到支持分享的版本 |

返回 JSON 的缩进和空格可能不同，认准字段值即可。授权后需要重新运行的是 `enable`，不要只查询状态。

## 仍然无法开启

### 提示权限不足

Linux 使用系统 Tailscale 时，如果 FolioPier AI 运行用户无权配置转发，可由管理员把该用户设为 Tailscale operator。以运行 FolioPier AI 的同一个用户登录后执行：

```sh
sudo tailscale set --operator="$(id -un)"
```

完成后回到 FolioPier AI 再点“开启互联网分享”。这条命令用于系统 Tailscale；独立节点安装不要拿它去配置另一个节点。[Tailscale operator 说明](https://tailscale.com/docs/reference/tailscale-cli)

### macOS 提示客户端不支持

先更新 Tailscale 再重试，并保留具体报错。官方 CLI 文档说明，App Store 和 Standalone 客户端可以分享端口，直接分享文件或目录才受沙箱限制；FolioPier AI 使用的是端口转发。不要仅凭客户端来自 App Store 就卸载或更换现有安装。[官方兼容性说明](https://tailscale.com/docs/reference/tailscale-cli/funnel)

### PDF 显示未就绪

PDF 下载组件未就绪不影响文档阅读。需要 PDF 下载时，在运行 FolioPier AI 的电脑上安装 Chrome 或 Edge，然后重新检测。

### 已配置，但外网打不开

确认分享未过期、链接包含完整路径和端口，并输入正确的访问码。首次配置可等待 DNS 生效后再试。分享期间，电脑必须保持联网、避免睡眠，并让 FolioPier AI 和 Tailscale 持续运行。

### 需要反馈问题

提供 FolioPier AI 设置页的错误提示、命令返回的 `code` / `errorCode`、操作系统，以及是否使用独立节点。可以运行 `foliopier --version` 确认命令行版本，运行 `foliopier doctor` 获取诊断。反馈时不要附完整配置文件、授权链接或访问码。

请通过 FolioPier AI 开启分享。直接运行一条 `tailscale funnel` 命令并不能替 FolioPier AI 保存完整的分享配置；也不要把工作台的 `4870` 端口直接公开到互联网。
