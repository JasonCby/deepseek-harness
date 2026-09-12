# Agent Note: 飞书卡片模板 —— 注册表、变量与 workflow meta 地基

Status: implemented

[English](2026-09-11-feishu-card-templates.md) | 中文

## Problem

结构化轮次只回一张固定的 markdown 投影卡。企业形态需要租户自设计的卡片——在飞书卡片搭建工具中制作——并由确定性数据填充；而工作流轮次的数据源、运行返回值，并不持久：`tool-workflow/run-end` 只带 `{runId, stopReason}`，模型可见的结果文本不是结构化来源。

## Decision

两个切片。`dsh-tool-workflow` 投影 `output.presentationMeta`——`{runId, name, result}`，与渲染文本共用同一 `maxResultChars` 预算；超限结果整体省略，因为截断的 JSON 文档会呈现为「存在但错误」——该投影落入持久的 `tool/result.meta`。飞书包在其上建立纯管道：`matchCardTemplate` 绑定注册表中首个 `bindTool` 在轮次窗口内运行过的条目（可选 `workflowName` 二级过滤读运行的显示名）；`resolveTemplateVariables` 从消息事实（`chatId`、`senderOpenId`、`threadId`）与进入所绑工具结果 meta 的点路径提取所声明的变量——必填缺失或超过 `maxLength` 即淘汰该模板；`renderTemplateReply` 产出平台模板引用（`{type: 'template', data: {template_id, template_variable}}`）或把 `{{variable}}` 占位符插值进本地卡片 JSON 1.0 骨架；`convertCardV2toV1` 把搭建工具导出的 2.0 文档投影为 1.0（body 提升、2.0 专属键丢弃、裸图补 `alt`）——该映射已在 SaaS 私聊经 reply 端实测验证。卡片形态解析（显式 `card` 与 `auto` 同样）先试模板链、回退 markdown 投影；模板投递被拒时以投影重试一次，错误配置的模板绝不丢失回答。三个重放工作流的快照 fixture 已刷新（`DSH_SNAPSHOT=refresh`）；唯一差异是新增的 `meta` 行。

## Consequences

- 绑定以工具名为键——稳定的已记录身份：通用 `workflow` 工具的绑定较粗，直到固定流程工具存在（tool-ralph 形态），逐流程模板才精确。
- `tool/result.meta` 对工作流调用从此持久；模板变量是该状态的纯投影，回放可复现卡片。模型可见输入无变化。
- 本地卡片的 `img_key` 属于上传该图片的应用；跨应用 key 在发送时被拒（表现为通用 230099）。

## Alternatives considered

仅按工作流显示名绑定被否决：该名称由模型逐次调用选择，不是部署身份。超长变量静默截断被否决：展示截断会被读成数据。`modelUsable` 模板标志推迟到出卡工具 PR——没有读取方的白名单是死配置。
