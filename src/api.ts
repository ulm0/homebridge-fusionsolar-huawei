import type { Logging } from 'homebridge';

import crypto from 'node:crypto';

export const enum AuthMode {
  Northbound = 'northbound',
  Account = 'account',
}

export const enum DeviceType {
  Inverter = 1,
  PowerMeter = 17,
  Battery = 39,
  PowerSensor = 47,
}

export interface Station {
  stationCode: string;
  stationName: string;
  capacity: number;
}

export interface Device {
  id: number;
  devName: string;
  esnCode: string;
  stationCode: string;
  devTypeId: number;
}

export interface StationRealKpi {
  stationCode: string;
  dataItemMap: {
    active_power?: number;
    day_power?: number;
    total_power?: number;
    real_health_state?: number;
  };
}

export interface DeviceRealKpi {
  devId: number;
  dataItemMap: Record<string, number | string | null>;
}

export interface FusionSolarApi {
  login(): Promise<void>;
  getStations(): Promise<Station[]>;
  getStationRealKpi(stationCodes: string[]): Promise<StationRealKpi[]>;
  getDevList(stationCodes: string[]): Promise<Device[]>;
  getDevRealKpi(devIds: number[], devTypeId: DeviceType): Promise<DeviceRealKpi[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRUSTED_DOMAIN = '.fusionsolar.huawei.com';
const MAX_REDIRECTS = 10;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isTrustedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.endsWith(TRUSTED_DOMAIN);
  } catch {
    return false;
  }
}

export function validateAppUrl(appUrl: string): void {
  if (!isTrustedUrl(appUrl)) {
    throw new Error(
      `Invalid appUrl: "${appUrl}". Must be an HTTPS URL on *${TRUSTED_DOMAIN}`,
    );
  }
}

