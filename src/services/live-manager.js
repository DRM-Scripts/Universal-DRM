//DEV PROD ENVIRONMENT AS TEST - PRED
var rp = require('request-promise')
const jar = rp.jar()
const XmlJs = require('xml2js')
const mpdParser = require('mpd-parser')
const execPromise = require('child-process-promise').exec
const url = require('url')
const path = require('path')
const XmlParser = new XmlJs.Parser()
let downloadDir = `video/live-downloads`

const username = process.env.LIVE_USER
const password = process.env.LIVE_PASS

class LiveManager {
  constructor (util, redisClient) {
    this.util = util
    this.redisClient = redisClient
    this.config = {}
  }

  login () {
    let loginOpts = {
      url: 'https://2001live.com/login',
      jar: jar
    }
    return rp.get(loginOpts).then(result => {
      let tokenReg = result.match(new RegExp('<input type="hidden" name="_token" value="(.*)">'))
      let options = {
        url: 'https://2001live.com/account/login',
        form: {
          _token: tokenReg[1],
          email: username,
          password: password,
          remember: 'on'
        },
        jar: jar,
        simple: false
      }
      return rp.post(options)
    })
  }

  getStream (id) {
    return this.login().then(() => {
      let options = {
        url: 'https://2001live.com/' + id,
        jar: jar
      }
      return rp.get(options).then(result => {
        let manifest = /dash: "(.*)",/.exec(result)[1]
        let widevine = /widevine: {([\s\S]*?)},/.exec(result)[1]
        let customData = /value: "(.*)"/.exec(widevine)[1]
        let licenseUrl = /LA_URL: "(.*)"/.exec(widevine)[1]
        return { manifest, customData, licenseUrl }
      })
    })
  }

  processWidevine (body) {
    return this.getStream('mainstage').then(res => {
      let options = {
        url: res.licenseUrl,
        body: body,
        headers: {
          customdata: res.customData
        },
        encoding: null
      }
      return rp.post(options)
    })
  }

  getSubStream (id) {
    return this.getStream(id).then(streamData => {
      return this.mpdRequest(streamData.manifest).then(xml => {
        return new Promise((resolve, reject) => {
          XmlParser.parseString(xml, function (err, result) {
            if (err) {
              reject(err)
            } else {
              console.log(result.MPD)
              resolve(result.MPD.Location[0])
            }
          })
        })
      })
    })
  }

  async mpdRequest (url) {
    let gif = url.replace(path.basename(url), 'image.gif')
    let redisGif = await this.redisClient.getAsync(gif)
    if (!redisGif) {
      let gifResp = await rp.get({ uri: gif, headers: { Referer: 'https://2001live.com' } })
      this.redisClient.setex(gif, 600, gifResp)
    }
    return rp.get(url)
  }

