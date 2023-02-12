var rp = require('request-promise')
const mpdParser = require('mpd-parser')
const url = require('url')
const fetch = require('node-fetch')
let scheduleUrl = 'https://ssl.dstv.com/api/cs-mobile/epg/v4/channelsByCountryAndPackage;country=ZA;subscriptionPackage=PREMIUM;eventsCount=1'
let ip = ''

class DSTVManager {
  constructor (util, redisClient, videoManager) {
    this.util = util
    this.videoManager = videoManager
    this.redisClient = redisClient
    this.config = {}
  }

  async getStream (id) {
    let schedule = await this.getSchedule()
    let channelItem = schedule.find(x => x.id === id)
    let streamItem = channelItem.streams.find(x => x.streamType === 'WebAlt')
    let streamUrl = streamItem.playerUrl
    return `${streamUrl.split('?')[0]}/.mpd`
  }

  async processWidevine (body) {
    let sessionTokens = await this.licenseAuth()
    let options = {
      url: 'https://foxtelott.live.ott.irdeto.com/widevine/getlicense',
      qs: {
        CrmId: 'afl',
        AccountId: 'afl',
        ContentId: 'SPY',
        SessionId: sessionTokens.sessionId,
        Ticket: sessionTokens.ticket
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
    let headers = {
      'content-type': 'application/x-www-form-urlencoded'
    }

    let params = 'userCountry=South_Africa&redirect_uri=http%3A%2F%2Flocalhost%3A49154%2F&nonce=1234&client_id=cf747925-dd85-4dde-b4f3-61dfe94ff517&response_type=id_token+token&scope=openid&AuthenticationType=Email&Email=email%40email.co.za&Mobile=&Password=password'
    let loginResp = await rp.post({ uri: 'https://connect.dstv.com/4.1/DStvNowApp/OAuth/Login', headers: headers, body: params, simple: false })
    return /access_token=(.*?)&/.exec(loginResp)[1]
  }

  async licenseAuth () {
    let authToken = await this.login()
    let headers = {
      'authorization': authToken,
      'x-forwarded-for': ip
    }

    let options = {
      headers: headers,
      method: 'POST',
      body: '{}'
    }
    let auth = await fetch('https://ssl.dstv.com/api/cs-mobile/user-manager/v4/vod-authorisation;productId=1b09957b-27aa-493b-a7c9-53b3cec92d63;platformId=32faad53-5e7b-4cc0-9f33-000092e85950;deviceType=Web', options).then(res => res.json())
    return auth.irdetoSession
  }

  async getScheduleStatus () {
    let scheduleData = await this.getSchedule()
    if (this.videoManager.config) {
      for (let channel of scheduleData) {
        let cacheId = `dstv-${channel.guid}`
        channel.active = !!(this.videoManager.config[cacheId] && this.videoManager.config[cacheId].started)
        channel.startTime = this.videoManager.config[cacheId] ? this.videoManager.config[cacheId].startTime : null
      }
    }
    return scheduleData
  }

  getSegments () {
    let self = this
    return async function processSegments (id) {
      id = id.split(/-(.+)/)[1]
      let mpd = await self.getStream(id)
      let manifest = await rp.get({ uri: mpd, headers: { 'X-Forwarded-For': ip } })
      let parsedManifest = mpdParser.parse(manifest, mpd)
      let lastSegment = await self.redisClient.getAsync(`video.${id}.lastSegment`)
      let lastSegmentAudio = await self.redisClient.getAsync(`video.${id}.lastSegmentAudio`)
      let playlists = self.util.getMaxPlaylists(parsedManifest)
      let pssh = playlists.maxVideo.contentProtection['com.widevine.alpha'].psshNormal
      let max = playlists.maxVideo
      let maxAudio = playlists.maxAudio
      let lastSegmentIndex = 0
      let lastSegmentAudioIndex = 0
      if (lastSegment) lastSegmentIndex = max.segments.findIndex(x => x.uri === lastSegment)
      if (lastSegmentAudio) lastSegmentAudioIndex = maxAudio.segments.findIndex(x => x.uri === lastSegmentAudio)
      if (lastSegment === -1 || lastSegmentAudio === -1) throw new Error('couldnt find index of last segment')
      let trimmed = max.segments.slice(-Math.abs(max.segments.length - 1 - lastSegmentIndex))
      let trimmedAudio = maxAudio.segments.slice(-Math.abs(maxAudio.segments.length - 1 - lastSegmentAudioIndex))
      let segments = [url.resolve(mpd, trimmed[0].map.uri)]
      let audio = [url.resolve(mpd, trimmedAudio[0].map.uri)]
      let maxLastAudio = 60
      let maxLastVideo = 60
      for (let segment of trimmed) {
        if (!lastSegmentIndex) maxLastVideo = maxLastVideo - segment.duration
        segments.push(url.resolve(mpd, segment.uri))
        if (maxLastVideo < 0) break
      }
      for (let segmentAudio of trimmedAudio) {
        if (!lastSegmentAudioIndex) maxLastAudio = maxLastAudio - segmentAudio.duration
        audio.push(url.resolve(mpd, segmentAudio.uri))
        if (maxLastAudio < 0) break
      }
      let finalSegments = { segments: {}, audio: {} }
      finalSegments.segments[pssh] = segments
      finalSegments.audio[pssh] = audio
      self.redisClient.set(`video.${id}.lastSegment`, max.segments[max.segments.length - 1].uri)
      self.redisClient.set(`video.${id}.lastSegmentAudio`, maxAudio.segments[maxAudio.segments.length - 1].uri)
      return Promise.resolve({ segments: finalSegments.segments, audio: finalSegments.audio })
    }
  }

  async getSchedule () {
    let redisSchedule = await this.redisClient.getAsync(`dstv-schedule`)
    let scheduleData = null
    if (redisSchedule) {
      scheduleData = JSON.parse(await this.redisClient.getAsync(`dstv-schedule`))
    } else {
      scheduleData = await fetch(scheduleUrl, { headers: { 'X-Forwarded-For': ip } }).then(res => res.json())
      for (let item of scheduleData.items) {
        item.channel_name = item.channelName
        item.assetTitle = item.events && item.events.length > 0 ? item.events[0].title : ''
        item.guid = item.id
      }
      this.redisClient.setex(`dstv-schedule`, 3600, JSON.stringify(scheduleData))
    }

    return scheduleData.items
  }
}

module.exports = DSTVManager
