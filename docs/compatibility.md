# Existing-install compatibility

FolioPier AI is the new product name. It continues the same repository, version history and installation; users do not need to migrate documents or grant broader Agent permissions.

- `foliopier` is the primary command. `mydash` remains an equivalent alias, including on Windows. Both use the same configuration and files.
- Existing storage remains under `~/.mydash`, or the configured `MYDASH_HOME`. Service IDs, Agent hook paths/markers, rule filenames, cookies, browser storage and protocol headers retain their legacy identifiers. These identifiers do not create a second installation.
- Existing managed permissions retain the old command and add the equivalent new command only for the same operations. Existing sending/viewing choices and original Agent permissions remain in effect.
- The GitHub repository is renamed in place to `vanmiku/foliopier`. Older Git URLs continue through GitHub's redirect; installed copies can find new stable tags through their saved source remote. Do not reuse the old repository name for another repository.
- Existing Tailscale devices and URLs keep their actual names. New dedicated nodes default to `foliopier`; the installer reports the actual assigned name when there is a collision. Always use the reported address.
- Notification grouping and existing DingTalk robot keyword compatibility keep their legacy identifiers. This avoids breaking notification subscriptions or group-robot security settings.
- Existing user documents and previous releases are not rewritten. New icons and visible product labels appear after updating; some home-screen launchers may require refreshing or re-adding the shortcut to pick up changed artwork.

## 已有安装

产品现在叫 FolioPier AI，仍沿用同一个仓库、版本记录和安装。`foliopier` 为主要命令，旧的 `mydash` 命令继续可用，两者访问同一份数据与配置。

已有数据目录、服务、Hook 标记、浏览器状态与协议字段保留兼容；不用搬动文件。已有会话查看与发送选择、原 Agent 权限继续生效。原 Tailscale 设备地址也不会被改名，后续以安装器给出的实际地址为准。

更新不会改写你过去发布的文章。若手机主屏图标仍显示旧画面，可刷新或重新添加快捷方式。
