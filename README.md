# OpenAI Image Tools

为 DeepSeek Harness 提供同步与异步图片工具：

- `generate_image`：同步调用 OpenAI 兼容的 `/images/generations` 文生图接口。
- `edit_image`：同步读取工作区图片，以 multipart/form-data 调用 `/images/edits` 图生图/编辑接口。
- `generate_image_async`：创建 DSH 后台文生图 Job 并立即返回 Job ID。
- `edit_image_async`：创建 DSH 后台图生图 Job 并立即返回 Job ID。

同步结果会直接作为图片内容块返回。异步结果会保存到 Harness 附件存储，并在 Job 结束后向发起任务的原会话追加图片；任务可通过内置的 `job_list`、`job_output` 和 `job_kill` 查看或取消。

四个 ToolDefinition 携带非模型字段 `snowlumaCapability`，由插件自身声明中文名称、用途、插件包来源和风险。SnowLuma 等能力目录可在运行时动态读取这些 metadata；这不会改变模型看到的 tool schema，也不要求能力目录硬编码本插件或工具名。

## 配置

插件安装后，在主界面的“插件 → 已安装”中打开本插件，再点击 `dsh-openai-image-tools` 行的“配置”进入参数表单：

- `baseURL`：默认 `https://api.openai.com/v1`
- `apiKey`：Bearer API Key（Secret 字段；可信本地服务可留空）
- `model`：默认 `gpt-image-1`
- `generationPath` / `editPath`：兼容服务的端点路径
- `responseFormat`：`auto`、`b64_json` 或 `url`
- `imageField`：图生图 multipart 图片字段 `image` 或 `image[]`
- 请求超时、下载超时、输入/输出大小和图片数量上限
- `allowPrivateImageUrls`：仅在可信本地服务返回私网图片 URL 时启用

## 兼容范围

默认严格使用 OpenAI Images API：文生图发送 JSON，图生图发送 multipart。响应同时支持 `b64_json` 与临时 `url`。URL 结果会立即下载并转存为持久附件。

图生图输入使用 `image_paths`，路径按当前 Session 工作目录解析；可选 `mask_path` 必须是 PNG。插件不会在 400 响应后自动切换 multipart 字段或重试，以避免重复生成和计费。

## npm 发布

仓库使用 [npm Trusted Publisher](https://docs.npmjs.com/trusted-publishers) 和 GitHub Actions OIDC 发布，不保存 `NPM_TOKEN`。在 npm 包设置中配置：

- GitHub 用户或组织：`AYui124`
- 仓库：`dsh-openai-image-tools`
- Workflow 文件：`publish.yml`
- Environment：留空

创建并发布 GitHub Release 时，Release Tag 必须与 `package.json` 版本一致，例如 `v1.1.1`。工作流会验证版本、安装依赖、运行检查与测试，然后将 scoped package 公开发布到 npm。

## License

[MIT](./LICENSE) © 2026 AYui124
