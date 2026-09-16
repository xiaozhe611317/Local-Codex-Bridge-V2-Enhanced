# Windows：持久保存 Tunnel 运行密钥与登录自启动

本指南描述已经在 Windows 本机部署中验证的方案。Tunnel 是外部组件；本仓库不签发 Tunnel 密钥，也不包含每台机器的 Tunnel profile、认证文件或部署脚本。下文的部署脚本名称是实现职责说明，不是可从本仓库直接运行的安装命令。

## 1. 创建或复用服务端运行密钥

在所使用 Tunnel 服务的可信管理界面中创建或获取该隧道的运行密钥，按服务提供的权限和有效期选项配置。不要把 Tunnel ID、ChatGPT 连接授权或 OpenAI API key 当作 Tunnel 运行密钥。本方案的 Tunnel client 从 `CONTROL_PLANE_API_KEY` 接收运行密钥。

“长期保存”不等于服务端密钥永久有效。DPAPI 仅保护本地保存，不改变服务端有效期、撤销状态或权限。已经能正常连接的运行密钥可以继续使用，无需因为 Bridge 重启或 Codex 桌面更新重新创建。只有服务端过期/撤销、主动轮换或本机加密材料不可用时才需要重新配置。

具体签发入口和有效期以所用 Tunnel 服务的当前文档为准，不假定所有服务都有“永不过期”选项。

## 2. 一次性本机初始化

部署时提供 `Initialize-TunnelKey.ps1` 与配套密钥模块，遵循以下流程：

1. 在日常运行 Tunnel 的 Windows 账户下，用 `Read-Host -AsSecureString` 隐藏输入现有运行密钥。
2. 使用 Windows DPAPI `ProtectedData.Protect`，保护范围设为 `CurrentUser`，把加密结果写入仓库以外的私有目录。若使用附加 entropy，解密时必须使用同一值；entropy 不是另一份秘密密钥。
3. 已有文件默认不覆盖，轮换必须显式指定替换。使用临时文件加原子替换，并让私有目录 ACL 仅允许预期账户和必要的系统管理主体访问。
4. 用 `Test-TunnelKey` 在内存中解密验证，只返回 `True/False`；不输出明文、密文或敏感环境变量。验证结果只证明当前用户能够解密，不证明服务端尚未撤销密钥。
5. 尽可能清理临时字节数组、SecureString 和明文引用。DPAPI 不能防御已经取得当前用户执行权限的程序，也不保证托管字符串立即从内存擦除。

不要把密钥放入命令行、用户/系统永久环境变量、Git、截图或日志。加密文件也不应提交。该文件不能当作跨账户、跨机器可用的通用凭据备份；迁移时应在目标账户重新初始化。

## 3. 后台启动器的职责

本机部署可用以下分工：

| 文件 | 职责 |
| --- | --- |
| `DpapiTunnelKey.psm1` | CurrentUser 加密、解密、布尔验证 |
| `Initialize-TunnelKey.ps1` | 隐藏输入、首次保存、显式轮换 |
| `Bridge.ps1` | 精确进程身份检查、Start/Status/显式 Restart |
| `Autostart.ps1` | 先启动或复用 Tunnel，再启动 Tray |
| `Launch-CodexBridge.vbs` | 隐藏窗口启动 Autostart |
| `Install-LogonTask.ps1` | 注册当前用户的登录任务 |

后台启动器应通过 `ProcessStartInfo` 的子进程环境注入解密后的 `CONTROL_PLANE_API_KEY`，设置 `UseShellExecute=false`，启动后及时清理启动器中的明文引用。不要打印 ProcessStartInfo 环境或未经脱敏的 doctor 输出。Bridge 已移除传给 Codex app-server 的 Tunnel 控制面密钥。

Start 操作应核验已有进程的 PID、创建时间、可执行文件和 profile；已有正确实例就复用。不能只凭进程名杀进程，不能在登录时强制重启。遇到不匹配实例或认证失败应停止启动流程并报告脱敏状态。

所有部署路径应按目标机器配置，包括 PowerShell 7、Tunnel client、Node、构建后的 Bridge 入口、profile、健康检查地址和 Tray。严格 stdio transport 应直接运行 Node 和构建入口，不使用 `npm start`。

## 4. 注册 Windows 登录自启动

使用任务计划程序，配置为：

| 选项 | 设置 |
| --- | --- |
| 任务名称 | `Local Codex Bridge Secure Autostart` |
| 触发器 | 指定当前用户登录时 |
| 执行身份 | 与初始化 DPAPI 文件相同的用户 |
| 登录类型/权限 | Interactive / Limited（无需最高权限） |
| Action | `wscript.exe`，参数为本机 `Launch-CodexBridge.vbs` 的完整路径 |
| 工作目录 | 部署脚本所在目录 |
| 多实例策略 | IgnoreNew |
| 时间限制 | 不设自动终止期限 |
| 其他 | StartWhenAvailable；按需要允许电池运行 |

这是“开机后用户登录时自启动”，不是“登录前系统服务”。不要改成 SYSTEM 或不同账户来运行，否则 CurrentUser 密钥和交互式 Tray 不能按原方案使用。登录前运行需要另外设计服务身份、凭据存储和无 Tray 启动流程。

## 5. 验收与维护

- 密钥文件存在，`Test-TunnelKey` 返回 `True`。
- 计划任务已启用、状态 `Ready`，触发器和 Action 与部署路径一致。Ready 只代表任务可运行，不证明 Tunnel 已启动。
- 实际 Tunnel/Bridge PID 存在且身份匹配；回环 `/readyz` 返回 ready；`/api/status` 的 main probe 为 ok，控制面元数据读取成功。
- 校验运行构建与磁盘构建一致。连接层 Ready 不能替代真实 app-server initialize/model-list 检查。
- Tray 运行且指向当前健康检查地址。显式重启 Tunnel 后若回环端口变化，应刷新对应 Tray。
- 真正的登录自动启动验收需要在保存工作后重新登录；仅注册任务并检查 Ready 不等于完成这项验收。

Codex 桌面自动更新后，本仓库会在每次启动 app-server 时重新解析桌面版本目录；失效的官方版本路径可回退到当前安装。显式自定义 executable 仍由调用者管理。该修复不会自动重启失败子进程或重放请求，失败后仍使用已有的受保护显式 restart 流程。

停用登录自启动时只需禁用对应计划任务，通常无需删除密钥；轮换时先取得新运行密钥、显式替换本机加密保存，再在确认 Bridge 空闲后重启并验证认证。所有检查仅输出脱敏状态和必要 PID。
