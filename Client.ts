import WebSocket from 'ws';
import QueryString from 'querystring';
import Https from 'https';
import Path from 'path';
import File from 'fs';
const fileExists = async (path) => !!(await File.promises.stat(path).catch((e) => false));

export interface IPushoverMessage {
  id: number;
  title: string;
  message: string;
  app: string;
  aid: number;
  icon: string;
  date: number;
  priority: number;
  acked: number;
  umid: number;
}

export interface ISettings {
  deviceId: string;
  secret: string;
  gotifyHost: string;
  gotifyToken: string;
  imageCache?: string;
  wsHost?: string;
  iconHost?: string;
  apiHost?: string;
  apiPath?: string;
  keepAliveTimeout?: number;
  logger?: { log: (msg: string) => void, error: (msg: string) => void };
}

export class Client {
  private settings: ISettings;
  private wsClient?: WebSocket;
  private lastConnection?: number;
  private keepAlive?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastMessageId: number = 0;

  constructor(settings: ISettings) {
    this.settings = Object.assign({
      wsHost: 'wss://client.pushover.net/push',
      iconHost: 'client.pushover.net',
      apiHost: 'api.pushover.net',
      apiPath: '/1',
      keepAliveTimeout: 60000,
      logger: console,
    }, settings);
  }

  public connect(): Promise<void> {
    if (this.wsClient) {
      return;
    }

    this.wsClient = new WebSocket(this.settings.wsHost);
    this.lastConnection = Date.now();

    this.wsClient.on('open', async () => {
      await this.refreshMessages();
      this.settings.logger.log('WebSocket connected, waiting for messages');
      this.resetKeepAlive();
      this.wsClient.send(`login:${this.settings.deviceId}:${this.settings.secret}\n`);
    });

    this.wsClient.on('message', async (event) => {
      const message = event.toString('utf8');

      if (message === '!') {
        this.settings.logger.log('Got new message event');
        await this.refreshMessages();
        return;
      } else if (message === '#') {
        this.resetKeepAlive();
        return;
      }

      this.settings.logger.log(`Unknown message: ${message}`);
      this.reconnect();
    });

    this.wsClient.on('error', (error) => {
      this.settings.logger.error('WebSocket connection error');
      this.settings.logger.error(error.stack || error.toString());
      this.reconnect();
    });

    this.wsClient.on('close', () => {
      this.settings.logger.log('WebSocket connection closed, reconnecting');
      this.reconnect();
    });
  }

  private resetKeepAlive(): void {
    clearTimeout(this.keepAlive);

    this.keepAlive = setTimeout(() => {
      this.settings.logger.log('Did not receive keep alive message in time, reconnecting');
      this.reconnect();
    }, this.settings.keepAliveTimeout);
  }

  private reconnect(): void {
    clearTimeout(this.keepAlive);

    try {
      this.wsClient.removeAllListeners();
      this.wsClient.terminate();
      this.wsClient = undefined;
    } catch (e) {}

    this.retry = setTimeout(() => {
      clearTimeout(this.retry);
      this.connect();
    }, this.settings.keepAliveTimeout - (Date.now() - this.lastConnection));
  }

