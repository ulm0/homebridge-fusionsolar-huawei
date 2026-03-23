<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

<span align="center">

# Homebridge FusionSolar integration

</span>

This is a Homebridge plugin that integrates with the FusionSolar web app. It does not require a REST API account, which is handy when API access is unavailable. It uses Puppeteer to log in to FusionSolar and read the same energy-flow payload used by the web UI.

There're several types of accessories created by this plugin:

- Production [W] - current PV production (LightSensor)
- Battery Charging [W] - current battery charging (LightSensor)
- Battery Discharging [W] - current battery discharging (LightSensor)
- House Consumption [W] - current general house consumption (LightSensor)
- Import from grid [W] - current import from grid (LightSensor)
- Export to grid [W] - current export to grid (LightSensor)
- Battery - battery condition (Battery type accessory):
  - Battery level
  - Low status
  - Battery state (charging/not chargable/not charging)

#### This is what we get from FusionSolar
![FusionSolar app data](https://github.com/tofilskimateusz/homebridge-fusionsolar/blob/main/images/fusionsolar-app-screen1.png?raw=true)

#### This is how it looks like in Homebridge
![FusionSolar app data](https://github.com/tofilskimateusz/homebridge-fusionsolar/blob/main/images/homebridge_accessories_screen1.png?raw=true)
### Requirements

- Node.js `22.x` or `24.x`
- Homebridge `>= 1.11`

### Install

First install chromium:
````shell
sudo apt-get install chromium-browser
````
and then:
```shell
sudo npm install -g homebridge-fusionsolar
```

### Troubleshooting

- If login fails with selector timeout errors, open FusionSolar in a regular browser and check if a captcha or an extra auth challenge appears.
- If values stop updating, restart the plugin to refresh the web session.
- For Linux, set `executablePath` when Chromium is not in the default location.

### Sample configuration
```
{
...
    "platforms": [
        {
            "name": "homebridge-fusionsolar",
            "platform": "HomebridgeFusionsolar",
            "appUrl": "https://eu5.fusionsolar.huawei.com",
            "login": "###USER_LOGIN###",
            "password": "###USER_PASSWORD###",
            "batteryLowLevelPercentage": 30,
            "_bridge": {
                "username": "0E:34:1D:26:AA:30",
                "port": 38789
            }
        }
    ]
}
```