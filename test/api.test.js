import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeImageBase64, endpointURL, parseImageAPIResponse, sniffImageMediaType } from '../api.js'

const tinyPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

test('joins an endpoint under the configured API root', () => {
  assert.equal(endpointURL('https://api.openai.com/v1', '/images/generations'), 'https://api.openai.com/v1/images/generations')
})

test('decodes and identifies base64 image output', () => {
  const encoded = Buffer.from(tinyPng).toString('base64')
  const decoded = decodeImageBase64(encoded, 1024)
  assert.equal(sniffImageMediaType(decoded), 'image/png')
})

test('parses b64_json image responses', async () => {
  const response = new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(tinyPng).toString('base64'), revised_prompt: 'refined' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const images = await parseImageAPIResponse(response, {
    fetchImpl: fetch,
    signal: AbortSignal.timeout(1000),
    maxOutputImageBytes: 1024,
    maxImages: 1,
  })
  assert.equal(images.length, 1)
  assert.equal(images[0].mediaType, 'image/png')
  assert.equal(images[0].revisedPrompt, 'refined')
})

test('downloads url responses and validates redirect targets', async () => {
  const response = new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/image.png' }] }), { status: 200 })
  const requested = []
  const images = await parseImageAPIResponse(response, {
    fetchImpl: async url => {
      requested.push(String(url))
      return new Response(tinyPng, { status: 200, headers: { 'content-type': 'image/png' } })
    },
    signal: AbortSignal.timeout(1000),
    maxOutputImageBytes: 1024,
    maxImages: 1,
    allowPrivateImageUrls: false,
  })
  assert.deepEqual(requested, ['https://cdn.example/image.png'])
  assert.equal(images[0].mediaType, 'image/png')
})

test('surfaces provider error details without request bodies', async () => {
  const response = new Response(JSON.stringify({ error: { message: 'bad prompt', code: 'invalid_prompt' } }), {
    status: 400,
    headers: { 'x-request-id': 'req_test' },
  })
  await assert.rejects(() => parseImageAPIResponse(response, {
    fetchImpl: fetch,
    signal: AbortSignal.timeout(1000),
    maxOutputImageBytes: 1024,
    maxImages: 1,
  }), /HTTP 400: bad prompt; code=invalid_prompt; request-id=req_test/u)
})
