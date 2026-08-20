# Agent Note: Linux 原生目录选择器不应把显示连接失败误判为取消

Status: implemented

[English](2026-08-20-linux-directory-picker-display-failure.md) | 中文

## Problem

`resolveDirectoryPickerBackend` 只在启动时采样到 `DISPLAY`/`WAYLAND_DISPLAY` 存在时，才会在 Linux 上挂载 `native` 目录选择器 backend——这在采样那一刻是"该进程能够访问显示"的合理代理指标。但这个代理指标可能过时：由 init 系统（systemd、某个 supervisor）管理的进程，可能携带来自其 unit 定义或早先一次 attach 的 `DISPLAY` 值，却从未真正持有到该显示的、有效授权的连接（例如 X/Wayland 会话已停止、`XAUTHORITY` 缺失或错误、socket 被拒绝访问）。启动时的检查无法观察到这一点，因为它从不实际启动选择器进程——它只检查环境变量。

在实际拾取（pick）时，`pickNativeDirectory` 的 Linux 分支会运行 `zenity`（仅在 `ENOENT` 时回退到 `kdialog`），并把每一个退出码为 1 的失败都映射为已取消的拾取（`return null`），完全不区分"操作者关闭了对话框"与"选择器进程根本没能打开窗口"这两种情况。GTK（zenity）与 Qt（kdialog）在无法访问显示时都会以退出码 1 结束，并向 stderr 打印一条显示连接诊断信息；这条诊断信息被直接丢弃，面向操作者的结果与点击"取消"没有任何区别。`NativeDirectoryFlow`（客户端占用者）会把 `null` 结果驱动进 `onCancel()`（一次静默的空操作），而把抛出的错误驱动进 `onError(message)`（一个可见的错误界面）——因此这种误判意味着点击"Add workspace"既不会弹出对话框，也不会有任何反馈。

## Decision

`pickNativeDirectory` 的 Linux 分支默认仍把退出码 1 视为取消（这对于一次真正的"取消"点击仍然是正确且唯一可靠的信号，因为那种情况下 stderr 为空），但现在会先检查失败的 stderr 中是否出现已知的 GTK/Qt 显示连接失败标记（`looksLikeDisplayFailure`，与一份标记列表逐一比对——"cannot open display"、"failed to connect to display"、"failed to connect to socket"、"no protocol specified"、"unable to init server"、"could not connect to display"、"no such display"）。一旦匹配，该失败就不会被当作取消，而是原样重新抛出（保留其捕获的 stdout/stderr/cause），最终到达 `onError`，让操作者得到真实的诊断信息，而不是一个看似毫无反应的选择器。这与现有的 macOS 分支做法一致——该分支早已通过检查 stderr（而非只信任退出码）来区分 `osascript` 真正的"User canceled. (-128)"取消与其他任何退出码为 1 的失败。

zenity→kdialog 的回退层不受影响：它仍然只在 `ENOENT`（工具缺失）时触发，绝不会在显示连接失败时触发，因此一次 zenity 显示连接失败会立即被抛出，而不会静默地重试 kdialog（在同一个损坏的环境中，kdialog 大概率会以相同方式失败）。

## Alternatives considered

**收紧启动时的 `resolveDirectoryPickerBackend` 探测逻辑，让它实际启动一个真实的选择器来确认显示连接存活后再选择 `native`。** 被否决：这会给每一次启动都增加一次真实的子进程启动（带来正在被诊断的同一类 GTK/Qt 启动开销与失败模式），而该 resolver 的文档定位是"根据采样到的主机事实做出的一次纯粹决策"；而且这也无法弥补启动*之后*显示连接失效的情形——按设计，该解析结果只采样一次，并在整个服务生命周期内保持固定。

**为每个选择器精确匹配一条 stderr 字符串（模仿 macOS 那种单一短语的检查方式），而不是使用标记列表。** 被否决：与 `osascript` 那条稳定、有文档记录的"User canceled. (-128)"消息不同，GTK/Qt 的显示连接诊断信息会随工具包版本、后端（X11 还是 Wayland）以及语言环境而变化；标记列表能够容忍这种变化，而不必追逐每一种具体措辞。

**保持该失败仍映射为取消，转而通过修复环境来解决问题（记录文档要求操作者把 `DISPLAY`/`WAYLAND_DISPLAY`/`XAUTHORITY` 传递进由服务管理的 `dsh web` 进程）。** 未被采纳为完整方案：这类指导确实真实存在，也值得写进文档，但它只覆盖了配置正确的那一种情形。一个配置错误、过期或事后被撤销的显示会话，是这段代码必须能够体面地降级、而不是静默吞掉的一种可达状态——这正是客户端 `onError` 界面存在的意义。

## Consequences

- 一个在启动时 `DISPLAY`/`WAYLAND_DISPLAY` 存活、但在实际拾取时已不可达的 Linux `native` 选择器，现在会向操作者呈现一条真实、有信息量的错误，而不是表现为一个静默无反应的"Add workspace"按钮。
- 一次真正的"取消"点击（stderr 为空、退出码为 1）不受影响，仍然会解析为 `null`。
- zenity→kdialog 的回退仍然只针对 `ENOENT`；任一工具出现显示连接失败都会立即抛出，不会被掩盖为一次重试。
- 该标记列表是针对 stderr 文本的一种启发式方法，并非对每一种 GTK/Qt 构建确切措辞的穷举；一条未匹配到的、未来出现的诊断信息仍会（与本次改动之前一样）落入取消分支。这是一个已知的、有界的缺口——扩充标记列表是一次安全的局部后续改动，而非设计层面的变更。

## Testing

`packages/host/directory-picker-native/tests/native-picker.spec.ts` 新增了以下覆盖：zenity 与 kdialog 退出码为 1、且 stderr 指明是显示/会话连接失败（单行与多行 stderr）的情形会作为错误抛出，而不是解析为 `null`；一次 zenity 显示连接失败不会回退到 kdialog（只有 `ENOENT` 才会回退）；以及在 zenity 出现 `ENOENT` 之后，kdialog 自身的显示连接失败会被正确抛出。既有的真正取消场景覆盖（zenity 与 kdialog 均为 stderr 为空、退出码为 1 的情形，包括 zenity→kdialog 的 `ENOENT` 回退路径）保持不变，且仍然通过。
