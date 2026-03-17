import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { FusionSolarAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { createApiClient, AuthMode, DeviceType, safeErrorMessage } from './api.js';
import type { FusionSolarApi, Device } from './api.js';

const MIN_POLL_INTERVAL_MS = 60_000;
const INIT_RETRY_DELAY_MS = 30_000;
const MAX_INIT_RETRIES = 5;

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

interface PvDataEntry {
  code: string;
  value: number;
}

export class FusionSolarPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly discoveredUUIDs: Set<string> = new Set();
  public readonly pvData: Map<string, PvDataEntry> = new Map();

  private apiClient: FusionSolarApi | null = null;
  private stationCode: string | null = null;
  private batteryDevIds: number[] = [];
  private meterDevIds: number[] = [];
  private meterDevTypeId: DeviceType = DeviceType.PowerSensor;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.initialize(0);
    });

    this.api.on('shutdown', () => {
      this.log.debug('Homebridge shutting down, cleaning up...');
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  getDataByCode(code: string): PvDataEntry | undefined {
    for (const entry of this.pvData.values()) {
      if (entry.code === code) {
        return entry;
      }
    }
    return undefined;
  }

  getDataById(id: string): PvDataEntry | undefined {
    return this.pvData.get(id);
  }

  private async initialize(attempt: number): Promise<void> {
    const authMode = (this.config.authMode as string | undefined) ?? AuthMode.Account;
    const baseUrl = (this.config.appUrl as string | undefined)
      ?? 'https://intl.fusionsolar.huawei.com';
    const userName = this.config.userName as string | undefined;
    const systemCode = this.config.systemCode as string | undefined;

    if (!userName || !systemCode) {
      this.log.error(
        'Missing required config: "userName" and "systemCode" must be set.',
      );
      return;
    }

    if (!this.apiClient) {
      try {
        this.apiClient = createApiClient(
          this.log,
          authMode as AuthMode,
          baseUrl,
          userName,
          systemCode,
        );
      } catch (error) {
        this.log.error('Invalid configuration:', safeErrorMessage(error));
        return;
      }
    }

    try {
      await this.apiClient.login();
    } catch (error) {
      this.log.error('Failed to authenticate with FusionSolar:', safeErrorMessage(error));
      this.scheduleRetry(attempt);
      return;
    }

    try {
      await this.discoverStationAndDevices();
    } catch (error) {
      this.log.error('Failed to discover station/devices:', safeErrorMessage(error));
      this.scheduleRetry(attempt);
      return;
    }

    await this.pollData(true);

    const interval = Math.max(
      MIN_POLL_INTERVAL_MS,
      ((this.config.pollInterval as number | undefined) ?? 5) * 60_000,
    );
    this.log.info(`Polling FusionSolar API every ${interval / 60_000} minutes`);
    this.pollTimer = setInterval(() => this.pollData(false), interval);
  }

  private scheduleRetry(attempt: number): void {
    if (attempt >= MAX_INIT_RETRIES) {
      this.log.error(
        `Giving up after ${MAX_INIT_RETRIES} failed initialization attempts. `
        + 'Check your credentials and restart Homebridge.',
      );
      return;
    }

    const delay = INIT_RETRY_DELAY_MS * (attempt + 1);
    this.log.warn(
      `Retrying initialization in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_INIT_RETRIES})...`,
    );
    setTimeout(() => this.initialize(attempt + 1), delay);
  }

  private async discoverStationAndDevices(): Promise<void> {
    const stations = await this.apiClient!.getStations();
    if (stations.length === 0) {
      throw new Error('No stations found for this account');
    }

    const stationCode = (this.config.stationCode as string | undefined)
      ?? stations[0].stationCode;
    const station = stations.find((s) => s.stationCode === stationCode);
    if (!station) {
      throw new Error(
        `Station "${stationCode}" not found. `
        + `Available: ${stations.map((s) => s.stationCode).join(', ')}`,
      );
    }

    this.stationCode = station.stationCode;
    this.log.info(`Using station: ${station.stationName} (${station.stationCode})`);

    const devices = await this.apiClient!.getDevList([this.stationCode]);
    this.log.info(`Found ${devices.length} device(s)`);

    this.batteryDevIds = devices
      .filter((d: Device) => d.devTypeId === DeviceType.Battery)
      .map((d: Device) => d.id);

    const powerSensors = devices.filter((d: Device) => d.devTypeId === DeviceType.PowerSensor);
    const powerMeters = devices.filter((d: Device) => d.devTypeId === DeviceType.PowerMeter);

    if (powerSensors.length > 0) {
      this.meterDevIds = powerSensors.map((d: Device) => d.id);
      this.meterDevTypeId = DeviceType.PowerSensor;
    } else if (powerMeters.length > 0) {
      this.meterDevIds = powerMeters.map((d: Device) => d.id);
      this.meterDevTypeId = DeviceType.PowerMeter;
    }

    for (const d of devices) {
      this.log.debug(
        `  Device: ${d.devName} (id=${d.id}, type=${d.devTypeId}, esn=${d.esnCode})`,
      );
    }
  }

  private async pollData(isFirstRun: boolean): Promise<void> {
    try {
      this.log.debug('Polling FusionSolar API...');

      const stationKpis = await this.apiClient!.getStationRealKpi([this.stationCode!]);
      const stationData = stationKpis[0]?.dataItemMap;

      const activePower = stationData?.active_power ?? 0;
      this.pvData.set('current_production', { code: 'current_production', value: activePower });

      let batteryPower = 0;
      let batterySoc = 0;
      let chargeCapacity = 0;
      let dischargeCapacity = 0;

      if (this.batteryDevIds.length > 0) {
        const batteryKpis = await this.apiClient!.getDevRealKpi(
          this.batteryDevIds,
          DeviceType.Battery,
        );
        for (const bk of batteryKpis) {
          const data = bk.dataItemMap;
          batterySoc = toNumber(data.battery_soc ?? data.SOC);
          batteryPower = toNumber(
            data.ch_discharge_power ?? data.battery_power ?? data.BATTERY_POWER,
          );
          chargeCapacity = toNumber(data.charge_cap ?? data.CHARGE_CAPACITY);
          dischargeCapacity = toNumber(data.discharge_cap ?? data.DISCHARGE_CAPACITY);
        }
      }

      this.pvData.set('battery_power', { code: 'battery_power', value: batteryPower });
      this.pvData.set('battery_percentage_capacity', {
        code: 'battery_percentage_capacity',
        value: batterySoc,
      });
      this.pvData.set('battery_charge_capacity', {
        code: 'battery_charge_capacity',
        value: chargeCapacity,
      });
      this.pvData.set('battery_discharge_capacity', {
        code: 'battery_discharge_capacity',
        value: dischargeCapacity,
      });
      this.pvData.set('battery_charging', { code: 'battery_charging', value: batteryPower });
      this.pvData.set('battery_discharging', { code: 'battery_discharging', value: batteryPower });

      let gridPower = 0;
      if (this.meterDevIds.length > 0) {
        const meterKpis = await this.apiClient!.getDevRealKpi(
          this.meterDevIds,
          this.meterDevTypeId,
        );
        for (const mk of meterKpis) {
          gridPower += toNumber(
            mk.dataItemMap.active_power ?? mk.dataItemMap.reverse_active_power,
          );
        }
      }

      const batteryContribution = batteryPower > 0 ? 0 : Math.abs(batteryPower);
      const generalConsumption = activePower + batteryContribution + (gridPower > 0 ? gridPower : 0);
      const gridImport = gridPower > 0 ? gridPower : 0;
      const gridExport = gridPower < 0 ? Math.abs(gridPower) : 0;

      this.pvData.set('general_consumption', {
        code: 'general_consumption',
        value: generalConsumption,
      });
      this.pvData.set('grid_import', { code: 'grid_import', value: gridImport });
      this.pvData.set('grid_export', { code: 'grid_export', value: gridExport });
      this.pvData.set('battery_consumption', {
        code: 'battery_consumption',
        value: batteryContribution,
      });

      this.log.debug(
        `Production: ${activePower} kW, Consumption: ${generalConsumption} kW, `
        + `Grid: ${gridPower} kW, Battery: ${batteryPower} kW (SOC: ${batterySoc}%)`,
      );

      if (isFirstRun) {
        this.discoverDevices();
      }
    } catch (error) {
      this.log.error('Failed to poll FusionSolar data:', safeErrorMessage(error));
    }
  }

  private discoverDevices(): void {
    const deviceList = [
      { uniqueId: 'current_production', displayName: 'Production kW', accessory: 'lightsensor' },
      { uniqueId: 'general_consumption', displayName: 'House consumption kW', accessory: 'lightsensor' },
      { uniqueId: 'grid_import', displayName: 'Import from grid kW', accessory: 'lightsensor' },
      { uniqueId: 'grid_export', displayName: 'Export to grid kW', accessory: 'lightsensor' },
      { uniqueId: 'battery_charging', displayName: 'Battery charging kW', accessory: 'battery_charging' },
      { uniqueId: 'battery_discharging', displayName: 'Battery discharging kW', accessory: 'battery_discharging' },
      { uniqueId: 'battery_percentage_capacity', displayName: 'Battery capacity', accessory: 'battery' },
    ];

    for (const device of deviceList) {
      const uuid = this.api.hap.uuid.generate(device.uniqueId);
      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = device;
        new FusionSolarAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', device.displayName);
        const accessory = new this.api.platformAccessory(device.displayName, uuid);
        accessory.context.device = device;
        new FusionSolarAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredUUIDs.add(uuid);
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredUUIDs.has(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
