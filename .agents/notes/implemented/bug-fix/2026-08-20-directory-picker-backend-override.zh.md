# Agent Note: 目录选择器后端判定需要为服务托管式启动提供一个显式覆盖项

Status: implemented

[English](2026-08-20-directory-picker-backend-override.md) | 中文

## Problem

`resolveDirectoryPickerBackend` 从启动时的进程事实——绑定主机、`SSH_CONNECTION`／`SSH_TTY`，以及（在 Linux 上）`DISPLAY`／`WAYLAND_DISPLAY` 加上 `PATH` 上的选择器二进制——推断操作者所处的位置。该包自身的 README 早已记录：这种推断无法仅凭启动上下文来证明，并且点名了一个具体情形——在工作站本地启动、之后经 `ssh -L` 访问的情况。

同一缺口的另一种情形此前未被记录：由服务管理器启动的 `dsh web` 进程——一个 systemd unit（系统级或 `systemctl --user`）、或其他 supervisor。`SSH_CONNECTION`／`SSH_TTY` 只存在于交互式 SSH 登录 shell 的环境中；服务管理器从不会派生那样一个 shell，因此由 systemd 启动的进程无论操作者实际如何访问它，都不会携带这两个标记中的任何一个。当这样一个 unit 的定义中又恰好带有一个 `DISPLAY` 值——可能是编写时写死的、来自更早一次 attach 的、或者仅仅是其所指向的 X/Wayland 会话已经停止而变得陈旧——解析器的 Linux 分支就会看到 `DISPLAY` 存在、且没有 SSH 标记，从而判定为 `native`，即便每一个真实操作者都只能通过 SSH 隧道访问该服务，永远看不到那个弹在无人值守主机上的选择器窗口。`packages/host/directory-picker-native` 的配套修复（[2026-08-20-linux-directory-picker-display-failure](2026-08-20-linux-directory-picker-display-failure.md)）让由此产生的*选择器失败*表现为一条真实错误，而不是静默无反应，但它无法修复选择器"成功"的那种情形——`zenity`／`kdialog` 在一个没有任何浏览器操作者能看到的显示上打开了窗口，或者选择器自身那个长时间存活、豁免超时的 RPC 在脆弱的隧道中途失败。

没有任何一项启动时事实能够在不带来真实回归风险的前提下自动弥合这一缺口：`systemctl --user` 服务在真正有人值守的 Linux 桌面上同样很常见（自启动的会话服务），因此把"由任意 systemd unit 启动"当作"主机无人值守"的证据，会误判那种合法情形，并在桌面操作者从未要求改动的情况下，悄悄拿走一个原本能正常工作的 native 选择器。

## Decision

`resolveDirectoryPickerBackend` 在查询任何推断信号之前，先读取一个新的环境变量 `DSH_DIRECTORY_PICKER_BACKEND`。当它被设为 `native` 或 `browse`（区分大小写、精确匹配）时，该值会被直接返回，不再查询任何其他事实。任何其他取值——未设置、为空、或无法识别——都会原样落入既有的推断链；这是启动时基础设施，因此该变量中的一个笔误绝不能导致启动失败，或者产生"被忽略"之外的其他行为。

一个了解自身拓扑结构的操作者（一个只能通过 SSH 隧道访问的 systemd unit、一个容器、CI，或任何推断逻辑看不穿的启动上下文）只需在 unit 或 supervisor 定义中设置这一个变量一次，替代直接组合 `-browse` 后端与 surface 包的做法。README 中原有的"直接组合 `-browse`"这一变通方案依然有效、不受影响；新变量只是一种摩擦更小的达成同一结果的方式，无需触碰应用的插件组合。

## Alternatives considered

**自动检测由服务管理器发起的启动（例如 systemd 的 `INVOCATION_ID`／`JOURNAL_STREAM`，二者始终存在于某个 unit 所派生进程的环境中），并在其存在时强制判定为 `browse`。** 被否决：`systemctl --user` 服务是自启动真实桌面会话应用的一种普通且常见的方式，这样的进程完全可能像交互式启动的进程一样，携带一个存活的、有人值守的 `DISPLAY`。把"处于 systemd 之下"当作"无人值守"的证据，会让每一个把 `dsh web` 作为用户服务运行在自己桌面上的操作者遭遇回归——用一种新的误判（且受影响的操作者除了取消设置 `DISPLAY`——这一点解析器在本次改动之前就已支持——之外别无办法重新选回 `native`）去替换掉本次要修的这一个漏判。

**在启动时启动一个轻量级的显示探测进程，在选择 `native` 之前先确认选择器确实能够访问到显示。** 被否决：这会给每一次启动都增加一次真实的子进程启动（带来与选择器本身相同的 GTK/Qt 启动开销与失败模式），而该包自身的文档已经把这个解析器定位为"根据采样到的主机事实做出的一次纯粹决策"。它同样无法弥合启动*之后*显示变得不可达的那种缺口，因为按设计，解析只发生一次，并在整个服务生命周期内保持固定（[2026-08-20-linux-directory-picker-display-failure](2026-08-20-linux-directory-picker-display-failure.md) 覆盖的正是那种独立的、发生在实际拾取时的失败模式）。

**把这个缺口完整记录为一项已知限制，不提供任何面向操作者的手段。** 被否决：该包的 README 早已记录了密切相关的 `ssh -L` 情形，并点名"直接组合 `-browse`"作为缓解方式；在只需一行、启动时生效、零风险的覆盖项就能为每一个能够说清自身拓扑结构的操作者彻底弥合这一缺口的前提下，放任同一缺口的 systemd 情形不作处理，会是比直接提供该覆盖项更糟的结果。

## Consequences

- 一个从 systemd unit（或任何其他服务管理器）启动、且只能通过 SSH 隧道访问 `dsh web` 的操作者，现在可以在该 unit 上设置 `DSH_DIRECTORY_PICKER_BACKEND=browse`，从而永久获得可正常工作的 in-app 选择器，而无需改动应用的插件组合，也无需手动取消设置 `DISPLAY`。
- 该覆盖项是双向的（同样支持 `native`），因此它也可以作为未来出现推断回归、或当前启发式在相反方向上误判某种部署时的一个逃生舱口。
- 既有的推断式判定行为不受任何影响：所有此前的测试用例（回环绑定、SSH 标记、按平台的显示检查、空环境变量处理）都不受影响，因为该覆盖项只在出现一个显式、有效的取值时才会生效。
- *既是 systemctl --user 服务、又确实是有人值守的桌面会话*这种情形的缺口仍然不会被自动解决——这是上文被否决的自动检测方案所对应的设计取舍——它继续依赖既有的推断链（该推断链对这种情形本来就会正确判定为 `native`，因为在没有显式变量的情况下，它根本不会走到这个覆盖项）。

## Testing

`packages/host/directory-picker-auto/tests/resolve.spec.ts` 新增了以下覆盖：该覆盖项在一份原本完全满足 `native` 判定条件的配置上强制判定为 `browse`；该覆盖项在一份全网卡绑定加 SSH 启动的配置上强制判定为 `native`——这两个信号各自独立时都会判定为 `browse`；精确的"systemd 处于 SSH 隧道之后"这一场景（一份回环绑定、不含任何 SSH 标记、`DISPLAY` 存在的 Linux 配置，在没有该覆盖项时判定为 `native`，加上该覆盖项后判定为 `browse`）；以及一个未设置、为空、或无法识别的覆盖项取值会原样落入未改动的推断逻辑。`resolve.spec.ts` 中此前的全部用例保持不变并继续通过。
