/**
 * Audio transcription using Groq's Whisper API.
 * Transcribes voice notes and audio files to text.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { readSecretFile } from './instance-data.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';
const MAX_RETRIES = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// Cache tokens per instance to avoid re-reading files
const tokenCache = new Map<string, string | null>();

function getGroqToken(instanceName?: string): string | null {
  const cacheKey = instanceName ?? '__global__';
  if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey)!;
  const token = readSecretFile(instanceName, 'groq-token');
  tokenCache.set(cacheKey, token);
  return token;
}

/**
 * Transcribe an audio file using Groq's Whisper API.
 * Checks per-instance groq-token first, falls back to global.
 * Returns the transcribed text, or null on failure.
 */
export async function transcribeAudio(
  filePath: string,
  instanceName?: string,
): Promise<string | null> {
  const token = getGroqToken(instanceName);
  if (!token) {
    logger.debug('Groq token not configured, skipping transcription');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, 'Audio file not found for transcription');
    return null;
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer]), fileName);
      formData.append('model', WHISPER_MODEL);

      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (
          attempt < MAX_RETRIES &&
          RETRYABLE_STATUS_CODES.has(response.status)
        ) {
          const delay = 1000 * 2 ** attempt;
          logger.warn(
            { status: response.status, attempt, delay, filePath },
            'Groq transcription failed, retrying',
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        logger.warn(
          { status: response.status, error: errorText, filePath, attempt },
          'Groq transcription API error',
        );
        return null;
      }

      const result = (await response.json()) as { text?: string };
      const text = result.text?.trim();

      if (text) {
        logger.info(
          {
            filePath,
            textLength: text.length,
            ...(attempt > 0 ? { retriesNeeded: attempt } : {}),
          },
          'Audio transcribed successfully',
        );
      }

      return text || null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * 2 ** attempt;
        logger.warn(
          { err, attempt, delay, filePath },
          'Groq transcription failed, retrying',
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      logger.warn({ err, filePath, attempt }, 'Failed to transcribe audio after retries');
      return null;
    }
  }

  return null;
}
