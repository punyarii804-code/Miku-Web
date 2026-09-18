'use strict';

const { Router } = require('express');
const axios      = require('axios');
const FormData   = require('form-data');
const fs         = require('fs');
const path       = require('path');

const { asyncHandler, ValidationError, validate } = require('../../../utils/validation');
const { sendSuccessResponse }                      = require('../../../config/apikeyConfig');

const router = Router();

// ── free.ai session/token handling ──────────────────────────────────────────
const FREE_AI_URL      = 'https://api.free.ai/v1/video/enhance';
const FREE_AI_EMAIL    = "dongtubecs@gmail.com";
const FREE_AI_PASSWORD = "12345678";

let cachedApiKey = process.env.FREE_AI_API_KEY || '';
let apiKeyExpiry = 0;

async function refreshApiKey() {
  if (!FREE_AI_EMAIL || !FREE_AI_PASSWORD) return null;
  try {
    // Step 1: Get login page + cookies
    const loginPage = await axios.get('https://free.ai/login/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000,
    });
    const csrfMatch    = loginPage.data.match(/csrfmiddlewaretoken" value="([^"]+)"/);
    const setCookies   = loginPage.headers['set-cookie'] || [];
    const csrfCookie    = setCookies.find(c => c.includes('csrftoken='))?.split('csrftoken=')[1]?.split(';')[0] || '';
    const sessionCookie = setCookies.find(c => c.includes('sessionid='))?.split('sessionid=')[1]?.split(';')[0] || '';
    if (!csrfMatch || !csrfCookie) return null;
    const csrfToken = csrfMatch[1];
    const cookieStr = `csrftoken=${csrfCookie}; sessionid=${sessionCookie}`;

    // Step 2: Login
    const loginResp = await axios.post('https://free.ai/login/',
      `csrfmiddlewaretoken=${csrfToken}&email=${encodeURIComponent(FREE_AI_EMAIL)}&password=${encodeURIComponent(FREE_AI_PASSWORD)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':      'https://free.ai/login/',
          'X-CSRFToken':  csrfCookie,
          'Cookie':       cookieStr,
        },
        timeout: 10000,
        maxRedirects: 0,
        validateStatus: s => s < 400,
      }
    );

    // Merge cookies from login
    const loginCookies = loginResp.headers['set-cookie'] || [];
    let newSession = sessionCookie;
    let newCsrf    = csrfCookie;
    for (const c of loginCookies) {
      if (c.includes('sessionid=')) newSession = c.split('sessionid=')[1].split(';')[0];
      if (c.includes('csrftoken=')) newCsrf    = c.split('csrftoken=')[1].split(';')[0];
    }
    const authCookieStr = `csrftoken=${newCsrf}; sessionid=${newSession}`;

    // Step 3: Get session token
    const tokenResp = await axios.post('https://free.ai/api/v1/session-token/', {}, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'Mozilla/5.0',
        'X-CSRFToken':  newCsrf,
        'Cookie':       authCookieStr,
      },
      timeout: 10000,
    });

    if (tokenResp.data?.authenticated && tokenResp.data?.api_key) {
      cachedApiKey = tokenResp.data.api_key;
      apiKeyExpiry = Date.now() + 3600_000; // refresh tiap jam
      return cachedApiKey;
    }
  } catch (e) {
    // biarkan fallback ke cachedApiKey lama
  }
  return null;
}

async function getApiKey() {
  if (cachedApiKey && Date.now() < apiKeyExpiry) return cachedApiKey;
  const fresh = await refreshApiKey();
  return fresh || cachedApiKey;
}

async function downloadVideo(videoUrl) {
  try {
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MikuAI-Bot/1.0)' },
    });
    return Buffer.from(response.data);
  } catch (e) {
    throw new ValidationError(`Gagal download video: ${e.message}`, 400);
  }
}

async function enhanceVideo(videoUrl, noise, sharpness, color) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new ValidationError('FREE_AI_API_KEY belum di-set / gagal refresh. Set FREE_AI_EMAIL & FREE_AI_PASSWORD di .env', 500);
  }

  const videoBuffer = await downloadVideo(videoUrl);
  if (!videoBuffer || videoBuffer.length === 0) {
    throw new ValidationError('Gagal download video dari URL.', 400);
  }
  if (videoBuffer.length > 100 * 1024 * 1024) {
    throw new ValidationError('Ukuran video maksimal 100MB.', 400);
  }

  let ext = '.mp4';
  try { ext = path.extname(new URL(videoUrl).pathname) || '.mp4'; } catch (e) {}
  const tmpFile = path.join('/tmp', `enhance-${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, videoBuffer);

  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tmpFile), { filename: `video${ext}`, contentType: 'video/mp4' });
    formData.append('noise', noise);
    formData.append('sharpness', sharpness);
    formData.append('color', color);

    const enhanceResp = await axios.post(FREE_AI_URL, formData, {
      headers: { ...formData.getHeaders(), Authorization: `Bearer ${apiKey}` },
      timeout: 180000,
      maxRedirects: 5,
    });

    if (enhanceResp.status !== 200 || enhanceResp.data.error) {
      throw new ValidationError(
        enhanceResp.data?.error?.error || 'Gagal enhance video.',
        enhanceResp.status || 500
      );
    }

    return {
      video_url:    enhanceResp.data.video_url,
      share_url:    enhanceResp.data.share_url,
      duration:     enhanceResp.data.duration,
      tokens_used:  enhanceResp.data.tokens,
      filter_chain: enhanceResp.data.filter_chain,
      settings:     { noise, sharpness, color },
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// ── Handler bersama GET & POST ──────────────────────────────────────────────
async function handle(input, res) {
  const url       = String(input.url || '').trim();
  const noise     = String(input.noise || 'low');
  const sharpness = String(input.sharpness || 'subtle');
  const color     = String(input.color || 'subtle');

  const v = validate.fields({ url }, { url: { required: true, type: 'string' } });
  if (!v.valid) throw new ValidationError(v.errors.join(', '), 400);

  const allowedLevels = ['none', 'low', 'medium', 'high'];
  const allowedSubtle = ['none', 'subtle', 'medium', 'strong'];
  if (!allowedLevels.includes(noise))     throw new ValidationError(`noise harus salah satu dari: ${allowedLevels.join(', ')}`, 400);
  if (!allowedSubtle.includes(sharpness)) throw new ValidationError(`sharpness harus salah satu dari: ${allowedSubtle.join(', ')}`, 400);
  if (!allowedSubtle.includes(color))     throw new ValidationError(`color harus salah satu dari: ${allowedSubtle.join(', ')}`, 400);

  sendSuccessResponse(res, await enhanceVideo(url, noise, sharpness, color));
}

// ── GET ──────────────────────────────────────────────────────────────────────
router.get('/api/video/enhance', asyncHandler(async (req, res) => {
  await handle(req.query, res);
}));

// ── POST ─────────────────────────────────────────────────────────────────────
router.post('/api/video/enhance', asyncHandler(async (req, res) => {
  await handle(req.body, res);
}));

// ── Metadata ─────────────────────────────────────────────────────────────────
router.metadata = {
  name:        'Video Enhance',
  path:        '/api/video/enhance',
  methods:     ['GET', 'POST'],
  category:    'MEDIA',
  description: 'Tingkatkan kualitas video: denoise, sharpen, dan color boost lewat free.ai.',
  params: [
    { name: 'url',       type: 'text',   required: true,  placeholder: 'https://.../video.mp4', description: 'URL video sumber (bisa dari endpoint /download/*).' },
    { name: 'noise',     type: 'select', required: false, value: ['none', 'low', 'medium', 'high'],       default: 'low',     description: 'Level denoise.' },
    { name: 'sharpness', type: 'select', required: false, value: ['none', 'subtle', 'medium', 'strong'],  default: 'subtle',  description: 'Level ketajaman.' },
    { name: 'color',     type: 'select', required: false, value: ['none', 'subtle', 'medium', 'strong'],  default: 'subtle',  description: 'Level color boost.' },
  ],
};

module.exports = router;
