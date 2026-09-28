import { describe, expect, it, vi } from 'vitest'
import {
  KiroManagementHttpError,
  listAvailableModels,
  parseManagementCache,
  resetKiroProfileArnCache,
  resolveKiroProfileArn,
  fetchKiroModelCatalog,
} from '../src/management.ts'

const auth = { accessToken: 'token', region: 'us-east-1' }

describe('llm-kiro management', () => {
  it('resolves the profile ARN with caching and concurrent coalescing', async () => {
    resetKiroProfileArnCache()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/p1' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await resolveKiroProfileArn(auth)
    const second = await resolveKiroProfileArn(auth)
    expect(first).toBe('arn:aws:codewhisperer:us-east-1:123:profile/p1')
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://management.us-east-1.kiro.dev/List-Available-Profiles')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token')
  })

  it('coalesces concurrent profile lookups', async () => {
    resetKiroProfileArnCache()
    let release: (value: Response) => void
    const gate = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(() => gate))
    const pending = [resolveKiroProfileArn(auth), resolveKiroProfileArn(auth)]
    release!(new Response(JSON.stringify({ profiles: [{ arn: 'arn:1' }] }), { status: 200 }))
    const [a, b] = await Promise.all(pending)
    expect(a).toBe('arn:1')
    expect(b).toBe('arn:1')
  })

  it('honors a provided profile ARN without a network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await resolveKiroProfileArn(auth, 'arn:provided')).toBe('arn:provided')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails loud on management HTTP errors and invalid responses', async () => {
    resetKiroProfileArnCache()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })))
    await expect(resolveKiroProfileArn(auth)).rejects.toThrow(KiroManagementHttpError)
    await expect(resolveKiroProfileArn(auth)).rejects.toMatchObject({ status: 403 })

    resetKiroProfileArnCache()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ profiles: [] }), { status: 200 })))
    await expect(resolveKiroProfileArn(auth)).rejects.toThrow('no profile')

    resetKiroProfileArnCache()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(resolveKiroProfileArn(auth)).rejects.toThrow('invalid JSON')
  })

  it('lists available models with query parameters and validates the catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      models: [{ modelId: 'glm-5' }],
    }), { status: 200 })))
    const response = await listAvailableModels(auth, 'arn:1')
    expect(response.models[0].modelId).toBe('glm-5')
    const [url] = vi.mocked(fetch).mock.calls[0] as [string]
    expect(url).toContain('List-Available-Models')
    expect(url).toContain('origin=KIRO_CLI')
    expect(url).toContain('profileArn=arn%3A1')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })))
    await expect(listAvailableModels(auth, 'arn:1')).rejects.toThrow('no models')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{ modelId: 7 }] }), { status: 200 })))
    await expect(listAvailableModels(auth, 'arn:1')).rejects.toThrow('invalid catalog')
  })

  it('fetchKiroModelCatalog resolves the profile first', async () => {
    resetKiroProfileArnCache()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('List-Available-Profiles')) {
        return new Response(JSON.stringify({ profiles: [{ arn: 'arn:1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: [{ modelId: 'glm-5' }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const response = await fetchKiroModelCatalog(auth)
    expect(response.models).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('wraps transport failures with the operation name', async () => {
    resetKiroProfileArnCache()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('ECONNREFUSED') }))
    await expect(resolveKiroProfileArn(auth)).rejects.toThrow('ListAvailableProfiles request failed')
  })

  it('normalises a shared version-1 cache document onto the raw catalog shape', () => {
    const cache = parseManagementCache(JSON.stringify({
      version: 1,
      source: 'kiro-management',
      regions: {
        'eu-central-1': {
          region: 'eu-central-1',
          fetchedAt: 1,
          models: [{
            id: 'claude-opus-5-5',
            kiroModelId: 'claude-opus-5.5',
            name: 'Claude Opus 5.5',
            contextWindow: 1000000,
            maxTokens: 128000,
          }],
        },
      },
    }))
    expect(cache?.version).toBe(2)
    expect(cache?.regions['eu-central-1']?.models[0]).toEqual({
      modelId: 'claude-opus-5.5',
      displayName: 'Claude Opus 5.5',
      tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 },
    })
  })

  it('rejects unreadable cache versions and records without a model id', () => {
    expect(parseManagementCache(JSON.stringify({
      version: 9,
      source: 'kiro-management',
      regions: {},
    }))).toBeUndefined()
    expect(parseManagementCache(JSON.stringify({
      version: 1,
      source: 'kiro-management',
      regions: { r: { region: 'r', fetchedAt: 1, models: [{ name: 'no id' }] } },
    }))).toBeUndefined()
    expect(parseManagementCache(JSON.stringify({
      version: 2,
      source: 'other-tool',
      regions: {},
    }))).toBeUndefined()
  })
})
