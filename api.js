const IMAGE_SIGNATURES = [
  { mediaType: 'image/png', test: data => matches(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mediaType: 'image/jpeg', test: data => matches(data, 0, [0xff, 0xd8, 0xff]) },
  { mediaType: 'image/gif', test: data => ascii(data, 0, 'GIF87a') || ascii(data, 0, 'GIF89a') },
  { mediaType: 'image/webp', test: data => ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP') },
]

function matches(data, offset, expected) {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function ascii(data, offset, value) {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

export function sniffImageMediaType(data) {
  return IMAGE_SIGNATURES.find(item => item.test(data))?.mediaType
}

export function endpointURL(baseURL, path) {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`
  return new URL(path.replace(/^\/+/, ''), base).toString()
}

export function decodeImageBase64(value, maxBytes) {
  const source = value.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '').replace(/\s+/gu, '')
  if (source.length === 0 || source.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/iu.test(source)) {
    throw new Error('Provider returned invalid base64 image data.')
  }
  const data = new Uint8Array(Buffer.from(source, 'base64'))
  if (data.byteLength === 0) throw new Error('Provider returned an empty image.')
  if (data.byteLength > maxBytes) throw new Error(`Provider image exceeds the ${maxBytes}-byte output limit.`)
  return data
}

export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response exceeds the ${maxBytes}-byte limit.`)
  }
  if (response.body === null) return new Uint8Array()
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    total += data.byteLength
    if (total > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`)
    chunks.push(data)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function safeErrorJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function providerError(response, text) {
  const payload = safeErrorJSON(text)
  const error = payload?.error
  const details = [
    error?.message,
    error?.type && `type=${error.type}`,
    error?.code && `code=${error.code}`,
    error?.param && `param=${error.param}`,
  ].filter(Boolean).join('; ')
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
  const suffix = requestId ? `; request-id=${requestId}` : ''
  return new Error(`Image API request failed with HTTP ${response.status}${details ? `: ${details}` : ''}${suffix}`)
}

function rejectUnsafeDownloadURL(value, allowPrivateImageUrls) {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Provider image URL must use HTTP or HTTPS.')
  if (allowPrivateImageUrls) return url
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host) || /^172\.(1[6-9]|2\d|3[01])\./u.test(host)) {
    throw new Error('Provider image URL points to a local or private address and was refused.')
  }
  return url
}

async function downloadImage(urlValue, options) {
  let url = rejectUnsafeDownloadURL(urlValue, options.allowPrivateImageUrls)
  let response
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await options.fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: options.signal,
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
    })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    if (location === null) throw new Error('Provider image download redirect has no location header.')
    if (redirects === 5) throw new Error('Provider image download exceeded 5 redirects.')
    url = rejectUnsafeDownloadURL(new URL(location, url), options.allowPrivateImageUrls)
  }
  if (!response.ok) throw new Error(`Provider image download failed with HTTP ${response.status}.`)
  const data = await readBoundedBody(response, options.maxOutputImageBytes)
  const mediaType = sniffImageMediaType(data)
  if (mediaType === undefined) throw new Error('Downloaded provider output is not a supported PNG, JPEG, WebP, or GIF image.')
  return { data, mediaType }
}

export async function parseImageAPIResponse(response, options) {
  const maxJsonBytes = Math.max(options.maxOutputImageBytes * Math.max(options.maxImages, 1) * 2, 1024 * 1024)
  const bytes = await readBoundedBody(response, maxJsonBytes)
  const text = new TextDecoder().decode(bytes)
  if (!response.ok) throw providerError(response, text)
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    throw new Error('Image API returned a non-JSON success response.', { cause: error })
  }
  if (!Array.isArray(payload?.data) || payload.data.length === 0) {
    throw new Error('Image API success response does not contain a non-empty data array.')
  }
  if (payload.data.length > options.maxImages) {
    throw new Error(`Image API returned ${payload.data.length} images, exceeding the configured limit of ${options.maxImages}.`)
  }
  const images = []
  for (const item of payload.data) {
    let image
    if (typeof item?.b64_json === 'string') {
      const data = decodeImageBase64(item.b64_json, options.maxOutputImageBytes)
      const mediaType = sniffImageMediaType(data)
      if (mediaType === undefined) throw new Error('Decoded provider output is not a supported PNG, JPEG, WebP, or GIF image.')
      image = { data, mediaType }
    } else if (typeof item?.url === 'string') {
      image = await downloadImage(item.url, options)
    } else {
      throw new Error('Image API data item contains neither b64_json nor url.')
    }
    images.push({
      ...image,
      ...(typeof item.revised_prompt === 'string' ? { revisedPrompt: item.revised_prompt } : {}),
    })
  }
  return images
}

export function optionalImageFields(args) {
  const fields = {}
  for (const key of ['size', 'quality', 'background', 'output_format']) {
    if (typeof args[key] === 'string' && args[key].length > 0) fields[key] = args[key]
  }
  if (Number.isInteger(args.n)) fields.n = args.n
  return fields
}
