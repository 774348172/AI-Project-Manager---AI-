const crypto = require('crypto');
const WebSocket = require('ws');
const { getSpeechConfig } = require('./config-service');

const MAX_AUDIO_BYTES = 1024 * 1024;
const XUNFEI_HOST = 'iat-api.xfyun.cn';
const XUNFEI_PATH = '/v2/iat';
const XUNFEI_WS_URL = `wss://${XUNFEI_HOST}${XUNFEI_PATH}`;
const XUNFEI_CHUNK_BYTES = 1280;
const XUNFEI_TIMEOUT_MS = 30000;

function publicError(message, code = 'VALIDATION_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function readString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function decodeAudioBase64(audioBase64) {
  const normalized = readString(audioBase64);
  if (!normalized) {
    throw publicError('audioBase64 is required.');
  }
  let audio;
  try {
    audio = Buffer.from(normalized, 'base64');
  } catch (error) {
    throw publicError('audioBase64 must be valid base64.');
  }
  if (audio.length === 0) {
    throw publicError('audioBase64 must contain audio data.');
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    throw publicError('Audio payload is too large.', 'AUDIO_TOO_LARGE', 413);
  }
  return audio;
}

function hasXunfeiCredentials(config = {}) {
  return Boolean(config.xunfei && config.xunfei.appId && config.xunfei.apiKey && config.xunfei.apiSecret);
}

function createXunfeiUrl({ apiKey, apiSecret }) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${XUNFEI_HOST}\ndate: ${date}\nGET ${XUNFEI_PATH} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `${XUNFEI_WS_URL}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(XUNFEI_HOST)}`;
}

function parseXunfeiText(payload) {
  const result = payload && payload.data && payload.data.result;
  const words = result && Array.isArray(result.ws) ? result.ws : [];
  return words.map((word) => Array.isArray(word.cw) && word.cw[0] ? word.cw[0].w || '' : '').join('');
}

function buildXunfeiFrame({ appId, audio, offset, status }) {
  const frame = {
    data: {
      status,
      format: 'audio/L16;rate=16000',
      encoding: 'raw',
      audio: audio.toString('base64')
    }
  };
  if (status === 0) {
    frame.common = { app_id: appId };
    frame.business = {
      language: 'zh_cn',
      domain: 'iat',
      accent: 'mandarin',
      vad_eos: 5000,
      dwa: 'wpgs'
    };
  }
  return frame;
}

function sendXunfeiAudio(ws, appId, audio) {
  if (audio.length === 0) {
    ws.send(JSON.stringify(buildXunfeiFrame({ appId, audio, offset: 0, status: 2 })));
    return;
  }

  for (let offset = 0; offset < audio.length; offset += XUNFEI_CHUNK_BYTES) {
    const chunk = audio.subarray(offset, Math.min(audio.length, offset + XUNFEI_CHUNK_BYTES));
    const isFirst = offset === 0;
    const isLast = offset + XUNFEI_CHUNK_BYTES >= audio.length;
    ws.send(JSON.stringify(buildXunfeiFrame({ appId, audio: chunk, offset, status: isFirst ? 0 : isLast ? 2 : 1 })));
  }
}

function transcribeWithXunfei(audio, config) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(createXunfeiUrl(config.xunfei));
    const segments = new Map();
    const timer = setTimeout(() => {
      ws.close();
      reject(publicError('讯飞语音识别超时，请稍后重试。', 'XUNFEI_TIMEOUT', 504));
    }, XUNFEI_TIMEOUT_MS);

    ws.on('open', () => {
      sendXunfeiAudio(ws, config.xunfei.appId, audio);
    });

    ws.on('message', (message) => {
      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch (error) {
        clearTimeout(timer);
        ws.close();
        reject(publicError('讯飞语音识别返回了无效响应。', 'XUNFEI_INVALID_RESPONSE', 502));
        return;
      }

      if (payload.code !== 0) {
        clearTimeout(timer);
        ws.close();
        reject(publicError(payload.message || '讯飞语音识别失败。', 'XUNFEI_API_ERROR', 502));
        return;
      }

      const result = payload.data && payload.data.result;
      if (result) {
        const text = parseXunfeiText(payload);
        const key = Number.isInteger(result.sn) ? result.sn : segments.size;
        if (result.pgs === 'rpl' && Array.isArray(result.rg)) {
          for (let index = result.rg[0]; index <= result.rg[1]; index += 1) {
            segments.delete(index);
          }
        }
        segments.set(key, text);
      }

      if (payload.data && payload.data.status === 2) {
        clearTimeout(timer);
        ws.close();
        resolve(Array.from(segments.entries()).sort((a, b) => a[0] - b[0]).map((item) => item[1]).join('').trim());
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(publicError(`讯飞语音识别连接失败：${error.message}`, 'XUNFEI_CONNECTION_ERROR', 502));
    });
  });
}

async function transcribeSpeech(input = {}, options = {}) {
  const format = readString(input.format) || 'pcm';
  if (format !== 'pcm') {
    throw publicError('Only pcm audio is supported.');
  }

  const sampleRate = Number(input.sampleRate) || 16000;
  if (sampleRate !== 16000) {
    throw publicError('sampleRate must be 16000.');
  }

  const audio = decodeAudioBase64(input.audioBase64);
  const config = await getSpeechConfig(options);
  const durationMs = Number(input.durationMs) > 0 ? Math.round(Number(input.durationMs)) : null;

  if (config.provider !== 'xunfei' || !hasXunfeiCredentials(config)) {
    return {
      text: '语音识别占位：服务端已收到音频，后续接入讯飞后会返回真实识别结果。',
      provider: 'xunfei_placeholder',
      format,
      sampleRate,
      audioBytes: audio.length,
      durationMs
    };
  }

  const text = await transcribeWithXunfei(audio, config);
  return {
    text,
    provider: 'xunfei',
    format,
    sampleRate,
    audioBytes: audio.length,
    durationMs
  };
}

module.exports = {
  MAX_AUDIO_BYTES,
  transcribeSpeech
};
