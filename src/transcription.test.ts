import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./instance-data.js', () => ({
  readSecretFile: vi.fn(() => 'fake-groq-token'),
}));

import { transcribeAudio } from './transcription.js';
import { logger } from './logger.js';

const AUDIO_FILE = path.join(__dirname, '__test-audio.ogg');

beforeEach(() => {
  vi.clearAllMocks();
  // Create a dummy audio file
  fs.writeFileSync(AUDIO_FILE, 'fake-audio-data');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (fs.existsSync(AUDIO_FILE)) fs.unlinkSync(AUDIO_FILE);
});

describe('transcribeAudio', () => {
  it('returns null when no token is configured', async () => {
    const { readSecretFile } = await import('./instance-data.js');
    vi.mocked(readSecretFile).mockReturnValueOnce(null);

    // Clear the token cache so our mock takes effect
    const mod = await import('./transcription.js');
    // Force re-import to reset cache — use a non-cached instance name
    const result = await mod.transcribeAudio(AUDIO_FILE, 'no-token-instance');
    expect(result).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    const result = await transcribeAudio('/nonexistent/file.ogg');
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/nonexistent/file.ogg' }),
      'Audio file not found for transcription',
    );
  });

  it('returns transcribed text on success', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: ' Hello world ' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null on empty transcription text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '  ' }),
      }),
    );

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBeNull();
  });

  it('retries on 429 and succeeds', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'success after retry' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBe('success after retry');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, attempt: 0 }),
      'Groq transcription failed, retrying',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ retriesNeeded: 1 }),
      'Audio transcribed successfully',
    );
  });

  it('retries on 502 and 503', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'bad gateway',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'recovered' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_RETRIES on retryable errors', async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    vi.stubGlobal('fetch', mockFetch);

    const promise = transcribeAudio(AUDIO_FILE);
    // Advance through all retry delays (1s + 2s + 4s)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
    // 1 initial + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, attempt: 3 }),
      'Groq transcription API error',
    );
  });

  it('does not retry on non-retryable status (400)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      }),
    );

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    );

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'recovered from network error' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await transcribeAudio(AUDIO_FILE);
    expect(result).toBe('recovered from network error');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_RETRIES on network errors', async () => {
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);

    const promise = transcribeAudio(AUDIO_FILE);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await promise;
    vi.useRealTimers();

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3 }),
      'Failed to transcribe audio after retries',
    );
  });

  it('sends correct headers and form data', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'test' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await transcribeAudio(AUDIO_FILE);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer fake-groq-token');
    expect(opts.body).toBeInstanceOf(FormData);
  });
});
