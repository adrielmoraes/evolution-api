import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { Auth, ConfigService, HttpServer } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Flowise, FlowiseSetting, IntegrationSession } from '@prisma/client';
import { sendTelemetry } from '@utils/sendTelemetry';
import axios from 'axios';

export class FlowiseService {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
  ) {}

  private readonly logger = new Logger('FlowiseService');

  public async createNewSession(instance: InstanceDto, data: any) {
    try {
      const session = await this.prismaRepository.integrationSession.create({
        data: {
          remoteJid: data.remoteJid,
          sessionId: data.remoteJid,
          status: 'opened',
          awaitUser: false,
          botId: data.botId,
          instanceId: instance.instanceId,
        },
      });

      return { session };
    } catch (error) {
      this.logger.error(error);
      return;
    }
  }

  private isImageMessage(content: string) {
    return content.includes('imageMessage');
  }

  private async sendMessageToBot(
    instance: any,
    session: IntegrationSession,
    bot: Flowise,
    remoteJid: string,
    pushName: string,
    content: string,
  ) {
    const payload: any = {
      question: content,
      overrideConfig: {
        sessionId: remoteJid,
        vars: {
          remoteJid: remoteJid,
          pushName: pushName,
          instanceName: instance.instanceName,
          serverUrl: this.configService.get<HttpServer>('SERVER').URL,
          apiKey: this.configService.get<Auth>('AUTHENTICATION').API_KEY.KEY,
        },
      },
    };

    if (this.isImageMessage(content)) {
      const contentSplit = content.split('|');

      payload.uploads = [
        {
          data: contentSplit[1].split('?')[0],
          type: 'url',
          name: 'Flowise.png',
          mime: 'image/png',
        },
      ];
      payload.question = contentSplit[2] || content;
    }

    if (instance.integration === Integration.WHATSAPP_BAILEYS) {
      await instance.client.presenceSubscribe(remoteJid);
      await instance.client.sendPresenceUpdate('composing', remoteJid);
    }

    let headers: any = {
      'Content-Type': 'application/json',
    };

    if (bot.apiKey) {
      headers = {
        ...headers,
        Authorization: `Bearer ${bot.apiKey}`,
      };
    }

    const endpoint = bot.apiUrl;

    if (!endpoint) return null;

    const response = await axios.post(endpoint, payload, {
      headers,
    });

    if (instance.integration === Integration.WHATSAPP_BAILEYS)
      await instance.client.sendPresenceUpdate('paused', remoteJid);

    const message = response?.data?.text;

    return message;
  }

  private async sendMessageWhatsApp(
    instance: any,
    remoteJid: string,
    session: IntegrationSession,
    settings: FlowiseSetting,
    message: string,
  ) {
    const regex = /!?\[(.*?)\]\((.*?)\)/g;

    const result = [];
    let lastIndex = 0;

    let match;
    while ((match = regex.exec(message)) !== null) {
      if (match.index > lastIndex) {
        result.push({ text: message.slice(lastIndex, match.index).trim() });
      }

      result.push({ caption: match[1], url: match[2] });

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < message.length) {
      result.push({ text: message.slice(lastIndex).trim() });
    }

    for (const item of result) {
      if (item.text) {
        await instance.textMessage(
          {
            number: remoteJid.split('@')[0],
            delay: settings?.delayMessage || 1000,
            text: item.text,
          },
          false,
        );
      }

      if (item.url) {
        await instance.mediaMessage(
          {
            number: remoteJid.split('@')[0],
            delay: settings?.delayMessage || 1000,
            mediatype: 'image',
            media: item.url,
            caption: item.caption,
          },
          false,
        );
      }
    }

    await this.prismaRepository.integrationSession.update({
      where: {
        id: session.id,
      },
      data: {
        status: 'opened',
        awaitUser: true,
      },
    });

    sendTelemetry('/message/sendText');

    return;
  }

  private async initNewSession(
    instance: any,
    remoteJid: string,
    bot: Flowise,
    settings: FlowiseSetting,
    session: IntegrationSession,
    content: string,
    pushName?: string,
  ) {
    const data = await this.createNewSession(instance, {
      remoteJid,
      botId: bot.id,
    });

    if (data.session) {
      session = data.session;
    }

    const message = await this.sendMessageToBot(instance, session, bot, remoteJid, pushName, content);

    await this.sendMessageWhatsApp(instance, remoteJid, session, settings, message);

    return;
  }

  public async processBot(
    instance: any,
    remoteJid: string,
    bot: Flowise,
    session: IntegrationSession,
    settings: FlowiseSetting,
    content: string,
    pushName?: string,
  ) {
    if (session && session.status !== 'opened') {
      return;
    }

    if (session && settings.expire && settings.expire > 0) {
      const now = Date.now();

      const sessionUpdatedAt = new Date(session.updatedAt).getTime();

      const diff = now - sessionUpdatedAt;

      const diffInMinutes = Math.floor(diff / 1000 / 60);

      if (diffInMinutes > settings.expire) {
        if (settings.keepOpen) {
          await this.prismaRepository.integrationSession.update({
            where: {
              id: session.id,
            },
            data: {
              status: 'closed',
            },
          });
        } else {
          await this.prismaRepository.integrationSession.deleteMany({
            where: {
              botId: bot.id,
              remoteJid: remoteJid,
            },
          });
        }

        await this.initNewSession(instance, remoteJid, bot, settings, session, content, pushName);
        return;
      }
    }

    if (!session) {
      await this.initNewSession(instance, remoteJid, bot, settings, session, content, pushName);
      return;
    }

    await this.prismaRepository.integrationSession.update({
      where: {
        id: session.id,
      },
      data: {
        status: 'opened',
        awaitUser: false,
      },
    });

    if (!content) {
      if (settings.unknownMessage) {
        this.waMonitor.waInstances[instance.instanceName].textMessage(
          {
            number: remoteJid.split('@')[0],
            delay: settings.delayMessage || 1000,
            text: settings.unknownMessage,
          },
          false,
        );

        sendTelemetry('/message/sendText');
      }
      return;
    }

    if (settings.keywordFinish && content.toLowerCase() === settings.keywordFinish.toLowerCase()) {
      if (settings.keepOpen) {
        await this.prismaRepository.integrationSession.update({
          where: {
            id: session.id,
          },
          data: {
            status: 'closed',
          },
        });
      } else {
        await this.prismaRepository.integrationSession.deleteMany({
          where: {
            botId: bot.id,
            remoteJid: remoteJid,
          },
        });
      }
      return;
    }

    const message = await this.sendMessageToBot(instance, session, bot, remoteJid, pushName, content);

    await this.sendMessageWhatsApp(instance, remoteJid, session, settings, message);

    return;
  }
}