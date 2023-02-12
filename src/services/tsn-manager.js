var rp = require('request-promise')
const fairplayCertUrl = 'https://license.9c9media.ca/fairplay/cert'
const fairplayCkcUrl = 'https://license.9c9media.ca/fairplay/ckc'
const widevineUrl = 'https://license.9c9media.ca/widevine'
//const playReadyUrl = 'https://license.9c9media.ca/playready'

class TSNManager {
  getFairplayCert () {
    let options = { url: fairplayCertUrl, encoding: null }
    return rp.get(options).then(body => {
      return Buffer.from(body).toString('base64')
    })
  }

  processFairplayCert (body) {
    let options = { url: fairplayCkcUrl, body: body, encoding: null }
    return rp.post(options).then(body => {
      return Buffer.from(body).toString('base64')
    })
  }

  processWidevine (body) {
    if (Object.keys(body).length === 0) body = '\x08\x04'
    let options = { url: widevineUrl, body: body, encoding: null }
    return rp.post(options)
  }

  processPlayReady (body) {
    let options = { url: widevineUrl, body: body, encoding: null }
    return rp.post(options)
  }
}

module.exports = TSNManager
