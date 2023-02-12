var rp = require('request-promise')
const deviceIds = [
  '389ab513-0936-4be6-9eeb-6f8ac7f48d6b'
]
const username = process.env.RAP_USER
const password = process.env.RAP_PASS
const proxy = undefined
const querystring = require('query-string')

class RAPManager {
  constructor (redisClient, util) {
    this.util = util
    this.redisClient = redisClient
  }

  async login (deviceId) {
    let cacheId = `rap_login_${deviceId}`
    let loginData = await this.redisClient.getAsync(cacheId)
    if (loginData) {
      return JSON.parse(loginData)
    }
    loginData = await rp.post('https://raptv.umsgw.quickplay.com/qp/login?lang=en', { body: { deviceId, username, password }, proxy, json: true })
    let tToken = loginData.data.tToken
    let mac = loginData.data.can[0].stb[0].mac

    let options = {
      qs: {
        deviceId,
        'stb-mac': mac,
        lang: 'en'
      },
      headers: {
        'x-authorization': tToken
      },
      proxy,
      json: true
    }
    let entitlementData = await rp.get('https://raptv.umsgw.quickplay.com/qp/entitlements', options)
    this.redisClient.setex(cacheId, 80000, JSON.stringify(entitlementData))

    return entitlementData
  }

  async getChannels () {
    let deviceId = deviceIds[Math.floor(Math.random() * deviceIds.length)]
    let entitlementData = await this.login(deviceId)
    let newChannels = []
    for (let channel of entitlementData.data.entitlements) {
      if (!newChannels.some(x => x.playBackId === channel.playBackId)) {
        let url = `http://localhost:3001/video/master.m3u8?${querystring.stringify({ mpd: `http://localhost:3001/rap/${channel.playBackId}.mpd`, licenseUrl: `http://localhost:3001/rap/widevine?playbackId=${channel.playBackId}` })}`
        newChannels.push({ url, name: channel.name, playBackId: channel.playBackId })
      }
    }
    return newChannels
  }

  async getStreamTokens (uat, deviceId) {
    let form = {
      'action': '1',
      'render': 'json',
      'roamingCheck': 'false',
      'deviceName': 'webClient',
      'locale': 'en_CA',
      'network': 'wifi',
      'uniqueId': deviceId,
      'UAT': uat,
      'appId': '6013',
      'apiVersion': '6',
      'apiRevision': '0',
      'carrierId': '5',
      'clientBuild': '0002',
      'clientVersion': '2.0',
      'bitrate': '1000000',
      'iu': '/7326/en.raptv.web/',
      'lang': 'en',
      'sz': '640x360'
    }
    let body = querystring.stringify(form)
    let resp = await rp.post('https://raptv.vstb.quickplay.com/vstb/app', { body, proxy, headers: { 'content-type': 'text/plain;charset=UTF-8' } })
    return JSON.parse(resp)
  }

  async getStreamData (playbackId) {
    let cacheId = `rap_stream_${playbackId}`
    let cache = await this.redisClient.getAsync(cacheId)
    if (cache) {
      return JSON.parse(cache)
    }
    let deviceId = deviceIds[Math.floor(Math.random() * deviceIds.length)]
    let loginData = await this.login(deviceId)
    let streamTokenData = await this.getStreamTokens(loginData.data.ovat, deviceId)
    let form = {
      'action': '101',
      'render': 'json',
      'roamingCheck': 'false',
      'deviceName': 'webClient',
      'locale': 'en_CA',
      'delivery': '5',
      'UAT': loginData.data.ovat,
      'mak': streamTokenData.mak,
      'network': 'wifi',
      'drmToken': streamTokenData.mak,
      'uniqueId': deviceId,
      'subscriberId': deviceId,
      'contentId': playbackId,
      'contentTypeId': '4',
      'preferredMediaPkgs': 'DASH',
      'preferredDRM': '6:2.0,0:',
      'appId': '6013',
      'apiVersion': '6',
      'apiRevision': '0',
      'carrierId': '5',
      'clientBuild': '0002',
      'clientVersion': '2.0',
      'bitrate': '1000000',
      'iu': '/7326/en.raptv.web/',
      'lang': 'en',
      'sz': '640x360',
      'url': `https://www.rogersanyplacetv.com/live/${playbackId}/full`
    }
    let body = querystring.stringify(form)
    let resp = await rp.post('https://raptv.vstb.quickplay.com/vstb/app', { body, proxy, headers: { 'content-type': 'text/plain;charset=UTF-8' } })
    resp = JSON.parse(resp)
    this.redisClient.setex(cacheId, 500, JSON.stringify(resp))
    return resp
  }

  async getStreamUrl (playbackId) {
    let streamData = await this.getStreamData(playbackId)
    let rightsObject = this.util.decryptRightsObject(streamData.rightsObject)
    return Promise.resolve({ url: rightsObject.contentUrl })
  }

  async processWidevine (body, playbackId) {
    let streamData = await this.getStreamData(playbackId)
    let rightsObject = this.util.decryptRightsObject(streamData.rightsObject)
    if (Object.keys(body).length === 0) body = '\x08\x04'
    let widevineUrl = rightsObject.drmAttributes.widevineLicenseProxyAddr + rightsObject.drmAttributes.widevineLicenseQParams
    let options = { uri: widevineUrl, proxy, body: body, encoding: null }
    return rp.post(options)
  }
}

module.exports = RAPManager