  private async refreshMessages(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settings.logger.log('Refreshing messages');

      const query = QueryString.stringify({
        secret: this.settings.secret,
        device_id: this.settings.deviceId,
      });
      const options = {
        host: this.settings.apiHost,
        method: 'GET',
        path: `${this.settings.apiPath}/messages.json?${query}`,
      };

      const request = Https.request(options, (response) => {
        let finalData = '';

        response.on('data', (data) => finalData += data.toString());

        response.on('end', async () => {
          if (response.statusCode !== 200) {
            this.settings.logger.error('Error while refreshing messages');
            this.settings.logger.error(finalData);
            resolve();
            return;
          }

          try {
            const payload = JSON.parse(finalData);
            await this.handleMessages(payload.messages);
            resolve();
          } catch (error) {
            this.settings.logger.error('Failed to parse message payload');
            this.settings.logger.error(error.stack || error.toString());
            resolve();
          }
        });
      });

      request.on('error', (error) => {
        this.settings.logger.error('Error while refreshing messages');
        this.settings.logger.error(error.stack || error.toString());
        resolve();
      });

      request.end();
    });
  }

  private async handleMessages(messages: IPushoverMessage[]): Promise<void> {
    let lastMessage: IPushoverMessage | undefined;
    messages.forEach(async (message) => {
      if (!lastMessage || lastMessage.id < message.id) {
        lastMessage = message;
      }
      if (message.id > this.lastMessageId) {
        const icon = message.icon
          ? message.icon
          : (message.aid === 1 ? 'pushover.png' : 'default.png');

        const imageFile = await this.fetchImage(icon);

        return this.notify(message, imageFile);
      }
    });
    return this.updateHead(lastMessage);
  }

  private async notify(message: IPushoverMessage, imageFile: string) {
    this.settings.logger.log(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      const options = {
        host: this.settings.gotifyHost,
        method: 'POST',
        path: `/message?token=${this.settings.gotifyToken}`,
      };

      const request = Https.request(options, (response) => {
        let finalData = '';

        response.on('data', (data) => {
          finalData += data.toString();
        });

        response.on('end', () => {
          if (response.statusCode !== 200) {
            this.settings.logger.error('Error while posting to gotify');
            this.settings.logger.error(finalData);
            resolve();
          } else {
            resolve();
          }
        });
      });

      request.on('error', (error) => {
        this.settings.logger.error('Error while posting to gotify');
        this.settings.logger.error(error.stack || error.toString());
        resolve();
      });

      request.setHeader('Content-Type', 'application/json');
      request.write(JSON.stringify({
        title: message.title,
        message: message.message,
        priority: this.gotifyPriority(message.priority),
      }));

      request.end();
    });
  }

  private gotifyPriority(pushoverPriority: number): number {
    switch (pushoverPriority) {
      case -2:
        return 1;
      case -1:
        return 3;
      case 0:
        return 5;
      case 1:
        return 10;
      default:
        return 5;
    };
  }

  private async updateHead(message?: IPushoverMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!message || message.id <= this.lastMessageId) {
        resolve();
        return;
      }

      this.lastMessageId = message.id;
      this.settings.logger.log(`Updating head position to ${message.id}`);

      const options = {
        host: this.settings.apiHost,
        method: 'POST',
        path: `${this.settings.apiPath}/devices/${this.settings.deviceId}/update_highest_message.json`,
      };

      const request = Https.request(options, (response) => {
        let finalData = '';

        response.on('data', (data) => {
          finalData += data.toString();
        });

        response.on('end', () => {
          if (response.statusCode !== 200) {
            this.settings.logger.error('Error while updating head');
            this.settings.logger.error(finalData);
            resolve();
          } else {
            resolve();
          }
        });
      });

      request.on('error', (error) => {
        this.settings.logger.error('Error while updating head');
        this.settings.logger.error(error.stack || error.toString());
        resolve();
      });

      request.write(QueryString.stringify({
        secret: this.settings.secret,
        message: message.id,
      }) + '\n');

      request.end();
    });
  }

  private async fetchImage(imageName: string): Promise<string | null> {
    if (!this.settings.imageCache) {
      return null;
    }

    const imageFile = Path.join(this.settings.imageCache, imageName);
    if (await fileExists(imageFile)) {
      return imageFile;
    }

    this.settings.logger.log(`Caching image for ${imageName}`);

    return new Promise<string | null>((resolve, reject) => {
      const options = {
        host: this.settings.iconHost,
        method: 'GET',
        path: `/icons/${imageName}`,
      };

      const request = Https.request(options, (response) => {
        try {
          response.pipe(File.createWriteStream(imageFile));
        } catch (error) {
          this.settings.logger.error(`Error while caching image ${imageName}`);
          this.settings.logger.error(error.stack || error.toString());
          resolve(null);
        }

        response.on('end', () => {
          if (response.statusCode !== 200) {
            this.settings.logger.error(`HTTP error while caching image ${imageName}: ${response.statusCode}`);
            resolve(null);
          } else {
            resolve(imageFile);
          }
        });
      });

      request.on('error', (error) => {
        this.settings.logger.error(`Request error while caching image ${imageName}`);
        this.settings.logger.error(error.stack || error.toString());
        resolve(null);
      });

      request.end();
    });
  }
}
