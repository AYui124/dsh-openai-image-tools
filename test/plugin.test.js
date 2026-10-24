import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const tinyPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])
const encodedPng = Buffer.from(tinyPng).toString('base64')

function config(overrides = {}) {
  return {
    baseURL: 'https://images.example/v1',
    apiKey: 'secret-key',
    model: 'test-image-model',
    generationPath: '/images/generations',
    editPath: '/images/edits',
    responseFormat: 'auto',
    imageField: 'image',
    timeoutMs: 10_000,
    downloadTimeoutMs: 10_000,
    allowPrivateImageUrls: false,
    maxInputImageBytes: 1024,
    maxOutputImageBytes: 1024,
    maxImages: 4,
    ...overrides,
  }
}

function harness() {
  const definitions = new Map()
  return {
    definitions,
    ctx: {
      tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
      attachments: {
        async saveImages(images) {
          return images.map((image, index) => ({
            attachmentId: `sha256:${String(index).padStart(64, '0')}`,
            mediaType: image.mediaType,
            bytes: image.data.byteLength,
            width: 1,
            height: 1,
            name: image.name,
          }))
        },
      },
      workingDirectory: { async ensure() { return '/workspace' } },
      fs: {
        async resolve(path) { return { displayPath: `/workspace/${path}` } },
        async stat() { return { type: 'file', size: tinyPng.byteLength } },
        async readBytes() { return tinyPng },
      },
    },
  }
}

const exec = { signal: AbortSignal.timeout(10_000), agent: { id: 'test' } }

test('registers and executes text-to-image with JSON protocol', { concurrency: false }, async () => {
  const { ctx, definitions } = harness()
  const liveValues = config()
  const volatileConfig = Object.fromEntries(Object.keys(liveValues).map(key => [key, { get: () => liveValues[key] }]))
  apply(ctx, volatileConfig)
  liveValues.baseURL = 'https://updated-images.example/v1'
  liveValues.model = 'updated-image-model'
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ data: [{ b64_json: encodedPng }] }), { status: 200 })
  }
  try {
    const result = await definitions.get('generate_image').execute({ prompt: 'a blue fox', model: '', n: 1, size: '', quality: '', background: '', output_format: '' }, exec)
    assert.equal(captured.url, 'https://updated-images.example/v1/images/generations')
    assert.equal(captured.init.headers.Authorization, 'Bearer secret-key')
    assert.deepEqual(JSON.parse(captured.init.body), { model: 'updated-image-model', prompt: 'a blue fox', n: 1 })
    assert.equal(result.images[0].mediaType, 'image/png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('executes image edit with multipart protocol', { concurrency: false }, async () => {
  const { ctx, definitions } = harness()
  apply(ctx, config({ imageField: 'image[]', responseFormat: 'b64_json' }))
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ data: [{ b64_json: encodedPng }] }), { status: 200 })
  }
  try {
    await definitions.get('edit_image').execute({ prompt: 'make it cyan', image_paths: ['source.png'], mask_path: 'mask.png' }, exec)
    assert.equal(captured.url, 'https://images.example/v1/images/edits')
    assert.equal(captured.init.headers['Content-Type'], undefined)
    assert.equal(captured.init.body.get('model'), 'test-image-model')
    assert.equal(captured.init.body.get('response_format'), 'b64_json')
    assert.equal(captured.init.body.getAll('image[]').length, 1)
    assert.equal(captured.init.body.get('mask').type, 'image/png')
  } finally {
    globalThis.fetch = originalFetch
  }
})
