import { stylize, codes, getReadableDate, getReadableTime } from './styling';
import PQueue from 'p-queue';

interface LogJobData {
  level: 'LOG' | 'DEBUG' | 'ERROR';
  message: string;
}

export default class Monitoring {
  private logQueue: PQueue;
  private debugEnabled: boolean;

  constructor() {
    this.logQueue = new PQueue({ concurrency: 1 });
    this.debugEnabled = process.env.DEBUG === '1';
  }

  log(message: string) {
    this.logQueue.add(() => this.processLog({ level: 'LOG', message }));
  }

  debug(message: string) {
    if (this.debugEnabled) {
      this.logQueue.add(() => this.processLog({ level: 'DEBUG', message }));
    }
  }

  error(message: string) {
    this.logQueue.add(() => this.processLog({ level: 'ERROR', message }));
  }

  private async processLog(job: LogJobData) {
    const { level, message } = job;
    const prefix = stylize(codes.bgYellowLight, level);
    console.log(this.buildMessage(prefix, message));
  }

  private buildMessage(prefix: string, message: string) {
    return `${stylize(codes.green, getReadableDate())} ${stylize(codes.cyan, getReadableTime())} ${prefix} ${message}`;
  }

  async waitForQueueToDrain() {
    await this.logQueue.onIdle();
  }
}