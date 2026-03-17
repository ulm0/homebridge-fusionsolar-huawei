# Homebridge FusionSolar Huawei

A [Homebridge](https://homebridge.io) plugin that integrates Huawei FusionSolar solar inverters, batteries, and power meters into Apple HomeKit.

## Features

- **Dual authentication** — supports both residential FusionSolar accounts (email + password) and the Northbound API (for installers)
- **Auto-discovery** — automatically detects your station, inverters, batteries, and power meters
- **Real-time monitoring** via HomeKit sensors:
  - Solar production (kW)
  - House consumption (kW)
  - Grid import / export (kW)
  - Battery charge / discharge (kW)
  - Battery state of charge (%)
- **Custom UI** — sign in and select your station directly from the Homebridge settings page

## Installation

### Via Homebridge UI

Search for `homebridge-fusionsolar-huawei` in the Homebridge UI plugin search and click **Install**.

### Via CLI

```bash
npm install -g homebridge-fusionsolar-huawei
```

## Configuration

### Using the Custom UI (recommended)

1. Open the plugin settings in the Homebridge UI
2. Select your **authentication mode**:
   - **Account** — use your regular FusionSolar login (email + password)
   - **Northbound API** — use developer credentials from Northbound Management
3. Select the **API region** that matches the URL you see when you log into FusionSolar
4. Enter your credentials and click **Sign In**
5. Select your station from the list
6. Click **Save**

### Manual configuration

Add the following to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "HomebridgeFusionsolarHuawei",
      "name": "FusionSolar",
      "authMode": "account",
      "appUrl": "https://region01eu5.fusionsolar.huawei.com",
      "userName": "your-email@example.com",
      "systemCode": "your-password",
      "pollInterval": 5,
      "batteryLowLevelPercentage": 20
    }
  ]
}
```

### Configuration options

| Option | Required | Default | Description |
|---|---|---|---|
| `platform` | Yes | — | Must be `HomebridgeFusionsolarHuawei` |
| `name` | Yes | `FusionSolar` | Display name in Homebridge |
| `authMode` | No | `account` | `account` for residential login, `northbound` for API credentials |
| `appUrl` | No | `https://intl.fusionsolar.huawei.com` | Regional API endpoint |
| `userName` | Yes | — | Email (account mode) or Northbound API username |
| `systemCode` | Yes | — | Password (account mode) or Northbound API systemCode |
| `stationCode` | No | First available | Station to monitor (use Sign In to discover) |
| `pollInterval` | No | `5` | Polling interval in minutes (minimum 1) |
| `batteryLowLevelPercentage` | No | `20` | Battery level (%) below which it's reported as low |

### Available regions

| Region | URL |
|---|---|
| International | `https://intl.fusionsolar.huawei.com` |
| Europe (region01eu5) | `https://region01eu5.fusionsolar.huawei.com` |
| Europe (uni001eu5) | `https://uni001eu5.fusionsolar.huawei.com` |
| Europe (eu5) | `https://eu5.fusionsolar.huawei.com` |
| Latin America (la5) | `https://la5.fusionsolar.huawei.com` |
| Asia Pacific (apac5) | `https://apac5.fusionsolar.huawei.com` |
| Middle East & Africa (mea5) | `https://mea5.fusionsolar.huawei.com` |

To determine your region, look at the URL in your browser when you log into [FusionSolar](https://fusionsolar.huawei.com). The subdomain (e.g., `region01eu5`) tells you which endpoint to use.

## Authentication Modes

### Account mode (recommended for home users)

Uses the same email and password you use to log into the FusionSolar web portal. This mode works for residential and small commercial accounts.

The plugin handles the full login flow: RSA-encrypted password exchange, session management, and automatic re-authentication when the session expires.

### Northbound API mode (for installers)

Uses the Northbound API credentials created under **System > Company Management > Northbound Management** in the FusionSolar portal. This option is only available to users with installer or company administrator access.

## HomeKit Accessories

The plugin creates the following accessories:

| Accessory | Type | Value |
|---|---|---|
| Production kW | Light Sensor | Current solar production × 1000 lux |
| House consumption kW | Light Sensor | Total consumption × 1000 lux |
| Import from grid kW | Light Sensor | Grid import × 1000 lux |
| Export to grid kW | Light Sensor | Grid export × 1000 lux |
| Battery charging kW | Light Sensor | Charge power × 1000 lux |
| Battery discharging kW | Light Sensor | Discharge power × 1000 lux |
| Battery capacity | Battery | State of charge (%) |

Light sensor values are expressed in lux (value in kW × 1000) because HomeKit does not have a native power sensor type. A value of `0.0001 lux` indicates the sensor is inactive.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Lint
npm run lint

# Watch mode (build + link + auto-restart)
npm run watch
```

## Security

- All connections use HTTPS exclusively
- URL validation ensures credentials are only sent to `*.fusionsolar.huawei.com`
- Redirect targets are validated against trusted domains
- Passwords in Account mode are RSA-encrypted before transmission
- The `systemCode` field is masked in the Custom UI
- Error messages returned to the UI are sanitized to prevent information leakage
- DOM rendering uses `textContent` to prevent XSS

**Note:** Credentials are stored in plaintext in the Homebridge `config.json` file. This is standard for Homebridge plugins. Ensure your Homebridge instance is properly secured.

## License

[Apache-2.0](LICENSE)
