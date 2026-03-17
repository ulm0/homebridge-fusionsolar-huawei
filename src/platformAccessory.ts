import type { PlatformAccessory, Service } from 'homebridge';

import type { FusionSolarPlatform } from './platform.js';

const UPDATE_INTERVAL_MS = 10_000;

export class FusionSolarAccessory {
  private service: Service;

  constructor(
    private readonly platform: FusionSolarPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Huawei')
      .setCharacteristic(this.platform.Characteristic.Model, 'FusionSolar')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    const type = accessory.context.device.accessory as string;

    switch (type) {
    case 'battery_charging':
      this.service = this.getOrAddLightSensor();
      this.startPolling(() => this.updateChargingSensor());
      break;
    case 'battery_discharging':
      this.service = this.getOrAddLightSensor();
      this.startPolling(() => this.updateDischargingSensor());
      break;
    case 'lightsensor':
      this.service = this.getOrAddLightSensor();
      this.startPolling(() => this.updateLightSensor());
      break;
    case 'battery':
      this.service = this.accessory.getService(this.platform.Service.Battery)
        || this.accessory.addService(this.platform.Service.Battery);
      this.startPolling(() => this.updateBattery());
      break;
    default: {
      const _exhaustive: never = type as never;
      throw new Error(`Unknown accessory type: ${_exhaustive}`);
    }
    }

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
  }

  private getOrAddLightSensor(): Service {
    return this.accessory.getService(this.platform.Service.LightSensor)
      || this.accessory.addService(this.platform.Service.LightSensor);
  }

  private startPolling(handler: () => void): void {
    setInterval(handler, UPDATE_INTERVAL_MS);
  }

  private updateChargingSensor(): void {
    const entry = this.platform.getDataById(this.accessory.context.device.uniqueId);
    const value = entry?.value ?? 0;
    const isActive = value > 0;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, isActive);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      isActive ? value * 1000 : 0.0001,
    );
  }

  private updateDischargingSensor(): void {
    const entry = this.platform.getDataById(this.accessory.context.device.uniqueId);
    const value = entry?.value ?? 0;
    const isActive = value < 0;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, isActive);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      isActive ? Math.abs(value) * 1000 : 0.0001,
    );
  }

  private updateLightSensor(): void {
    const entry = this.platform.getDataById(this.accessory.context.device.uniqueId);
    const value = entry?.value ?? 0;
    const isActive = value > 0;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, isActive);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      isActive ? value * 1000 : 0.0001,
    );
  }

  private updateBattery(): void {
    const entry = this.platform.getDataById(this.accessory.context.device.uniqueId);
    const batteryLevel = parseInt(String(entry?.value ?? 0), 10);
    const batteryPower = this.platform.getDataByCode('battery_power');

    const isBatteryLow = batteryLevel < (this.platform.config.batteryLowLevelPercentage ?? 20)
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

    let chargingState: number;
    if ((batteryPower?.value ?? 0) > 0) {
      chargingState = this.platform.Characteristic.ChargingState.CHARGING;
    } else if (batteryLevel >= 100) {
      chargingState = this.platform.Characteristic.ChargingState.NOT_CHARGEABLE;
    } else {
      chargingState = this.platform.Characteristic.ChargingState.NOT_CHARGING;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, isBatteryLow);
    this.service.updateCharacteristic(this.platform.Characteristic.BatteryLevel, batteryLevel);
    this.service.updateCharacteristic(this.platform.Characteristic.ChargingState, chargingState);
    this.service.updateCharacteristic(this.platform.Characteristic.Name, 'Battery');
  }
}
