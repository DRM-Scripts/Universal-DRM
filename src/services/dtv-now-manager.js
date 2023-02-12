var rp = require('request-promise')
const querystring = require('querystring')
const widevineUrl = 'https://api.cld.dtvce.com/rights/management/mdrm/vgemultidrm/v1/widevine/license'
const activateUrl = 'https://api.cld.dtvce.com/rights/management/mdrm/vgemultidrm/v1/widevine/activate'
let j = rp.jar()

class DTVNowManager {
  constructor (redisClient, util, videoManager) {
    this.util = util
    this.videoManager = videoManager
    this.redisClient = redisClient
  }

  async login () {
    let cacheId = 'dtv-now-login'
    let cache = await this.redisClient.getAsync(cacheId)
    if (cache) return JSON.parse(cache)
    let headers = {
      'Host': 'cprodmasx.att.com',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Origin': 'https://cprodmasx.att.com',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.100 Safari/537.36',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3',
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://cprodmasx.att.com/commonLogin/igate_wam/controller.do?TAM_OP=login&USERNAME=unauthenticated&ERROR_CODE=0x00000000&ERROR_TEXT=HPDBA0521I%20%20%20Successful%20completion&METHOD=GET&URL=%2Fpkmsvouchfor%3FATT%26https%3A%2F%2Fcprodx.att.com%2FTokenService%2FnxsATS%2FWATokenService%3FisPassive%3Dfalse%26lang%3Den%26appID%3Dm14961%26returnURL%3Dhttps%253A%252F%252Fapi.cld.dtvce.com%252Faccount%252Faeg%252Fums%252Ftglogin%253FnextUrl%253Dhttps%25253A%25252F%25252Fwww.directvnow.com%25252Faccounts%25252Fsign-in&REFERER=https%3A%2F%2Fcprodmasx.att.com%2FcommonLogin%2Figate_wam%2Fcontroller.do%3FTAM_OP%3Dlogout%26USERNAME%3D%26ERROR_CODE%3D0x00000000%26ERROR_TEXT%3DSuccessful%2520completion%26METHOD%3DGET%26URL%3D%2Fpkmslogout%26REFERER%3D%26AUTHNLEVEL%3D%26FAILREASON%3D%26OLDSESSION%3D%26style%3DTokenService%26returnurl%3Dhttps%253A%252F%252Fcprodx.att.com%252FTokenService%252FnxsATS%252FWATokenService%253FisPassive%253Dfalse%2526lang%253Den%2526appID%253Dm14961%2526returnURL%253Dhttps%25253A%25252F%25252Fapi.cld.dtvce.com%25252Faccount%25252Faeg%25252Fums%25252Ftglogin%25253FnextUrl%25253Dhttps%2525253A%2525252F%2525252Fwww.directvnow.com%2525252Faccounts%2525252Fsign-in&HOSTNAME=cprodmasx.att.com&AUTHNLEVEL=&FAILREASON=&OLDSESSION=',
      'Accept-Language': 'en-US,en;q=0.9'
    }

    let dataString = {
      userid: process.env.DTVNOW_USER,
      password: process.env.DTVNOW_PASS,
      cancelURL: 'https://cprodmasx.att.com/commonLogin/igate_wam/controller.do?TAM_OP=login&USERNAME=unauthenticated&ERROR_CODE=0x00000000&ERROR_TEXT=HPDBA0521I%20%20%20Successful%20completion&METHOD=GET&URL=%2Fpkmsvouchfor%3FATT%26https%3A%2F%2Fcprodx.att.com%2FTokenService%2FnxsATS%2FWATokenService%3FisPassive%3Dfalse%26lang%3Den%26appID%3Dm14961%26returnURL%3Dhttps%253A%252F%252Fapi.cld.dtvce.com%252Faccount%252Faeg%252Fums%252Ftglogin%253FnextUrl%253Dhttps%25253A%25252F%25252Fwww.atttvnow.com%25252Faccounts%25252Fsign-in&REFERER=https%3A%2F%2Fwww.atttvnow.com%2Faccounts%2Fsign-in&HOSTNAME=cprodmasx.att.com&AUTHNLEVEL=&FAILREASON=&OLDSESSION=',
      remember_me: 'Y',
      source: 'm14961',
      loginURL: '/WEB-INF/pages/directvNow/dtvNowLoginWeb.jsp',
      targetURL: '/pkmsvouchfor?ATT&https://cprodx.att.com/TokenService/nxsATS/WATokenService?isPassive=false&lang=en&appID=m14961&returnURL=https%3A%2F%2Fapi.cld.dtvce.com%2Faccount%2Faeg%2Fums%2Ftglogin%3FnextUrl%3Dhttps%253A%252F%252Fwww.atttvnow.com%252Faccounts%252Fsign-in',
      appID: 'm14961',
      HOSTNAME: 'cprodmasx.att.com',
      tGSignInOptURL: 'https://m.att.com/my/#/forgotLoginLanding?origination_point=dtvmig&Flow_Indicator=FPWD&Return_URL=https%3A%2F%2Fcprodx.att.com%2FTokenService%2FnxsATS%2FWATokenService%3FisPassive%3Dfalse%26lang%3Den%26appID%3Dm14961%26returnURL%3Dhttps%253A%252F%252Fapi.cld.dtvce.com%252Faccount%252Faeg%252Fums%252Ftglogin%253FnextUrl%253Dhttps%25253A%25252F%25252Fwww.atttvnow.com%25252Faccounts%25252Fsign-in',
      style: 'm14961'
    }

    let options = {
      url: 'https://cprodmasx.att.com/commonLogin/igate_wam/multiLogin.do',
      method: 'POST',
      jar: j,
      headers: headers,
      form: dataString,
      followAllRedirects: true
    }
    let result = await rp.post(options)
    let tats = /input type="hidden" name="TATS-TokenID" value="(.+?)"/.exec(result)[1]

    headers = {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'content-type': 'application/x-www-form-urlencoded',
      'origin': 'https://cprodx.att.com',
      'content-length': '461',
      'accept-language': 'en-us',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0.3 Safari/605.1.15',
      'referer': 'https://cprodx.att.com/TokenService/nxsATS/WATokenService?isPassive=false&lang=en&appID=m14961&returnURL=https%3A%2F%2Fapi.cld.dtvce.com%2Faccount%2Faeg%2Fums%2Ftglogin%3FnextUrl%3Dhttps%253A%252F%252Fwww.atttvnow.com%252Faccounts%252Fsign-in',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache'
    }

    options = {
      jar: j,
      headers: headers,
      form: { 'TATS-TokenID': tats },
      followAllRedirects: true
    }

    await rp.post('https://api.cld.dtvce.com/account/aeg/ums/tglogin?nextUrl=https%3A%2F%2Fwww.atttvnow.com%2Faccounts%2Fsign-in', options)

    let authResult = await rp.post('https://www.att.tv/auth', options)
    let accessToken = /accessToken:"(.+?)"/.exec(authResult)[1]
    let activationToken = /activationToken:"(.+?)"/.exec(authResult)[1]
    activationToken = Buffer.from(activationToken, 'hex').toString('base64')
    let loginObj = { accessToken, activationToken }
    this.redisClient.setex(cacheId, 3500, JSON.stringify(loginObj))
    return Promise.resolve({ accessToken, activationToken })
  }

