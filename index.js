import z from '@deepseek-ai/schemastery'
import { basename } from 'node:path'
import { endpointURL, optionalImageFields, parseImageAPIResponse, sniffImageMediaType } from './api.js'

export const name = 'openai-image-tools'
export const inject = ['tools', 'attachments', 'fs', 'workingDirectory']

const MAX_TIMER_MS = 2_147_483_647
const enumSchema = values => z.union(values.map(value => z.const(value)))

export const Config = z.object({
  baseURL: z.string().default('https://api.openai.com/v1').volatile().description('OpenAI-compatible API root URL, not a complete image endpoint.'),
  apiKey: z.string().role('secret').volatile().description('Bearer API key. Leave empty for a trusted local compatible service.'),
  model: z.string().default('gpt-image-1').volatile().description('Default image model; each tool call may override it.'),
  generationPath: z.string().default('/images/generations').volatile().description('Text-to-image endpoint path relative to baseURL.'),
  editPath: z.string().default('/images/edits').volatile().description('Image edit endpoint path relative to baseURL.'),
  responseFormat: enumSchema(['auto', 'b64_json', 'url']).default('auto').volatile().description('auto omits response_format while still accepting b64_json and url responses.'),
  imageField: enumSchema(['image', 'image[]']).default('image').volatile().description('Multipart field used for input images. Use image[] for APIs that support repeated multi-image input.'),
  timeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(120_000).volatile().description('Image API request timeout in milliseconds.'),
  downloadTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(30_000).volatile().description('Timeout for downloading temporary image URLs returned by the provider.'),
  allowPrivateImageUrls: z.boolean().default(false).volatile().description('Allow provider-returned image URLs on localhost or private networks. Enable only for a trusted local service.'),
  maxInputImageBytes: z.natural().min(1).default(20 * 1024 * 1024).volatile().description('Maximum bytes read from each input image.'),
  maxOutputImageBytes: z.natural().min(1).default(25 * 1024 * 1024).volatile().description('Maximum bytes accepted for each generated image.'),
  maxImages: z.natural().min(1).max(16).default(4).volatile().description('Maximum input images and returned images per call.'),
})

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
    revisedPrompt: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { images: { type: 'array', items: IMAGE_VALUE_SCHEMA } },
  required: ['images'],
}

function imageRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
}

function renderImages(_args, value) {
  const content = [{ type: 'text', text: `Generated ${value.images.length} image${value.images.length === 1 ? '' : 's'} and saved them as durable attachments.` }]
  for (const image of value.images) {
    content.push({ type: 'image', attachment: imageRef(image) })
    if (image.revisedPrompt !== undefined) content.push({ type: 'text', text: `Revised prompt: ${image.revisedPrompt}` })
  }
  return content
}

function toolOutput() {
  return { schema: OUTPUT_SCHEMA, render: renderImages }
}

function assertCommonArgs(args, config) {
  if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
  if (args.n !== undefined && (!Number.isInteger(args.n) || args.n < 1 || args.n > config.maxImages)) throw new Error(`n must be an integer from 1 to ${config.maxImages}`)
  if (args.model !== undefined && typeof args.model !== 'string') throw new Error('model must be a string when provided')
}

function requestHeaders(config, json) {
  return {
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(config.apiKey?.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
  }
}

function requestSignal(parent, timeoutMs) {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
}

async function loadWorkspaceImage(ctx, path, exec, maxBytes, requirePng = false) {
  if (typeof path !== 'string' || path.trim().length === 0) throw new Error('image path must be a non-empty string')
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`input image not found: ${target.displayPath}`)
  if (info.type !== 'file') throw new Error(`input image is not a regular file: ${target.displayPath}`)
  if (info.size !== undefined && info.size > maxBytes) throw new Error(`input image exceeds the ${maxBytes}-byte limit: ${target.displayPath}`)
  const data = await ctx.fs.readBytes(target, exec.signal, maxBytes)
  const mediaType = sniffImageMediaType(data)
  if (mediaType === undefined) throw new Error(`input file is not a supported PNG, JPEG, WebP, or GIF image: ${target.displayPath}`)
  if (requirePng && mediaType !== 'image/png') throw new Error(`mask must be a PNG image: ${target.displayPath}`)
  return { data, mediaType, filename: basename(target.displayPath || path) || (requirePng ? 'mask.png' : 'image.png') }
}

async function saveOutputs(ctx, outputs) {
  const refs = await ctx.attachments.saveImages(outputs.map((image, index) => ({
    data: image.data,
    mediaType: image.mediaType,
    name: `generated-${index + 1}.${image.mediaType === 'image/jpeg' ? 'jpg' : image.mediaType.slice(6)}`,
  })))
  return {
    images: refs.map((ref, index) => ({
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(outputs[index].revisedPrompt === undefined ? {} : { revisedPrompt: outputs[index].revisedPrompt }),
    })),
  }
}

async function parseAndSave(ctx, response, config, exec) {
  const outputs = await parseImageAPIResponse(response, {
    fetchImpl: fetch,
    signal: requestSignal(exec.signal, config.downloadTimeoutMs),
    maxOutputImageBytes: config.maxOutputImageBytes,
    maxImages: config.maxImages,
    allowPrivateImageUrls: config.allowPrivateImageUrls,
  })
  return saveOutputs(ctx, outputs)
}