  mpdRefresher () {
    let self = this
    return async function processMpd (id) {
      id = id.split('-')[1]
      let mpd = await self.redisClient.getAsync(id)
      self.config[id] = self.config[id] || {}
      if (!mpd) {
        mpd = await self.getSubStream(id).then(manifest => {
          self.redisClient.set(id, manifest)
          return manifest
        })
      } else {
        mpd = mpd.toString()
      }
      return self.mpdRequest(mpd).then(manifest => {
        let parsedManifest = mpdParser.parse(manifest, mpd)
        let playlists = self.util.getMaxPlaylists(parsedManifest, 'engmp4a.40.2')
        let pssh = playlists.maxVideo.contentProtection['com.widevine.alpha'].psshNormal
        let currentTime = new Date()
        self.config[id].videoStartTime = self.config[id].videoStartTime || new Date(currentTime)
        self.config[id].audioStartTime = self.config[id].audioStartTime || new Date(currentTime)
        self.config[id].init = self.config[id].init || {}
        for (let vidSeg of playlists.maxVideo.segments) {
          vidSeg.resolvedUri = url.resolve(mpd, vidSeg.uri)
          self.config[id].init.video = url.resolve(mpd, vidSeg.map.uri)
          self.config[id].segments = self.config[id].segments || {}
          vidSeg.startTime = new Date(self.config[id].videoStartTime)
          self.config[id].videoStartTime.setSeconds(self.config[id].videoStartTime.getSeconds() + vidSeg.duration)
          setTimeout(() => {
            let outFile = self.util.randomFileName('.m4s')
            execPromise(`aria2c ${vidSeg.resolvedUri} --out=${outFile} --dir ${downloadDir}`).then(() => {
              self.config[id].segments[pssh] = self.config[id].segments[pssh] || []
              self.config[id].segments[pssh].push(path.resolve(`${downloadDir}/${outFile}`))
            })
          }, vidSeg.startTime.getTime() - new Date().getTime())
        }
        for (let audSeg of playlists.maxAudio.segments) {
          audSeg.resolvedUri = url.resolve(mpd, audSeg.uri)
          self.config[id].init.audio = url.resolve(mpd, audSeg.map.uri)
          self.config[id].audio = self.config[id].audio || {}
          audSeg.startTime = new Date(self.config[id].audioStartTime)
          self.config[id].audioStartTime.setSeconds(self.config[id].audioStartTime.getSeconds() + audSeg.duration)
          setTimeout(() => {
            let outFile = self.util.randomFileName('.m4s')
            execPromise(`aria2c ${audSeg.resolvedUri} --out=${outFile} --dir ${downloadDir}`).then(() => {
              self.config[id].audio[pssh] = self.config[id].audio[pssh] || []
              self.config[id].audio[pssh].push(path.resolve(`${downloadDir}/${outFile}`))
            })
          }, audSeg.startTime.getTime() - new Date().getTime())
        }
        return true
      })
    }
  }

  getSegments () {
    let self = this
    return async function processSegments (id) {
      id = id.split('-')[1]
      let downloadDir = `video/${self.util.randomFileName()}`
      let outFile = self.util.randomFileName('.m4s')
      let initVideo = await execPromise(`aria2c ${self.config[id].init.video} --out=${outFile} --dir ${downloadDir}`).then(() => {
        return path.resolve(`${downloadDir}/${outFile}`)
      })
      outFile = self.util.randomFileName('.m4s')
      let initAudio = await execPromise(`aria2c ${self.config[id].init.audio} --out=${outFile} --dir ${downloadDir}`).then(() => {
        return path.resolve(`${downloadDir}/${outFile}`)
      })
      for (let pssh in self.config[id].segments) {
        self.config[id].segments[pssh] = [initVideo].concat(self.config[id].segments[pssh])
      }
      for (let pssh in self.config[id].audio) {
        self.config[id].audio[pssh] = [initAudio].concat(self.config[id].audio[pssh])
      }
      let segments = self.config[id].segments
      let audio = self.config[id].audio

      self.config[id].audio = {}
      self.config[id].segments = {}
      return Promise.resolve({ segments, audio })
    }
  }

  async getExoSchedule (host) {
    let ids = ['mainstage', 'dressingRoom']
    let items = [{ name: '2001live', samples: [] }]
    let promises = []
    for (let id of ids) {
      let res = await this.getStream(id)
      items[0].samples.push({
        name: id,
        uri: res.manifest,
        drm_scheme: 'widevine',
        drm_license_url: `${host}/live/widevine`
      })
    }
    return Promise.all(promises).then(() => {
      return items
    })
  }

  async getSchedule (host) {
    let ids = ['mainstage', 'dressingRoom']
    let items = { items: [] }
    for (let id of ids) {
      let res = await this.getStream(id)
      items.items.push({ channel: {
        title: Buffer.from(id).toString('base64'),
        stream_url: res.manifest,
        desc_image: null,
        drm: {
          protocol: 'mpd',
          type: 'com.widevine.alpha',
          license_url: `${host}/live/widevine`
        },
        description: null,
        category_id: null
      } })
    }
    let builder = new XmlJs.Builder({ cdata: true })
    return builder.buildObject(items)
  }
}

module.exports = LiveManager
