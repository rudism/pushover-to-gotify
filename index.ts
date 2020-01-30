import { ISettings, Client } from './Client';
import Xdg from 'xdg-basedir';
import mkdirp from 'mkdirp';

const settingsPath = process.env.P2G_SETTINGS_PATH
  || `${Xdg.config}/pushover2gotify/settings.json`;

let settings: ISettings | undefined;

try {
  console.log(`Attempting to load settings from ${settingsPath}`);
  settings = require(settingsPath);
} catch (error) {
  settings = {
    deviceId: process.env.P2G_DEVICE_ID,
    secret: process.env.P2G_SECRET,
    gotifyHost: process.env.P2G_GOTIFY_HOST,
    gotifyToken: process.env.P2G_GOTIFY_TOKEN,
  };
}

settings.imageCache = settings.imageCache
  || process.env.P2G_IMAGE_CACHE
  || `${Xdg.cache}/pushover2gotify`
  || `/tmp/pushover2gotify`;

console.log(`Initializing image cache ${settings.imageCache}`);
mkdirp.sync(settings.imageCache, '0755');

const client = new Client(settings);
client.connect();
