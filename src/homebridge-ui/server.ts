import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import crypto from 'node:crypto';

const TRUSTED_DOMAIN = '.fusionsolar.huawei.com';
const MAX_REDIRECTS = 10;

interface LoginPayload {
  authMode: 'account' | 'northbound';
  appUrl: string;
  userName: string;
  systemCode: string;
}

interface Station {
  stationCode: string;
  stationName: string;
  capacity: number;
}

function isTrustedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.endsWith(TRUSTED_DOMAIN);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Northbound helpers
// ---------------------------------------------------------------------------

interface NbApiResponse {
  success?: boolean;
  failCode?: number;
  message?: string;
}

interface NbStationsResponse extends NbApiResponse {
  data?: Station[];
}

async function northboundLogin(
  baseUrl: string,
  userName: string,
  systemCode: string,
): Promise<{ stations: Station[] }> {
  const loginResp = await fetch(`${baseUrl}/thirdData/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, systemCode }),
  });

  if (!loginResp.ok) {
    throw new RequestError(
      `HTTP ${loginResp.status}: ${loginResp.statusText}`,
      { status: loginResp.status },
    );
  }

  const body = await loginResp.json() as NbApiResponse;
  if (!body.success) {
    throw new RequestError(
      body.message ?? `Authentication failed (failCode: ${body.failCode})`,
      { status: 401 },
    );
  }

  const token = loginResp.headers.get('xsrf-token');
  if (!token) {
    throw new RequestError('Login succeeded but no XSRF token received', { status: 500 });
  }

  const stationsResp = await fetch(`${baseUrl}/thirdData/stations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'XSRF-TOKEN': token },
    body: JSON.stringify({}),
  });

  if (!stationsResp.ok) {
    throw new RequestError('Failed to fetch stations', { status: stationsResp.status });
  }

  const stationsBody = await stationsResp.json() as NbStationsResponse;
  return { stations: stationsBody.data ?? [] };
}

// ---------------------------------------------------------------------------
// Web Account helpers
// ---------------------------------------------------------------------------

interface PubKeyResponse {
  enableEncrypt: boolean;
  pubKey: string;
  version: string;
  timeStamp: string;
}

interface ValidateUserResponse {
  errorCode: string;
  errorMsg: string;
  respMultiRegionName?: string[];
}

interface WebStation {
  dn: string;
  stationName: string;
  capacity: number;
}

function encryptPassword(pubKeyPem: string, password: string): string {
  const encoded = encodeURIComponent(password);
  const pubKey = crypto.createPublicKey(pubKeyPem);
  const jwk = pubKey.export({ format: 'jwk' });
  const modulusB64 = (jwk as { n?: string }).n ?? '';
  const keySizeBytes = Math.ceil((modulusB64.length * 6) / 8);
  const hashSize = 48;
  const maxChunk = Math.max(1, keySizeBytes - 2 * hashSize - 2);

  const chunks: string[] = [];

  for (let i = 0; i < Math.ceil(encoded.length / maxChunk); i++) {
    const chunk = encoded.slice(i * maxChunk, (i + 1) * maxChunk);
    const encrypted = crypto.publicEncrypt(
      {
        key: pubKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha384',
      },
      Buffer.from(chunk, 'utf-8'),
    );
    chunks.push(encrypted.toString('base64'));
  }

  return chunks.join('00000001');
}

function parseSubdomain(appUrl: string): { loginSub: string; fullSub: string } {
  const hostname = new URL(appUrl).hostname;
  const fullSub = hostname.split('.')[0];
  let loginSub: string;
  if (fullSub.startsWith('region')) {
    loginSub = fullSub.slice(8);
  } else if (fullSub.startsWith('uni')) {
    loginSub = fullSub.slice(6);
  } else {
    loginSub = fullSub;
  }
  return { loginSub, fullSub };
}

class CookieJar {
  private cookies = new Map<string, string>();