function commonProperties(maxImages) {
  return {
    prompt: { type: 'string', description: 'Detailed image instruction. Required.' },
    model: { type: 'string', description: 'Optional model override; otherwise the configured default is used.' },
    n: { type: 'integer', description: `Number of images, from 1 to ${maxImages}. Defaults to the provider default.` },
    size: { type: 'string', description: 'Optional provider-supported size such as 1024x1024.' },
    quality: { type: 'string', description: 'Optional provider-supported quality value.' },
    background: { type: 'string', description: 'Optional provider-supported background value.' },
    output_format: { type: 'string', description: 'Optional provider-supported output format such as png, jpeg, or webp.' },
  }
}

function setResponseFormat(config, target) {
  if (config.responseFormat === 'auto') return
  if (target instanceof FormData) target.set('response_format', config.responseFormat)
  else target.response_format = config.responseFormat
}

function registerGenerateTool(ctx, config) {
  ctx.tools.register({
    name: 'generate_image',
    description: 'Generate images from a text prompt through the configured OpenAI-compatible Images API. The generated images are returned as durable image attachments.',
    parameters: { type: 'object', additionalProperties: false, properties: commonProperties(config.maxImages), required: ['prompt'] },
    output: toolOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertCommonArgs(args, config)
      const body = { model: args.model?.trim() || config.model, prompt: args.prompt, ...optionalImageFields(args) }
      setResponseFormat(config, body)
      const response = await fetch(endpointURL(config.baseURL, config.generationPath), {
        method: 'POST',
        headers: requestHeaders(config, true),
        body: JSON.stringify(body),
        signal: requestSignal(exec.signal, config.timeoutMs),
      })
      return parseAndSave(ctx, response, config, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Generate image: ${args.prompt}`, kind: 'other', rawInput: args }
    },
  })
}

function registerEditTool(ctx, config) {
  ctx.tools.register({
    name: 'edit_image',
    description: 'Create or edit an image from one or more workspace image files through the configured OpenAI-compatible Images Edit API. Use image_paths in reference order; an optional PNG mask controls the editable area.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...commonProperties(config.maxImages),
        image_paths: { type: 'array', items: { type: 'string' }, description: `One to ${config.maxImages} workspace image paths. Their order is preserved.` },
        mask_path: { type: 'string', description: 'Optional workspace path to a PNG mask.' },
      },
      required: ['prompt', 'image_paths'],
    },
    output: toolOutput(),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertCommonArgs(args, config)
      if (!Array.isArray(args.image_paths) || args.image_paths.length < 1 || args.image_paths.length > config.maxImages) throw new Error(`image_paths must contain from 1 to ${config.maxImages} paths`)
      const images = []
      for (const path of args.image_paths) images.push(await loadWorkspaceImage(ctx, path, exec, config.maxInputImageBytes))
      const mask = args.mask_path === undefined ? undefined : await loadWorkspaceImage(ctx, args.mask_path, exec, config.maxInputImageBytes, true)
      const form = new FormData()
      form.set('model', args.model?.trim() || config.model)
      form.set('prompt', args.prompt)
      for (const [key, value] of Object.entries(optionalImageFields(args))) form.set(key, String(value))
      setResponseFormat(config, form)
      for (const image of images) form.append(config.imageField, new Blob([image.data], { type: image.mediaType }), image.filename)
      if (mask !== undefined) form.set('mask', new Blob([mask.data], { type: mask.mediaType }), mask.filename)
      const response = await fetch(endpointURL(config.baseURL, config.editPath), {
        method: 'POST',
        headers: requestHeaders(config, false),
        body: form,
        signal: requestSignal(exec.signal, config.timeoutMs),
      })
      return parseAndSave(ctx, response, config, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Edit image: ${args.prompt}`, kind: 'other', rawInput: { prompt: args.prompt, image_paths: args.image_paths, mask_path: args.mask_path } }
    },
  })
}

function resolveConfig(config) {
  const read = value => value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  const text = (value, fallback) => typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  const integer = (value, fallback, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= 1 && value <= max ? value : fallback
  const baseURL = read(config.baseURL)
  const apiKey = read(config.apiKey)
  const model = read(config.model)
  const generationPath = read(config.generationPath)
  const editPath = read(config.editPath)
  const responseFormat = read(config.responseFormat)
  const imageField = read(config.imageField)
  const timeoutMs = read(config.timeoutMs)
  const downloadTimeoutMs = read(config.downloadTimeoutMs)
  const allowPrivateImageUrls = read(config.allowPrivateImageUrls)
  const maxInputImageBytes = read(config.maxInputImageBytes)
  const maxOutputImageBytes = read(config.maxOutputImageBytes)
  const maxImages = read(config.maxImages)
  return {
    baseURL: text(baseURL, 'https://api.openai.com/v1'),
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    model: text(model, 'gpt-image-1'),
    generationPath: text(generationPath, '/images/generations'),
    editPath: text(editPath, '/images/edits'),
    responseFormat: ['auto', 'b64_json', 'url'].includes(responseFormat) ? responseFormat : 'auto',
    imageField: ['image', 'image[]'].includes(imageField) ? imageField : 'image',
    timeoutMs: integer(timeoutMs, 120_000, MAX_TIMER_MS),
    downloadTimeoutMs: integer(downloadTimeoutMs, 30_000, MAX_TIMER_MS),
    allowPrivateImageUrls: allowPrivateImageUrls === true,
    maxInputImageBytes: integer(maxInputImageBytes, 20 * 1024 * 1024),
    maxOutputImageBytes: integer(maxOutputImageBytes, 25 * 1024 * 1024),
    maxImages: integer(maxImages, 4, 16),
  }
}

export function apply(ctx, config) {
  const current = new Proxy({}, {
    get(_target, property) {
      return resolveConfig(config)[property]
    },
  })
  registerGenerateTool(ctx, current)
  registerEditTool(ctx, current)
}
