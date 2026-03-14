/**
 * Audio transcription using Groq's Whisper API.
 * Transcribes voice notes and audio files to text.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

let groqToken: string | null = null;

function getGroqToken(): string | null {
  if (groqToken !== null) return groqToken || null;
  const tokenPath = path.join(DATA_DIR, 'groq-token');
  try {
    groqToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    return groqToken;
  } catch {
    groqToken = '';
    return null;
  }
}

/**
 * Check if transcription is available (Groq token configured).
 */
export function isTranscriptionAvailable(): boolean {
  return !!getGroqToken();
}

/**
 * Transcribe an audio file using Groq's Whisper API.
 * Returns the transcribed text, or null on failure.
 */
export async function transcribeAudio(filePath: string): Promise<string | null> {
  const token = getGroqToken();
  if (!token) {
    logger.debug('Groq token not configured, skipping transcription');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, 'Audio file not found for transcription');
    return null;
  }

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    // Build multipart form data manually using the Blob/File API (Node 22+)
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('model', WHISPER_MODEL);

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn(
        { status: response.status, error: errorText, filePath },
        'Groq transcription API error',
      );
      return null;
    }

    const result = await response.json() as { text?: string };
    const text = result.text?.trim();

    if (text) {
      logger.info(
        { filePath, textLength: text.length },
        'Audio transcribed successfully',
      );
    }

    return text || null;
  } catch (err) {
    logger.warn(
      { err, filePath },
      'Failed to transcribe audio',
    );
    return null;
  }
}
