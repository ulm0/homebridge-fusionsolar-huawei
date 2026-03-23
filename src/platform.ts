import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { FusionsolarAccessory } from './platformAccessory.js';
import { createSnapshotFromFlowNodes, findFlowNodes } from './fusionsolar.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import puppeteer from 'puppeteer-extra';
import randomUseragent from 'random-useragent';
import type { Browser, HTTPRequest, HTTPResponse, Page } from 'puppeteer';

type PvDataEntry = {
  code: string;
  value: number;
};

type PvDataMap = Record<string, PvDataEntry>;

export class ExampleHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  private pvData: PvDataMap = {};
  private browser: Browser | null = null;
  private page: Page | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs = 30 * 60_000;
  private readonly minRetryDelayMs = 10_000;
  private readonly maxRetryDelayMs = 5 * 60_000;
  private consecutiveFailures = 0;
  private isFirstRun = true;
  private readonly usernameSelectors = [
    '#username input[type="text"]',
    '#username input',
    'input[id="username"]',
    'input[name="username"]',
    'input[id="userName"]',
    'input[name="userName"]',
    'input[type="email"]',
    'input[placeholder="Username or email"]',
    'input[autocomplete="username"]',
  ];
  private readonly passwordSelectors = [
    '#password input[type="password"]',
    '#password input',
    'input[id="value"]',
    'input[id="password"]',
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder="Password"]',
    'input[autocomplete="current-password"]',
  ];
  private readonly submitSelectors = [
    '#submitDataverify',
    'button[type="submit"]',
    'input[type="submit"]',
    'button[id*="submit"]',
  ];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pvData = {};

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.scheduleNextCycle(0);
    });
  }

  private scheduleNextCycle(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.runCycle().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`[FSH-CYCLE-UNHANDLED] ${message}`);
      });
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      await this.closeBrowser();
      await this.openAndLogin();
      this.consecutiveFailures = 0;
      this.scheduleNextCycle(this.refreshIntervalMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`[FSH-FETCH-ERROR] ${message}`);
      this.consecutiveFailures += 1;
      const retryDelay = Math.min(this.maxRetryDelayMs, this.minRetryDelayMs * (2 ** (this.consecutiveFailures - 1)));
      this.log.warn(`[FSH-RETRY] Retrying in ${Math.round(retryDelay / 1000)}s (attempt ${this.consecutiveFailures}).`);
      this.scheduleNextCycle(retryDelay);
    }
  }

  private async openAndLogin(): Promise<void> {
    const fallbackUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36';
    this.browser = await puppeteer.launch({
      headless: true,
      ...(this.config.executablePath ? { executablePath: this.config.executablePath } : {}),
      devtools: false,
      slowMo: 0,
      args: ['--disable-gpu', '--no-sandbox', '--no-zygote', '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas', '--disable-dev-shm-usage', '--proxy-server=\'direct://\'',
        '--proxy-bypass-list=*'],
      userDataDir: './user_data',
    });

    const userAgent = randomUseragent.getRandom() ?? fallbackUserAgent;
    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: 1920 + Math.floor(Math.random() * 100),
      height: 3000 + Math.floor(Math.random() * 100),
      deviceScaleFactor: 1,
      hasTouch: false,
      isLandscape: false,
      isMobile: false,
    });
    await this.page.setUserAgent(userAgent);
    await this.page.setJavaScriptEnabled(true);
    await this.page.setDefaultNavigationTimeout(0);

    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    await this.page.goto(`${String(this.config.appUrl)}/unisso/login.action`, {
      waitUntil: 'networkidle0',
    });

    const usernameSelector = await this.findAnySelector(this.page, this.usernameSelectors);
    if (usernameSelector) {
      await this.page.type(usernameSelector, String(this.config.login));
      const passwordSelector = await this.waitForAnySelector(this.page, this.passwordSelectors, 20_000);
      await this.page.type(passwordSelector, String(this.config.password));
      const submitSelector = await this.waitForAnySelector(this.page, this.submitSelectors, 10_000);
      await this.page.click(submitSelector);
      await this.page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => {
        this.log.debug('[FSH-LOGIN-SPA] Login submit did not trigger full navigation.');
      });
      this.log.info('[FSH-LOGIN-OK] Authenticated against FusionSolar.');
    } else {
      const currentUrl = this.page.url();
      const title = await this.page.title().catch(() => 'unknown');
      this.log.info(`[FSH-SESSION-REUSE] Reusing active FusionSolar session. URL=${currentUrl}, title=${title}`);
    }
    await this.page.setRequestInterception(true);
    this.page.on('request', this.onRequest);
    this.page.on('response', this.onResponse);
    await this.page.reload({ waitUntil: 'networkidle0', timeout: 30_000 }).catch(() => {
      this.log.debug('[FSH-REFRESH-SKIP] Initial page reload did not complete.');
    });
    this.log.debug('[FSH-REFRESH-OK] Triggered initial page refresh to capture flow data.');
  }

  private readonly onRequest = (request: HTTPRequest): void => {
    request.continue().catch(() => {
      this.log.debug('[FSH-REQUEST-SKIP] Request was not continued.');
    });
  };

  private readonly onResponse = async (response: HTTPResponse): Promise<void> => {
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      return;
    }

    let responseData: unknown;
    try {
      responseData = await response.json();
    } catch {
      return;
    }

    const flowNodes = findFlowNodes(responseData);
    if (!flowNodes) {
      return;
    }

    const snapshot = createSnapshotFromFlowNodes(flowNodes);
    this.pvData[`FUSIONSOLAR_${flowNodes[0].mocId}`] = {
      code: 'current_production',
      value: snapshot.currentProduction,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}`] = {
      code: 'battery_consumption',
      value: snapshot.batteryPower,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[5].mocId}`] = {
      code: 'general_consumption',
      value: snapshot.generalConsumption,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[5].mocId}_1a`] = {
      code: 'grid_import',
      value: snapshot.gridImport,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[5].mocId}_1b`] = {
      code: 'grid_export',
      value: snapshot.gridExport,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}_1`] = {
      code: 'battery_percentage_capacity',
      value: snapshot.batterySoc,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}_2`] = {
      code: 'battery_charge_capacity',
      value: snapshot.batteryChargeCapacity,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}_3`] = {
      code: 'battery_discharge_capacity',
      value: snapshot.batteryDischargeCapacity,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}_4`] = {
      code: 'battery_power',
      value: snapshot.batteryPowerFromTips,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}_5`] = {
      code: 'battery_charging',
      value: snapshot.batteryPowerFromTips,
    };
    this.pvData[`FUSIONSOLAR_${flowNodes[4].mocId}_6`] = {
      code: 'battery_discharging',
      value: snapshot.batteryPowerFromTips,
    };

    this.log.info('[FSH-DATA-UPDATE] Received fresh energy flow data.');
    if (this.isFirstRun) {
      this.discoverDevices();
      this.isFirstRun = false;
    }
  };

  private async closeBrowser(): Promise<void> {
    if (this.page) {
      this.page.off('request', this.onRequest);
      this.page.off('response', this.onResponse);
      await this.page.close().catch(() => undefined);
      this.page = null;
    }

    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private async waitForAnySelector(page: Page, selectors: string[], timeoutMs: number): Promise<string> {
    const endTime = Date.now() + timeoutMs;
    while (Date.now() < endTime) {
      for (const selector of selectors) {
        try {
          const handle = await page.$(selector);
          if (handle) {
            await page.waitForSelector(selector, { timeout: 1500, visible: true });
            return selector;
          }
        } catch {
          // Try next selector.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const title = await page.title().catch(() => 'unknown');
    const url = page.url?.() ?? 'unknown';
    throw new Error(`None of the selectors matched within ${timeoutMs}ms. URL=${url}, title=${title}, selectors=${selectors.join(', ')}`);
  }

  private async findAnySelector(page: Page, selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      try {
        const handle = await page.$(selector);
        if (handle) {
          return selector;
        }
      } catch {
        // Try next selector.
      }
    }
    return null;
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    const deviceList = [
      {
        uniqueId: this.getIdByCode('current_production'),
        displayName: 'Production Wh',
        accessory: 'lightsensor',
      },
      {
        uniqueId: this.getIdByCode('general_consumption'),
        displayName: 'House consumption Wh',
        accessory: 'lightsensor',
      },
      {
        uniqueId: this.getIdByCode('grid_import'),
        displayName: 'Import from grid Wh',
        accessory: 'lightsensor',
      },
      {
        uniqueId: this.getIdByCode('grid_export'),
        displayName: 'Export to grid Wh',
        accessory: 'lightsensor',
      },
      {
        uniqueId: this.getIdByCode('battery_charging'),
        displayName: 'Battery charging Wh',
        accessory: 'battery_charging',
      },
      {
        uniqueId: this.getIdByCode('battery_discharging'),
        displayName: 'Battery discharging Wh',
        accessory: 'battery_discharging',
      },
      {
        uniqueId: this.getIdByCode('battery_percentage_capacity'),
        displayName: 'Battery capacity',
        accessory: 'battery',
      },
    ];
    
    for (const device of deviceList) {
      const uuid = this.api.hap.uuid.generate(String(device.uniqueId));
      
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        new FusionsolarAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', device.displayName);

        const accessory = new this.api.platformAccessory(device.displayName, uuid);
        accessory.context.device = device;
        new FusionsolarAccessory(this, accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      // push into discoveredCacheUUIDs
      this.discoveredCacheUUIDs.push(uuid);
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  getDataByCode(code: string): PvDataEntry | undefined {
    for (const [, item] of Object.entries(this.pvData)) {
      if (item.code === code) {
        return item;
      }
    }
    return undefined;
  }

  getDataById(id: string): PvDataEntry | undefined {
    for (const [index, item] of Object.entries(this.pvData)) {
      if (index === id) {
        return item;
      }
    }
    return undefined;
  }

  getIdByCode(code: string): string {
    for (const [index, item] of Object.entries(this.pvData)) {
      if (item.code === code) {
        return index;
      }
    }
    return '0';
  }
}
