import { version } from '../../../package.json'
import { stylize, codes, getReadableDate, getReadableTime } from './styling'

export default class Monitoring {

  log (message: string) {
    console.log(this.buildMessage(stylize(codes.bgYellowLight, 'LOG'), message))
  }

  debug (message: string) {
    console.log(this.buildMessage(stylize(codes.bgYellowLight, 'DEBUG'), message))
  }  

  error (message: string) {
    console.log(this.buildMessage(stylize(codes.bgYellowLight, 'ERROR'), message))
  }  

  private buildMessage (prefix: string, message: string) {
    return `${stylize(codes.green, getReadableDate())} ${stylize(codes.cyan, getReadableTime())} ${prefix} ${message}`
  }
}