Based heavily on [pushover-desktop-client](https://github.com/nbrownus/pushover-desktop-client/).

Create a new app on Gotify, then register a new desktop client on Pushover, then create a `settings.json` file:

```json
{
  "deviceId": "pushover_device_id",
  "secret": "pushover_secret",
  "gotifyHost": "my-gotify-server.example.com",
  "gotifyToken": "gotify_token"
}
```

Build and run:

```
npm i
npm run build
P2G_SETTINGS_PATH=/path/to/settings.json npm start
```

It opens a websocket connection to Pushover's streaming API and listens for messages. When one comes in, it posts the same message to Gotify and marks it as deleted in Pushover.