  store(response: Response): void {
    const headers = response.headers.getSetCookie?.() ?? [];
    for (const h of headers) {
      const parts = h.split(';')[0];
      const eq = parts.indexOf('=');
      if (eq > 0) {
        this.cookies.set(parts.slice(0, eq).trim(), parts.slice(eq + 1).trim());
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }
}

async function webAccountLogin(
  appUrl: string,
  username: string,
  password: string,
): Promise<{ stations: Station[] }> {
  const { loginSub, fullSub } = parseSubdomain(appUrl);
  const jar = new CookieJar();
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  function buildHeaders(targetUrl: string): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': ua };
    if (isTrustedUrl(targetUrl)) {
      headers.Cookie = jar.header();
    }
    return headers;
  }

  async function httpGet(url: string, depth = 0): Promise<Response> {
    if (depth > MAX_REDIRECTS) {
      throw new RequestError('Too many redirects', { status: 500 });
    }

    const resp = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(url),
      redirect: 'manual',
    });
    jar.store(resp);

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (loc) {
        const resolved = new URL(loc, url).href;
        return httpGet(resolved, depth + 1);
      }
    }
    return resp;
  }

  async function httpPost(
    url: string,
    body: Record<string, unknown>,
    depth = 0,
  ): Promise<Response> {
    if (depth > MAX_REDIRECTS) {
      throw new RequestError('Too many redirects', { status: 500 });
    }

    const headers = buildHeaders(url);
    headers['Content-Type'] = 'application/json';

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    jar.store(resp);

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (loc) {
        const resolved = new URL(loc, url).href;
        return httpGet(resolved, depth + 1);
      }
    }
    return resp;
  }

  const pubKeyResp = await httpGet(
    `https://${loginSub}.fusionsolar.huawei.com/unisso/pubkey`,
  );
  if (!pubKeyResp.ok) {
    throw new RequestError('Failed to connect to FusionSolar', { status: pubKeyResp.status });
  }
  const pubKeyData = await pubKeyResp.json() as PubKeyResponse;

  let loginUrl: string;
  const params = new URLSearchParams();
  let encPass: string;

  if (pubKeyData.enableEncrypt) {
    loginUrl = `https://${loginSub}.fusionsolar.huawei.com/unisso/v3/validateUser.action`;
    params.set('timeStamp', pubKeyData.timeStamp);
    params.set('nonce', crypto.randomBytes(16).toString('hex'));
    encPass = encryptPassword(pubKeyData.pubKey, password) + pubKeyData.version;
  } else {
    loginUrl = `https://${loginSub}.fusionsolar.huawei.com/unisso/v2/validateUser.action`;
    params.set('decision', '1');
    params.set(
      'service',
      `https://${fullSub}.fusionsolar.huawei.com`
        + '/unisess/v1/auth?service=/netecowebext/home/index.html#/LOGIN',
    );
    encPass = password;
  }

  const loginResp = await httpPost(
    `${loginUrl}?${params.toString()}`,
    { organizationName: '', username, password: encPass },
  );

  let loginResult: ValidateUserResponse;
  try {
    loginResult = await loginResp.json() as ValidateUserResponse;
  } catch {
    throw new RequestError('Login failed — invalid response from server', { status: 500 });
  }

  if (loginResult.errorCode === '470' && loginResult.respMultiRegionName) {
    if (loginResult.respMultiRegionName.length < 2) {
      throw new RequestError('Login failed: invalid redirect response', { status: 500 });
    }
    const redirect = loginResult.respMultiRegionName[1];
    await httpGet(`https://${loginSub}.fusionsolar.huawei.com${redirect}`);
  } else if (loginResult.errorMsg) {
    throw new RequestError(`Login failed: ${loginResult.errorMsg}`, { status: 401 });
  }

  await httpGet(
    `https://${fullSub}.fusionsolar.huawei.com/rest/dpcloud/auth/v1/keep-alive`,
  );

  const stationsResp = await httpPost(
    `https://${fullSub}.fusionsolar.huawei.com`
      + '/rest/pvms/web/station/v1/station/station-list',
    {
      curPage: 1,
      pageSize: 100,
      gridConnectedTime: '',
      queryTime: new Date(new Date().toDateString()).getTime(),
      timeZone: 2,
      sortId: 'createTime',
      sortDir: 'DESC',
      locale: 'en_US',
    },
  );

  let stationsData: { success?: boolean; data?: { list?: WebStation[] } };
  try {
    stationsData = await stationsResp.json() as typeof stationsData;
  } catch {
    throw new RequestError('Failed to parse stations response', { status: 500 });
  }

  if (!stationsData.success || !stationsData.data?.list) {
    throw new RequestError('Failed to retrieve station list', { status: 500 });
  }

  const stations: Station[] = stationsData.data.list.map((s) => ({
    stationCode: s.dn,
    stationName: s.stationName,
    capacity: s.capacity ?? 0,
  }));

  return { stations };
}

// ---------------------------------------------------------------------------
// UI Server
// ---------------------------------------------------------------------------

class FusionSolarUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/login', this.handleLogin.bind(this));
    this.ready();
  }

  async handleLogin(payload: LoginPayload): Promise<{ stations: Station[] }> {
    const { authMode, appUrl, userName, systemCode } = payload;

    if (!appUrl || !userName || !systemCode) {
      throw new RequestError('All fields are required', { status: 400 });
    }

    const baseUrl = appUrl.replace(/\/+$/, '');

    if (!isTrustedUrl(baseUrl)) {
      throw new RequestError(
        'Invalid API URL. Must be an HTTPS URL on *.fusionsolar.huawei.com',
        { status: 400 },
      );
    }

    try {
      switch (authMode) {
      case 'northbound':
        return await northboundLogin(baseUrl, userName, systemCode);
      case 'account':
      default:
        return await webAccountLogin(baseUrl, userName, systemCode);
      }
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      throw new RequestError('Connection failed. Please check your credentials and region.', { status: 500 });
    }
  }
}

(() => {
  return new FusionSolarUiServer();
})();