function toNum(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function webMocTypeToDeviceType(mocTypeName: string): number {
  const name = mocTypeName.toLowerCase();
  if (name.includes('battery') || name.includes('ess')) {
    return DeviceType.Battery;
  }
  if (name.includes('meter') || name.includes('power sensor')) {
    return DeviceType.PowerSensor;
  }
  if (name.includes('inverter')) {
    return DeviceType.Inverter;
  }
  return DeviceType.Inverter;
}

function getField(
  map: Record<string, number | string | null>,
  key: string,
): number | string | null | undefined {
  return map[key];
}

function setField(
  map: Record<string, number | string | null>,
  key: string,
  value: number | string | null,
): void {
  map[key] = value;
}

function normalizeBatteryFields(map: Record<string, number | string | null>): void {
  if (getField(map, 'state_of_charge') !== undefined && getField(map, 'battery_soc') === undefined) {
    setField(map, 'battery_soc', getField(map, 'state_of_charge')!);
  }
  if (getField(map, 'charge/discharge_power') !== undefined && getField(map, 'ch_discharge_power') === undefined) {
    setField(map, 'ch_discharge_power', getField(map, 'charge/discharge_power')!);
  }
  if (getField(map, 'soc') !== undefined && getField(map, 'battery_soc') === undefined) {
    setField(map, 'battery_soc', getField(map, 'soc')!);
  }
}

function encryptPassword(pubKeyPem: string, password: string): string {
  const encoded = encodeURIComponent(password);
  const pubKey = crypto.createPublicKey(pubKeyPem);
  const jwk = pubKey.export({ format: 'jwk' });
  const modulusB64 = (jwk as { n?: string }).n ?? '';
  const keySizeBytes = Math.ceil((modulusB64.length * 6) / 8);
  const hashSize = 48; // SHA-384 output in bytes
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

function parseSubdomain(appUrl: string): { loginSubdomain: string; fullSubdomain: string } {
  const url = new URL(appUrl);
  const hostname = url.hostname;
  const fullSubdomain = hostname.split('.')[0];

  let loginSubdomain: string;
  if (fullSubdomain.startsWith('region')) {
    loginSubdomain = fullSubdomain.slice(8);
  } else if (fullSubdomain.startsWith('uni')) {
    loginSubdomain = fullSubdomain.slice(6);
  } else {
    loginSubdomain = fullSubdomain;
  }

  return { loginSubdomain, fullSubdomain };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Northbound API Client (/thirdData)
// ---------------------------------------------------------------------------

const NB_LOGIN = '/thirdData/login';
const NB_STATIONS = '/thirdData/stations';
const NB_STATION_REAL_KPI = '/thirdData/getStationRealKpi';
const NB_DEV_LIST = '/thirdData/getDevList';
const NB_DEV_REAL_KPI = '/thirdData/getDevRealKpi';
const FAIL_CODE_RELOGIN = 305;

export class NorthboundApiClient implements FusionSolarApi {
  private readonly baseUrl: string;
  private xsrfToken: string | null = null;

  constructor(
    private readonly log: Logging,
    baseUrl: string,
    private readonly userName: string,
    private readonly systemCode: string,
  ) {
    validateAppUrl(baseUrl);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async login(): Promise<void> {
    this.log.info('Authenticating with FusionSolar Northbound API...');

    const response = await fetch(`${this.baseUrl}${NB_LOGIN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: this.userName,
        systemCode: this.systemCode,
      }),
    });

    if (!response.ok) {
      throw new Error(`Login request failed with HTTP ${response.status}`);
    }

    const body = await response.json() as {
      success?: boolean;
      failCode?: number;
      message?: string;
    };

    if (!body.success) {
      throw new Error(
        `Login failed: ${body.message ?? 'unknown error'} (failCode: ${body.failCode})`,
      );
    }

    const token = response.headers.get('xsrf-token');
    if (!token) {
      throw new Error('Login succeeded but no xsrf-token found in response headers');
    }

    this.xsrfToken = token;
    this.log.info('Authenticated successfully with FusionSolar Northbound API');
  }

  async getStations(): Promise<Station[]> {
    const data = await this.request<{ data?: Station[] }>(NB_STATIONS, {});
    return data.data ?? [];
  }

  async getStationRealKpi(stationCodes: string[]): Promise<StationRealKpi[]> {
    const data = await this.request<{ data?: StationRealKpi[] }>(NB_STATION_REAL_KPI, {
      stationCodes: stationCodes.join(','),
    });
    return data.data ?? [];
  }

  async getDevList(stationCodes: string[]): Promise<Device[]> {
    const data = await this.request<{ data?: Device[] }>(NB_DEV_LIST, {
      stationCodes: stationCodes.join(','),
    });
    return data.data ?? [];
  }

  async getDevRealKpi(devIds: number[], devTypeId: DeviceType): Promise<DeviceRealKpi[]> {
    const data = await this.request<{ data?: DeviceRealKpi[] }>(NB_DEV_REAL_KPI, {
      devIds: devIds.join(','),
      devTypeId,
    });
    return data.data ?? [];
  }

  private async request<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    if (!this.xsrfToken) {
      await this.login();
    }

    const response = await this.doFetch(endpoint, body);
    const result = await response.json() as T & { failCode?: number; message?: string };

    if (result.failCode === FAIL_CODE_RELOGIN) {
      this.log.warn('Token expired, re-authenticating...');
      await this.login();
      const retryResponse = await this.doFetch(endpoint, body);
      return await retryResponse.json() as T;
    }

    if (result.failCode !== undefined && result.failCode !== 0) {
      throw new Error(
        `API error on ${endpoint}: ${result.message ?? 'unknown'} (failCode: ${result.failCode})`,
      );
    }

    return result;
  }

  private async doFetch(endpoint: string, body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'XSRF-TOKEN': this.xsrfToken!,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Request to ${endpoint} failed with HTTP ${response.status}`);
    }

    return response;
  }
}

// ---------------------------------------------------------------------------
// Web Account API Client (residential/personal accounts via /unisso + /rest)
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

interface WebApiStation {
  dn: string;
  stationName: string;
  capacity: number;
  stationCode?: string;
}

interface WebApiDevice {
  dn: string;
  devName: string;
  esnCode?: string;
  mocTypeName: string;
  id?: number;
}

interface PlantFlowResponse {
  data: {
    flow: {
      nodes: Array<{
        name: string;
        devIds?: string[];
      }>;
    };
    realKpi?: Record<string, number | string | null>;
  };
  success: boolean;
}

interface DeviceRealtimeSignal {
  id: string;
  name: string;
  realValue: string | number;
}

interface DeviceRealtimeSection {
  signals?: DeviceRealtimeSignal[];
}

interface DeviceRealtimeResponse {
  success?: boolean;
  data?: DeviceRealtimeSection[];
}

export class WebAccountApiClient implements FusionSolarApi {
  private readonly baseUrl: string;
  private readonly loginSubdomain: string;
  private readonly fullSubdomain: string;
  private cookies: Map<string, string> = new Map();
  private roarand: string | null = null;
  private companyId: string | null = null;

  constructor(
    private readonly log: Logging,
    appUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    validateAppUrl(appUrl);
    this.baseUrl = appUrl.replace(/\/+$/, '');
    const { loginSubdomain, fullSubdomain } = parseSubdomain(appUrl);
    this.loginSubdomain = loginSubdomain;
    this.fullSubdomain = fullSubdomain;
  }

  async login(): Promise<void> {
    this.log.info('Authenticating with FusionSolar web account...');
    this.cookies.clear();
    this.roarand = null;

    const base = `https://${this.fullSubdomain}.fusionsolar.huawei.com`;

    // Try the new portal login flow first (/rest/dp/uidm/unisso/v1/validate-user)
    const newFlowSuccess = await this.tryNewPortalLogin(base);

    if (!newFlowSuccess) {
      await this.trySsoLogin();
    }

    const keepAliveUrl = `${base}/rest/dpcloud/auth/v1/keep-alive`;
    await this.httpGet(keepAliveUrl);

    const companyUrl =
      `${base}/rest/neteco/web/organization/v2/company/current?_=${Date.now()}`;
    const companyResponse = await this.httpGet(companyUrl);
    const companyData = await companyResponse.json() as {
      data?: { moDn?: string };
    };

    if (!companyData.data?.moDn) {
      throw new Error('Failed to retrieve company info. Check your region/subdomain.');
    }

    this.companyId = companyData.data.moDn;

    const sessionUrl = `${base}/unisess/v1/auth/session`;
    const sessionResponse = await this.httpGet(sessionUrl);
    const sessionData = await sessionResponse.json() as { csrfToken?: string };
    if (sessionData.csrfToken) {
      this.roarand = sessionData.csrfToken;
    }

    this.log.info('Authenticated successfully with FusionSolar web account');
  }

  private async tryNewPortalLogin(base: string): Promise<boolean> {
    const svc = encodeURIComponent('/rest/dp/uidm/auth/v1/on-sso-credential-ready');
    const url = `${base}/rest/dp/uidm/unisso/v1/validate-user?service=${svc}`;

    this.log.debug('Trying new portal login flow...');
    const response = await this.httpPost(url, {
      username: this.username,
      password: this.password,
      verifycode: '',
    });

    let result: {
      code?: number;
      payload?: {
        exceptionId?: string;
        exceptionMessage?: string;
        redirectURL?: string;
      };
    };

    try {
      result = await response.json() as typeof result;
    } catch {
      this.log.debug('New portal login returned non-JSON, falling back to SSO flow');
      return false;
    }

    if (result.code === 0 && result.payload?.redirectURL) {
      this.log.debug('New portal login successful, following redirect...');
      const redirectUrl = result.payload.redirectURL.startsWith('http')
        ? result.payload.redirectURL
        : `${base}${result.payload.redirectURL}`;
      await this.httpGet(redirectUrl);
      return true;
    }

    if (result.code === -1 && result.payload?.exceptionId) {
      const exId = result.payload.exceptionId;
      const exMsg = result.payload.exceptionMessage ?? 'unknown error';

      if (exId === '406') {
        throw new Error('Login failed: invalid username or password');
      }

      throw new Error(`Login failed: ${exMsg} (${exId})`);
    }

    this.log.debug('New portal login not available, falling back to SSO flow');
    return false;
  }

  private async trySsoLogin(): Promise<void> {
    const pubKeyUrl =
      `https://${this.loginSubdomain}.fusionsolar.huawei.com/unisso/pubkey`;
    this.log.debug(`Fetching public key from ${pubKeyUrl}`);
    const pubKeyResponse = await this.httpGet(pubKeyUrl);

    const pubKeyText = await pubKeyResponse.text();
    if (pubKeyText.trimStart().startsWith('<')) {
      throw new Error(
        `Region "${this.fullSubdomain}" returned HTML instead of JSON. `
        + 'This usually means the region is incorrect for web account login. '
        + 'Try a different region.',
      );
    }

    let pubKeyData: PubKeyResponse;
    try {
      pubKeyData = JSON.parse(pubKeyText) as PubKeyResponse;
    } catch {
      throw new Error('Failed to parse public key response from FusionSolar');
    }

    let loginUrl: string;
    const params = new URLSearchParams();
    let encryptedPassword: string;

    if (pubKeyData.enableEncrypt) {
      this.log.debug('Using encrypted login (v3)');
      loginUrl =
        `https://${this.loginSubdomain}.fusionsolar.huawei.com/unisso/v3/validateUser.action`;
      params.set('timeStamp', pubKeyData.timeStamp);
      params.set('nonce', crypto.randomBytes(16).toString('hex'));
      encryptedPassword =
        encryptPassword(pubKeyData.pubKey, this.password) + pubKeyData.version;
    } else {
      this.log.debug('Using plain login (v2)');
      loginUrl =
        `https://${this.loginSubdomain}.fusionsolar.huawei.com/unisso/v2/validateUser.action`;
      params.set('decision', '1');
      const svc = `https://${this.fullSubdomain}.fusionsolar.huawei.com`
        + '/unisess/v1/auth?service=/netecowebext/home/index.html#/LOGIN';
      params.set('service', svc);
      encryptedPassword = this.password;
    }

    const loginResponse = await this.httpPost(
      `${loginUrl}?${params.toString()}`,
      { organizationName: '', username: this.username, password: encryptedPassword },
    );

    const loginResult = await loginResponse.json() as ValidateUserResponse;

    if (loginResult.errorCode === '470' && loginResult.respMultiRegionName) {
      if (loginResult.respMultiRegionName.length < 2) {
        throw new Error('Login failed: invalid multi-region redirect response');
      }
      this.log.debug('Multi-region redirect, following...');
      const redirectPath = loginResult.respMultiRegionName[1];
      const redirectUrl =
        `https://${this.loginSubdomain}.fusionsolar.huawei.com${redirectPath}`;
      await this.httpGet(redirectUrl);
    } else if (loginResult.errorMsg) {
      throw new Error(`Login failed: ${loginResult.errorMsg}`);
    }
  }

  async getStations(): Promise<Station[]> {
    await this.ensureLoggedIn();

    const url =
      `https://${this.fullSubdomain}.fusionsolar.huawei.com`
      + '/rest/pvms/web/station/v1/station/station-list';

    const response = await this.httpPost(url, {
      curPage: 1,
      pageSize: 100,
      gridConnectedTime: '',
      queryTime: this.getDayStartMs(),
      timeZone: 2,
      sortId: 'createTime',
      sortDir: 'DESC',
      locale: 'en_US',
    });

    const data = await response.json() as {
      success?: boolean;
      data?: { list?: WebApiStation[] };
    };

    if (!data.success || !data.data?.list) {
      throw new Error('Failed to retrieve station list');
    }

    return data.data.list.map((s) => ({
      stationCode: s.dn,
      stationName: s.stationName,
      capacity: s.capacity ?? 0,
    }));
  }

  async getStationRealKpi(stationCodes: string[]): Promise<StationRealKpi[]> {
    await this.ensureLoggedIn();

    const results: StationRealKpi[] = [];
    const base =
      `https://${this.fullSubdomain}.fusionsolar.huawei.com`
      + '/rest/pvms/web/station/v1/overview';

    for (const stationDn of stationCodes) {
      const dn = encodeURIComponent(stationDn);
      const flowUrl = `${base}/energy-flow?stationDn=${dn}&_=${Date.now()}`;
      const flowResponse = await this.httpGet(flowUrl);
      const flowData = await flowResponse.json() as PlantFlowResponse;

      const kpiUrl = `${base}/station-real-kpi`
        + `?stationDn=${dn}&clientTime=${Date.now()}&timeZone=1&_=${Date.now()}`;
      const kpiResponse = await this.httpGet(kpiUrl);
      const kpiData = await kpiResponse.json() as {
        data?: Record<string, number | string | null>;
      };

      const realKpi = flowData.data?.realKpi ?? {};
      const kpi = kpiData.data ?? {};

      results.push({
        stationCode: stationDn,
        dataItemMap: {
          active_power: toNum(
            getField(kpi, 'realTimePower') ?? getField(realKpi, 'activePower'),
          ),
          day_power: toNum(
            getField(kpi, 'dailyEnergy') ?? getField(realKpi, 'dailyEnergy'),
          ),
          total_power: toNum(
            getField(kpi, 'cumulativeEnergy') ?? getField(realKpi, 'cumulativeEnergy'),
          ),
        },
      });
    }

    return results;
  }

  async getDevList(stationCodes: string[]): Promise<Device[]> {
    await this.ensureLoggedIn();

    const parentDn = stationCodes[0] ?? this.companyId;
    const dn = encodeURIComponent(parentDn!);
    const mocTypes = '20814,20815,20816,20819,20822,50017,60066,60014,60015,23037';
    const url =
      `https://${this.fullSubdomain}.fusionsolar.huawei.com`
      + '/rest/neteco/web/config/device/v1/device-list'
      + `?conditionParams.parentDn=${dn}&conditionParams.mocTypes=${mocTypes}&_=${Date.now()}`;

    const response = await this.httpGet(url);
    const data = await response.json() as { data?: WebApiDevice[] };
    const devices = data.data ?? [];

    return devices.map((d, i) => ({
      id: d.id ?? i,
      devName: d.devName ?? d.dn,
      esnCode: d.esnCode ?? '',
      stationCode: parentDn!,
      devTypeId: webMocTypeToDeviceType(d.mocTypeName),
    }));
  }

  async getDevRealKpi(devIds: number[], devTypeId: DeviceType): Promise<DeviceRealKpi[]> {
    await this.ensureLoggedIn();

    const results: DeviceRealKpi[] = [];

    for (const devId of devIds) {
      const url =
        `https://${this.fullSubdomain}.fusionsolar.huawei.com`
        + `/rest/pvms/web/device/v1/device-realtime-data?deviceDn=${devId}&_=${Date.now()}`;

      const response = await this.httpGet(url);
      const data = await response.json() as DeviceRealtimeResponse;

      const dataItemMap: Record<string, number | string | null> = {};

      if (data.success && data.data) {
        for (const section of data.data) {
          if (!section.signals) {
            continue;
          }
          for (const signal of section.signals) {
            const key = signal.name.toLowerCase().replace(/\s+/g, '_');
            const val = typeof signal.realValue === 'string'
              ? parseFloat(signal.realValue) || signal.realValue
              : signal.realValue;
            setField(dataItemMap, key, val);
          }
        }
      }

      if (devTypeId === DeviceType.Battery) {
        normalizeBatteryFields(dataItemMap);
      }

      results.push({ devId, dataItemMap });
    }

    return results;
  }

  private async ensureLoggedIn(): Promise<void> {
    try {
      const url =
        `https://${this.fullSubdomain}.fusionsolar.huawei.com`
        + '/rest/dpcloud/auth/v1/is-session-alive';
      const response = await this.httpGet(url);
      const data = await response.json() as { code?: number };
      if (data.code !== 0) {
        await this.login();
      }
    } catch {
      await this.login();
    }
  }

  private getDayStartMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  private buildHeaders(targetUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
    };

    if (isTrustedUrl(targetUrl)) {
      headers.Cookie = this.getCookieHeader();
      if (this.roarand) {
        headers.roarand = this.roarand;
      }
    }

    return headers;
  }

  private async httpGet(url: string, depth = 0): Promise<Response> {
    if (depth > MAX_REDIRECTS) {
      throw new Error('Too many redirects');
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(url),
      redirect: 'manual',
    });

    this.storeCookies(response);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const resolved = new URL(location, url).href;
        return this.httpGet(resolved, depth + 1);
      }
    }

    return response;
  }

  private async httpPost(url: string, body: Record<string, unknown>, depth = 0): Promise<Response> {
    if (depth > MAX_REDIRECTS) {
      throw new Error('Too many redirects');
    }

    const headers = this.buildHeaders(url);
    headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
    });

    this.storeCookies(response);

    // 302/303 → follow as GET per HTTP spec
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const resolved = new URL(location, url).href;
        return this.httpGet(resolved, depth + 1);
      }
    }

    return response;
  }

  private getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private storeCookies(response: Response): void {
    const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
    for (const header of setCookieHeaders) {
      const parts = header.split(';')[0];
      const eqIndex = parts.indexOf('=');
      if (eqIndex > 0) {
        const name = parts.slice(0, eqIndex).trim();
        const value = parts.slice(eqIndex + 1).trim();
        this.cookies.set(name, value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export { safeErrorMessage };

export function createApiClient(
  log: Logging,
  authMode: AuthMode,
  baseUrl: string,
  username: string,
  password: string,
): FusionSolarApi {
  switch (authMode) {
  case AuthMode.Northbound:
    return new NorthboundApiClient(log, baseUrl, username, password);
  case AuthMode.Account:
    return new WebAccountApiClient(log, baseUrl, username, password);
  }
}
