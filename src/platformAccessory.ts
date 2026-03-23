import type { PlatformAccessory, Service } from 'homebridge';

import type { ExampleHomebridgePlatform } from './platform.js';

export class FusionsolarAccessory {
  private service: Service;
  private readonly updateIntervalMs = 10000;

  constructor(
    private readonly platform: ExampleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'FusionSolar')
      .setCharacteristic(this.platform.Characteristic.Model, 'Inverter')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.uniqueId);

    if (
      accessory.context.device.accessory === 'battery_charging'
      || accessory.context.device.accessory === 'battery_discharging'
      || accessory.context.device.accessory === 'lightsensor'
    ) {
      this.service = this.accessory.getService(this.platform.Service.LightSensor) || this.accessory.addService(this.platform.Service.LightSensor);
      setInterval(() => this.updateLightSensor(), this.updateIntervalMs);
    } else {
      //battery
      this.service = this.accessory.getService(this.platform.Service.Battery) || this.accessory.addService(this.platform.Service.Battery);
      setInterval(() => {
        const batteryLevel = Number.parseInt(String(this.platform.getDataById(accessory.context.device.uniqueId)?.value ?? 0), 10);
        const lowLevelThreshold = Number(this.platform.config.batteryLowLevelPercentage ?? 20);
        const isBatteryLow = batteryLevel < lowLevelThreshold
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;

        const batteryPower = Number(this.platform.getDataByCode('battery_power')?.value ?? 0);
        const chargingState = batteryPower > 0
          ? this.platform.Characteristic.ChargingState.CHARGING
          : (
            batteryLevel === 100
              ? this.platform.Characteristic.ChargingState.NOT_CHARGEABLE
              : this.platform.Characteristic.ChargingState.NOT_CHARGING
          );
        this.platform.log.debug('Set chargingState to: ' + chargingState);
        this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, isBatteryLow);
        this.service.updateCharacteristic(this.platform.Characteristic.BatteryLevel, batteryLevel);
        this.service.updateCharacteristic(this.platform.Characteristic.ChargingState, chargingState);
        this.service.updateCharacteristic(this.platform.Characteristic.Name, 'Battery');
      }, this.updateIntervalMs);
    }

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);
  }

  private updateLightSensor(): void {
    const uniqueId = this.accessory.context.device.uniqueId;
    const accessoryType = this.accessory.context.device.accessory;
    const rawValue = Number(this.platform.getDataById(uniqueId)?.value ?? 0);

    let reportedValue = 0;
    if (accessoryType === 'battery_charging') {
      reportedValue = rawValue > 0 ? rawValue : 0;
    } else if (accessoryType === 'battery_discharging') {
      reportedValue = rawValue < 0 ? Math.abs(rawValue) : 0;
    } else {
      reportedValue = rawValue > 0 ? rawValue : 0;
    }

    const isActive = reportedValue > 0;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, isActive ? 1 : 0);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentAmbientLightLevel,
      isActive ? reportedValue * 1000 : 0.0001,
    );
  }

}
