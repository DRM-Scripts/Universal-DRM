var rp = require('request-promise')
const deviceId = process.env.BELL_DEVICEID
const username = process.env.BELL_USER
const password = process.env.BELL_PASS
const proxy = undefined
const querystring = require('query-string')

class BellManager {
  constructor (redisClient, util, videoManager) {
    this.util = util
    this.videoManager = videoManager
    this.redisClient = redisClient
    this.headers = {
      'X-Bell-UDID': deviceId,
      'X-Bell-API-Key': ''
    }
  }

  async login () {
    let cacheId = 'bell_login'
    let loginData = await this.redisClient.getAsync(cacheId)
    if (loginData) {
      return JSON.parse(loginData)
    }

    let body = {
      'accessNetwork': 'WIFI',
      'useWifiAuth': true,
      'bmSubId': null,
      'sSubId': null,
      'useMobileAuth': true,
      'imsi': null,
      'sImsi': null,
      'mobileOperator': '',
      'cellTowerOperator': null,
      'pairingAuthTokens': [],
      'username': username,
      'password': password,
      'credentialsToken': null,
      'ssoToken': null,
      'guestChannelMap': null,
      'location': null,
      'device': {
        'platform': 'Mac OS',
        'model': 'Chrome 75.0.2819.101',
        'name': 'Chrome - Mac OS',
        'version': '10.12.1',
        'language': 'en',
        'additionalInformations': []
      },
      'client': {
        'name': 'fonse-web',
        'version': '7.3.21'
      },
      'organization': 'bell'
    }
    loginData = await rp.post('https://vcm-origin.nscreen.iptv.bell.ca/api/authnz/v3/session', { headers: this.headers, proxy, body, json: true })
    this.redisClient.setex(cacheId, 10000, JSON.stringify(loginData))

    return loginData
  }

  async getChannels () {
    let entitlementData = await this.login()
    let callsigns = entitlementData.tvAccounts[0].epgSubscriptions.callSigns
    let channelData = await rp.get('https://tv.bell.ca/api/epg/v3/channels?epgChannelMap=MAP_TORONTO&epgVersion=97197&tvService=fibe', { headers: this.headers, json: true })

    for (let i = channelData.length - 1; i >= 0; i--) {
      let channel = channelData[i]
      if (!callsigns.includes(channel.callSign)) {
        channelData.splice(i, 1)
      } else {
        channel.url = `http://localhost:3001/video/master.m3u8?${querystring.stringify({ mpd: `http://localhost:3001/bell/${channel.callSign}.mpd`, licenseUrl: `http://localhost:3001/bell/widevine?callsign=${channel.callSign}` })}`
      }
    }

    return channelData
  }

  async getStreamData (callsign) {
    let entitlementData = await this.login()
    let newHeaders = {
      'X-Bell-CToken': entitlementData.ctoken,
      'X-Bell-Player-Agent': 'fonse-web/7.3.21 AMC/2.11.1_45235-mirego12-6.3.swf;Native/8.9.0 (dynamicAdInsertion;widevine)'
    }
    let headers = Object.assign(newHeaders, this.headers)
    let body = { assetId: callsign, type: 'LIVE', mergedTvAccounts: [] }
    let resp = await rp.post(`https://vcm-origin.nscreen.iptv.bell.ca/api/playback/v3/tvAccounts/${entitlementData.tvAccounts[0].id}/streamings?warmup=true`, { body, proxy, headers, json: true })
    // let resp = await rp.put(`https://vcm-origin.nscreen.iptv.bell.ca/api/playback/v3/tvAccounts/${entitlementData.tvAccounts[0].id}/streamings/${warmup.streamingId}`, { body, proxy, headers, json: true })
    return resp
  }

  async getStreamUrl (callsign) {
    let streamData = await this.getStreamData(callsign)
    return Promise.resolve({ url: streamData.policies[0].player.streamingUrl })
  }

  async processWidevine (body, callsign) {
    let entitlementData = await this.login()
    let streamData = await this.getStreamData(callsign)
    let newHeaders = {
      'Host': 'vcm-origin.nscreen.iptv.bell.ca',
      'X-Bell-Play-Token': streamData.policies[0].playToken,
      'Origin': 'https://tv.bell.ca',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.132 Safari/537.36',
      'Sec-Fetch-Mode': 'cors',
      'X-Bell-CToken': entitlementData.ctoken,
      'X-Bell-Player-Agent': 'fonse-web/7.3.21 AMC/2.11.1_45235-mirego12-6.3.swf;Native/8.9.0 (dynamicAdInsertion;widevine)',
      'Accept': '*/*',
      'Sec-Fetch-Site': 'same-site',
      'Accept-Language': 'en-US,en;q=0.9',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache'
    }
    let headers = Object.assign(newHeaders, this.headers)
    if (Object.keys(body).length === 0) body = '\x08\x04'
    let widevineUrl = 'https://vcm-origin.nscreen.iptv.bell.ca/api/license/v1/widevine/request'
    let options = { uri: widevineUrl, headers, proxy, body, encoding: null }
    return rp.post(options)
  }
}

module.exports = BellManager
