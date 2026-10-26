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
  const records = new Map()
  const followups = []
  const injections = []
  const agent = {
    id: 'test',
    status: 'idle',
    followup(message) { followups.push(message) },
    inject(message) { injections.push(message) },
  }
  let nextJob = 1
  const jobs = {
    start(spec) {
      const id = `image-test-${nextJob++}`
      const progress = []
      const hooks = spec.run({ id, append() {}, updateProgress(line) { progress.push(line) } })
      const done = hooks.done.then(outcome => {
        const record = records.get(id)
        record.status = outcome.status
        record.outcome = outcome
        return outcome
      })
      records.set(id, { id, spec, hooks, done, progress, status: 'running' })
      return id
    },
    wait(id) {
      const record = records.get(id)
      return record.done.then(outcome => ({ id, kind: 'image', label: record.spec.label, owner: agent.id, status: outcome.status, startedAt: 1, finishedAt: 2 }))
    },
  }
  return {
    definitions,
    records,
    followups,
    injections,
    agent,
    ctx: {
      tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
      jobs,
      agents: { get(id) { return id === agent.id ? agent : undefined } },
      logger: { warn() {} },
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

function execution(agent) {
  return { signal: AbortSignal.timeout(10_000), agent, callId: 'call-1', rootCallId: 'call-1' }
}

test('registers and executes text-to-image with JSON protocol', { concurrency: false }, async () => {
  const { ctx, definitions, agent } = harness()
  const liveValues = config()
  const volatileConfig = Object.fromEntries(Object.keys(liveValues).map(key => [key, { get: () => liveValues[key] }]))
  apply(ctx, volatileConfig)
  assert.deepEqual(definitions.get('generate_image').snowlumaCapability, {
    label: '生成图片', description: '根据文字描述生成图片。', sourceKind: 'plugin',
    sourceLabel: '插件 dsh-openai-image-tools', sourcePackage: '@ayui124/dsh-openai-image-tools',
    risk: 'medium', riskReason: '会调用可能计费的图片服务；QQ 每次只投递一张结果图片。',
  })
  assert.equal(definitions.get('edit_image').snowlumaCapability.sourcePackage, '@ayui124/dsh-openai-image-tools')
  liveValues.baseURL = 'https://updated-images.example/v1'
  liveValues.model = 'updated-image-model'
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ data: [{ b64_json: encodedPng }] }), { status: 200 })
  }
  try {
    const result = await definitions.get('generate_image').execute({ prompt: 'a blue fox', model: '', n: 1, size: '', quality: '', background: '', output_format: '' }, execution(agent))
    assert.equal(captured.url, 'https://updated-images.example/v1/images/generations')
    assert.equal(captured.init.headers.Authorization, 'Bearer secret-key')
    assert.deepEqual(JSON.parse(captured.init.body), { model: 'updated-image-model', prompt: 'a blue fox', n: 1 })
    assert.equal(result.images[0].mediaType, 'image/png')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('executes image edit with multipart protocol', { concurrency: false }, async () => {
  const { ctx, definitions, agent } = harness()
  apply(ctx, config({ imageField: 'image[]', responseFormat: 'b64_json' }))
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ data: [{ b64_json: encodedPng }] }), { status: 200 })
  }
  try {
    await definitions.get('edit_image').execute({ prompt: 'make it cyan', image_paths: ['source.png'], mask_path: 'mask.png' }, execution(agent))
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

test('starts an async image job immediately and appends its image to the originating conversation', { concurrency: false }, async () => {
  const { ctx, definitions, agent, records, followups, injections } = harness()
  const liveValues = config()
  const volatileConfig = Object.fromEntries(Object.keys(liveValues).map(key => [key, { get: () => liveValues[key] }]))
  apply(ctx, volatileConfig)
  assert.equal(definitions.get('generate_image_async').snowlumaCapability.sourcePackage, '@ayui124/dsh-openai-image-tools')
  assert.equal(definitions.get('edit_image_async').snowlumaCapability.sourcePackage, '@ayui124/dsh-openai-image-tools')
  const originalFetch = globalThis.fetch
  let finishFetch
  let captured
  globalThis.fetch = (url, init) => {
    captured = { url: String(url), init }
    return new Promise(resolve => { finishFetch = resolve })
  }
  try {
    const receipt = await definitions.get('generate_image_async').execute({ prompt: 'a patient red panda', n: 1 }, execution(agent))
    assert.deepEqual(receipt, { job_id: 'image-test-1', status: 'running' })
    assert.equal(records.get(receipt.job_id).status, 'running')
    assert.equal(followups.length, 0)
    liveValues.baseURL = 'https://changed.example/v1'
    liveValues.model = 'changed-model'
    finishFetch(new Response(JSON.stringify({ data: [{ b64_json: encodedPng }] }), { status: 200 }))
    const outcome = await records.get(receipt.job_id).done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(outcome.status, 'completed')
    assert.equal(captured.url, 'https://images.example/v1/images/generations')
    assert.deepEqual(JSON.parse(captured.init.body), { model: 'test-image-model', prompt: 'a patient red panda', n: 1 })
    assert.equal(followups.length, 1)
    assert.equal(injections.length, 0)
    assert.equal(followups[0].role, 'user')
    assert.equal(followups[0].content[1].type, 'image')
    assert.match(outcome.result, /sha256:/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reports async provider failures back to the originating conversation', { concurrency: false }, async () => {
  const { ctx, definitions, agent, records, followups } = harness()
  apply(ctx, config())
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'gateway timeout' } }), { status: 504 })
  try {
    const receipt = await definitions.get('generate_image_async').execute({ prompt: 'a slow landscape' }, execution(agent))
    const outcome = await records.get(receipt.job_id).done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.detail, /HTTP 504/u)
    assert.equal(followups.length, 1)
    assert.match(followups[0].content[0].text, /failed.*HTTP 504/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('settles a cancelled async image job without appending a result', { concurrency: false }, async () => {
  const { ctx, definitions, agent, records, followups, injections } = harness()
  apply(ctx, config())
  const originalFetch = globalThis.fetch
  globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  try {
    const receipt = await definitions.get('generate_image_async').execute({ prompt: 'cancel me' }, execution(agent))
    records.get(receipt.job_id).hooks.cancel('no longer needed')
    const outcome = await records.get(receipt.job_id).done
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(outcome.status, 'killed')
    assert.match(outcome.detail, /no longer needed/u)
    assert.equal(followups.length, 0)
    assert.equal(injections.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects async generation without an owning agent', async () => {
  const { ctx, definitions } = harness()
  apply(ctx, config())
  await assert.rejects(
    definitions.get('generate_image_async').execute({ prompt: 'orphan image' }, { signal: AbortSignal.timeout(1000), callId: 'call-orphan', rootCallId: 'call-orphan' }),
    /requires an owning Agent session/u,
  )
})
