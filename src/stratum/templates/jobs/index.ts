export default class Jobs {
  private jobs: Map<string, string> = new Map()
  private lastId = 0

  getHash (id: string) {
   return this.jobs.get(id)
  }

  deriveId (hash: string) {
    this.lastId =+ 1
    this.jobs.set(this.lastId.toString(), hash)
    return this.lastId.toString()
  }

  expireNext () {
    this.jobs.delete(this.jobs.entries().next().value[0])
  }
}