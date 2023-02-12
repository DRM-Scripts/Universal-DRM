var rp = require('request-promise')
var qs = require('query-string')
let scheduleUrl = 'https://kong-tatasky.videoready.tv/portal-search/pub/api/v1/channels?languageFilters=&genreFilters=&limit=5000&offset=0&ott=true'
let ip = ''

class TataSkyManager {
  constructor (util, redisClient, videoManager) {
    this.util = util
    this.videoManager = videoManager
    this.redisClient = redisClient
    this.config = {}
  }

  async getStream (id) {
    let streamDataUrl = `https://kong-tatasky.videoready.tv/content-detail/pub/api/v2/channels/${id}?platform=WEB`
    let streamData = await rp.get(streamDataUrl, { json: true })
    return streamData.data.detail
  }

  async processWidevine (body) {
    let loginData = await this.login()
    let options = {
      url: 'https://tatasky.live.ott.irdeto.com/Widevine/getlicense',
      qs: {
        CrmId: 'tatasky',
        AccountId: '',
        ContentId: '',
        SessionId: loginData.rrmSessionInfo.sessionId,
        Ticket: loginData.rrmSessionInfo.ticket
      },
      body: body,
      headers: {
        'X-Forwarded-For': ip
      },
      encoding: null
    }
    return rp.post(options)
  }

  async login () {
    let cacheId = 'tatasky_login'
    let cache = await this.redisClient.getAsync(cacheId)
    if (cache) return JSON.parse(cache)
    let options = {
      body: {
        sid: process.env.TATASKY_USER_SID,
        pwd: process.env.TATASKY_PASS
      },
      json: true
    }
    let loginData = await rp.post('https://kong-tatasky.videoready.tv/rest-api/pub/api/v1/pwdLogin', options)
    this.redisClient.setex(cacheId, 86400, JSON.stringify(loginData.data))
    return loginData.data
  }

  async schedule () {
    let loginData = await this.login()
    let entitlements = loginData.userDetails.entitlements.map(x => x.pkgId)
    let schedule = await rp.get(scheduleUrl, { json: true })
    let channels = []
    let headers = { 'x-forwarded-for': ip }
    for (let channel of schedule.data.list) {
      if (channel.entitlements.some(r => entitlements.includes(r))) {
        channels.push(this.getStream(channel.id).then(channelData => {
          let url = `http://localhost:3001/video/master.m3u8?${qs.stringify({ mpd: channelData.dashWidewinePlayUrl, licenseUrl: `http://localhost:3001/tatasky/widevine`, headers: JSON.stringify(headers) })}`
          return { title: channel.title, url }
        }))
      }
    }
    return Promise.all(channels)
  }
}

module.exports = TataSkyManager
