# OpenAI Image Tools

为 DeepSeek Harness 提供两个模型工具：

- `generate_image`：调用 OpenAI 兼容的 `/images/generations` 文生图接口。
- `edit_image`：读取工作区图片，以 multipart/form-data 调用 `/images/edits` 图生图/编辑接口。

生成结果会保存到 Harness 附件存储，并作为图片内容块直接返回给 Agent。

## 配置

插件安装后，在主界面的“插件 → 已安装”中打开本插件，再点击 `local-openai-image-tools` 行的“配置”进入参数表单：

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
