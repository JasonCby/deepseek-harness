# Agent Note: 飞书卡片在线上统一为规范卡片 JSON 1.0

Status: implemented

[English](2026-09-14-feishu-card-v1-canonical.md) | 中文

## 问题

卡片模板配置曾假定租户会提供卡片 JSON 2.0 的搭建工具导出，但租户从飞书卡片搭建工具实际导出的是卡片 JSON 1.0——且多为其多语言分享形态（`i18n_elements`/`i18n_header`）。设置校验器只接受规范的单语 1.0 形态，租户直接粘贴搭建导出会校验失败并静默杀死传输边缘（`installSection` 的抛错发生在 `onChange` 启动边缘之前）。预留的 2.0 投影器还会丢弃 `margin`/`horizontal_spacing`，而这两个键是 1.0 `column_set` 与 `column` 原生支持的——一份真实租户导出证实了它们的合法性。

## 决策

每张本地卡片都以规范卡片 JSON 1.0 渲染与发送：顶层 `config`、可选 `header`、非空 `elements`，且每个 `img` 带 `alt` 对象。配置接受两种输入方言，由 `resolveCardFormat` 在封闭联合 `CardInputFormat` 上解析：`'v1'`（规范 1.0）与 `'v1-builder-i18n'`（搭建工具多语言导出）。渲染时 `normalizeTemplateCard` 按设置键 `cardLocale`（默认 `zh_cn`）把搭建导出折叠提升为 `elements`/`header`；卡片 JSON 2.0 文档在设置校验处按名报错。`convertCardV2toV1` 保持导出，作为将来 `'v2'` 方言的预留投影器：新增该方言只需一个联合分支加一个归一化分支，且其键集现已保留 `margin`/`horizontal_spacing`。

## 后果

租户可直接粘贴搭建导出。方言错误或缺语种会在设置校验处大声失败，指名条目与语种，且先于任何轮次渲染。多语言渲染被推迟：每个部署折叠为一个可配语种，按观看者语言渲染随将来的 2.0 工作落地。设置校验器把卡片形态权威委托给 `resolveCardFormat`，校验与渲染因此不会漂移。

## 关联决策

[卡片模板 note](2026-09-11-feishu-card-templates.zh.md) 拥有注册表与变量管道；本 note 取代其对本地卡片的 2.0 导出表述。