  async getSchedule () {
    let loginData = await this.login()
    let headers = {
      Authorization: `Bearer ${loginData.accessToken}`
    }
    let channels = await rp.get('https://api.cld.dtvce.com/discovery/metadata/channel/v1/service/channel?uxReference=CHANNEL.SEARCH&itemCount=999&itemIndex=0', { headers, json: true }).then(x => x.channels)
    let promises = []
    for (let channel of channels) {
      promises.push(this.getChannelMeta(channel.ccId)
        .then(meta => {
          if (meta.dRights) {
            let licenseUrl = `http://localhost:3001/dtvnow/widevine?${querystring.stringify({ contentId: channel.ccId })}`
            let mpd = meta.playbackData.fallbackStreamUrl
              .replace('_mobile.mpd', '.mpd')
              .replace('index_mobile.m3u8', 'manifest.mpd')
              .replace('HLS.abre', 'DASH.abre')
            channel.statement = `http://localhost:3001/video/master.m3u8?${querystring.stringify({ licenseUrl, mpd })}`
          } else {
            console.warn(`no rights for ${channel.ccId}`)
          }
        })
        .catch(err => {
          console.warn(`no rights for ${channel.ccId}, err: ${err}`)
        }))
    }
    return Promise.all(promises).then(() => channels)
  }

  async getChannelMeta (ccid, useCache = true) {
    let cacheId = `dtvmeta-${ccid}`
    let cache = await this.redisClient.getAsync(cacheId)
    if (cache && useCache) {
      return JSON.parse(cache)
    } else {
      let loginData = await this.login()
      let headers = {
        Authorization: `Bearer ${loginData.accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.100 Safari/537.36'
      }
      return rp.get(`https://api.cld.dtvce.com/right/authorization/channel/v1?ccid=${ccid}&clientContext=proximity:outofhome,dmaID:803_0,billingDmaID:803,regionID:PRIMEHD_BGTN4HD_FSWHD_BGTN3HD_BIG10HD_PRIMHD_BG10O2H,zipCode:92345,countyCode:071,stateNumber:6,stateAbbr:CA,pkgCode:DVR%2020%20hours_Ultimate&proximity=O&reserveCTicket=true`, { headers, json: true }).then(resp => {
        if (resp.dRights) this.redisClient.setex(cacheId, 86400 * 30, JSON.stringify(resp))
        return resp
      })
    }
  }

  async processWidevine (body, contentId) {
    let loginData = await this.login()
    let headers = {
      Authorization: `Bearer ${loginData.accessToken}`
    }
    let challenge = body.toString('base64')
    let activateBody = {
      activationToken: loginData.activationToken,
      activationChallenge: challenge
    }
    let identityCookie = await this.redisClient.getAsync(activateUrl)
    if (!identityCookie) {
      let activationData = await rp.post({ url: activateUrl, headers: headers, body: activateBody, json: true })
      identityCookie = activationData.identityCookie
      this.redisClient.setex(activateUrl, 86400, identityCookie)
    }
    let meta = await this.getChannelMeta(contentId, false)
    if (meta.dRights) {
      let newBody = {
        contentID: contentId,
        contentType: '0x02',
        identityCookie,
        authorizationToken: meta.dRights.playToken,
        licenseChallenge: challenge
      }
      let options = { url: widevineUrl, headers: headers, body: newBody, json: true }
      let licenseData = await rp.post(options)
      return Buffer.from(licenseData.licenseData[0], 'base64')
    } else {
      console.err('no license rights for', contentId)
      return Promise.resolve(null)
    }
  }
}

module.exports = DTVNowManager
