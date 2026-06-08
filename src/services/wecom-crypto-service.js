const crypto = require('crypto');

function validationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(`${name} is required.`);
  }
  return value.trim();
}

function buildSignature(token, timestamp, nonce, encrypted) {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
}

function verifySignature({ token, signature, timestamp, nonce, encrypted }) {
  const expected = buildSignature(
    requireString(token, 'token'),
    requireString(timestamp, 'timestamp'),
    requireString(nonce, 'nonce'),
    requireString(encrypted, 'encrypted')
  );
  const provided = requireString(signature, 'msg_signature');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    throw validationError('企业微信回调签名校验失败。');
  }
  return true;
}

function getAesKey(encodingAESKey) {
  const key = requireString(encodingAESKey, 'encodingAESKey');
  if (key.length !== 43) {
    throw validationError('encodingAESKey must be 43 characters.');
  }
  return Buffer.from(`${key}=`, 'base64');
}

function decryptMessage(encrypted, encodingAESKey, expectedCorpId) {
  const aesKey = getAesKey(encodingAESKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(requireString(encrypted, 'encrypted'), 'base64'),
    decipher.final()
  ]);
  const pad = decrypted[decrypted.length - 1];
  if (pad < 1 || pad > 32) {
    throw validationError('企业微信回调解密失败。');
  }
  const plain = decrypted.subarray(0, decrypted.length - pad);
  const messageLength = plain.readUInt32BE(16);
  const xml = plain.subarray(20, 20 + messageLength).toString('utf8');
  const corpId = plain.subarray(20 + messageLength).toString('utf8');
  if (expectedCorpId && corpId !== expectedCorpId) {
    throw validationError('企业微信回调 CorpId 不匹配。');
  }
  return xml;
}

function encryptMessage(xml, encodingAESKey, corpId, randomBytes = crypto.randomBytes) {
  const aesKey = getAesKey(encodingAESKey);
  const xmlBuffer = Buffer.from(requireString(xml, 'xml'), 'utf8');
  const corpIdBuffer = Buffer.from(requireString(corpId, 'corpId'), 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(xmlBuffer.length, 0);
  const raw = Buffer.concat([randomBytes(16), lengthBuffer, xmlBuffer, corpIdBuffer]);
  const rawRemainder = raw.length % 32;
  const padLength = rawRemainder === 0 ? 32 : 32 - rawRemainder;
  const padding = Buffer.alloc(padLength, padLength);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, padding])), cipher.final()]).toString('base64');
}

function decodeXmlValue(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseXml(xml) {
  const text = requireString(xml, 'xml');
  const result = {};
  const pattern = /<([A-Za-z0-9_]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/\1>/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[2] !== undefined ? match[2] : decodeXmlValue(match[3] || '');
    result[match[1]] = value;
  }
  return result;
}

function extractEncryptFromXml(xml) {
  const parsed = parseXml(xml);
  return requireString(parsed.Encrypt, 'Encrypt');
}

function decryptCallbackPayload({ token, encodingAESKey, corpId, signature, timestamp, nonce, encryptedXml, encrypted }) {
  const encryptedText = encrypted || extractEncryptFromXml(encryptedXml);
  verifySignature({ token, signature, timestamp, nonce, encrypted: encryptedText });
  return decryptMessage(encryptedText, encodingAESKey, corpId);
}

module.exports = {
  buildSignature,
  verifySignature,
  decryptMessage,
  encryptMessage,
  parseXml,
  extractEncryptFromXml,
  decryptCallbackPayload,
  validationError
};
