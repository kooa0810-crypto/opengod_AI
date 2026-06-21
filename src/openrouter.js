import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { db } from './database.js';

dotenv.config();

// Initialize OpenRouter Client
const openRouterClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || '',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/aiden/opengod', // Optional site URL
    'X-Title': 'OpenGod Agent',                       // Optional site name
  }
});

// Initialize Local LLM Client
const localClient = new OpenAI({
  apiKey: 'ollama', // Ollama doesn't require a key
  baseURL: process.env.LOCAL_API_URL || 'http://localhost:11434/v1',
});

/**
 * Downloads an image from a URL and converts it to a base64 Data URL.
 * Necessary for local vision models that cannot download from external URLs directly.
 */
export async function getBase64DataUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.error(`Error downloading image from ${url}:`, error);
    throw error;
  }
}

/**
 * Generates chat completion using either OpenRouter or the Local LLM client.
 * Handles automatic fallback or user preferences.
 */
export async function generateChatCompletion(messages, options = {}) {
  const useLocal = options.useLocal ?? (process.env.USE_LOCAL_LLM === 'true');
  const hasImages = messages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(item => item.type === 'image_url')
  );

  let client = openRouterClient;
  const dbModel = await db.getSetting('model', null);
  let model = options.model || dbModel || process.env.OPENROUTER_MODEL || 'nousresearch/hermes-3-llama-3.1-405b';

  if (useLocal) {
    client = localClient;
    model = hasImages
      ? (process.env.LOCAL_VISION_MODEL || 'llava')
      : (process.env.LOCAL_MODEL || 'llama3');
  }

  // Double check credentials for OpenRouter
  if (!useLocal && !process.env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key is missing. Please configure OPENROUTER_API_KEY in your .env file, or set USE_LOCAL_LLM=true.');
  }

  console.log(`[LLM] Calling model "${model}" (${useLocal ? 'Localhost' : 'OpenRouter'})...`);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens || 4096,
      response_format: options.responseFormat, // e.g. { type: "json_object" }
    });

    return {
      text: completion.choices[0]?.message?.content || '',
      model: completion.model || model,
      usage: completion.usage || null,
    };
  } catch (error) {
    console.error(`LLM completion error using ${useLocal ? 'local' : 'OpenRouter'} model:`, error);
    throw error;
  }
}
