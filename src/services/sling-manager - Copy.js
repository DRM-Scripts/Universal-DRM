const rp = require('request-promise')
const fetch = require('node-fetch')
const promiseRetry = require('promise-retry')
const uuidv4 = require('uuid/v4')
const _ = require('lodash')
const XmlJs = require('xml2js')
const mpdParser = require('mpd-parser')

let range = 30
let turnover = 42186

const XmlParser = new XmlJs.Parser()
const widevineUrl = 'http://p-drmwv.movetv.com/proxy'

class SlingManager {
  constructor (redisClient, util, videoManager) {
    this.redisClient = redisClient
    this.util = util
    this.videoManager = videoManager
    this.config = {}
  }

  findLastIndex (array, searchKey, searchValue) {
    let index = array.slice().reverse().findIndex(x => x[searchKey] === searchValue)
    let count = array.length - 1
    let finalIndex = index >= 0 ? count - index : index
    return finalIndex
  }

  findEarliestSegment (array, searchKey) {
    return array.reduce((prev, curr) => prev[searchKey] < curr[searchKey] ? prev : curr)
  }

  processWidevine (body, channelId) {
    console.log('count: %d', body)
    console.log('count: %d', channelId)
    let drmBody = {
      env: 'production',
      user_id: uuidv4(),
      channel_id: '${channelId}',
      message: [...body]
    }
    let newHeaders = {
        'Connection': 'keep-alive',
        'Content-Length': '133',
        'Origin': 'https://www.sling.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36',
        'DNT': '1',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Accept': '*/*',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'cors',
        'Referer': 'https://watch.sling.com/watch?type=linear&id=391f339fd05c4487a3091073ee275b77&channelId=8aed8223a6104b53b24f03555fc933a9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
    }
    let headers = Object.assign(newHeaders, this.headers)
    let options = {
      url: widevineUrl,
      body: drmBody,
      json: true,
      encoding: null
    }
    return rp.post(options)
  }

  getMpdInfo (channelId) {
    let infoApi = `http://cbd46b77.cdn.cms.movetv.com/cms/api/channels/${channelId}/schedule/now/playback_info.qvt`
    return rp.get({ url: infoApi, json: true })
  }

  getScheduleJsonHelper () {
    const cacheId = 'sling-schedule'
    return this.redisClient.getAsync(cacheId).then(reply => {
      if (reply) {
        return JSON.parse(reply)
      }
      let newRes = { channels: [] }
      return this.getRawSchedule().then(res => {
        const promises = []
        res.channels.forEach(channel => {
          const options = { url: channel.current_asset, simple: false, json: true }
          promises.push(this.redisClient.getAsync(channel.current_asset).then(assetReply => {
            if (assetReply) {
              if (assetReply !== 'noop') {
                try {
                  newRes.channels.push(JSON.parse(assetReply.toString()))
                } catch (err) {
                  console.log(channel.guid, 'has bad response')
                }
              }
              return true
            }
            return rp.get(options)
              .then(asset => {
                if (asset && asset.title) {
                  channel.assetTitle = asset.title
                }
                if (asset && Array.isArray(asset.schedules) && asset.schedules.length > 0) {
                  const timeLeft = new Date(asset.schedules[0].schedule_end) - new Date()
                  let cacheTime = parseInt(timeLeft / 1000, 10)
                  if (cacheTime > 0) {
                    this.redisClient.setex(channel.current_asset, cacheTime, JSON.stringify(channel))
                    newRes.channels.push(channel)
                  } else {
                    this.redisClient.setex(channel.current_asset, 300, 'noop')
                  }
                } else {
                  this.redisClient.setex(channel.current_asset, 300, 'noop')
                }
              })
          }))
        })
        return Promise.all(promises).then(() => {
          this.redisClient.setex(cacheId, 10, JSON.stringify(newRes))
          return newRes.channels
        })
      })
    })
  }

  getStream (channelId, rewrite = true) {
    return this.redisClient.getAsync(channelId).then(reply => {
      if (reply && !rewrite) {
        return reply.toString()
      } else {
        return this.getMpdInfo(channelId).then(res => {
          return rp.get(res.playback_info.dash_manifest_url).then(dash => {
            if (rewrite) {
              return this.rewriteStream(dash)
            } else {
              let self = this
              return new Promise((resolve, reject) => {
                XmlParser.parseString(dash, function (err, result) {
                  if (err) {
                    reject(err)
                  } else {
                    let currentTime = new Date()
                    let anchor = new Date(res.playback_info.linear_info.anchor_time)
                    let duration = parseFloat(result.MPD.$.mediaPresentationDuration.replace('PT', ''))
                    let cacheTime = duration - (currentTime / 1000 - anchor)
                    cacheTime = parseInt(cacheTime)
                    if (cacheTime > 0) {
                      self.client.setex(channelId, cacheTime, dash)
                    }
                    resolve(dash)
                  }
                })
              })
            }
          })
        })
      }
    })
  }

  rewriteStream (xml) {
    return new Promise((resolve, reject) => {
      XmlParser.parseString(xml, function (err, result) {
        if (err) {
          reject(err)
        } else {
          let currentTime = new Date()
          let startTime = new Date(result.MPD.$.availabilityStartTime)
          let timeDiff = (currentTime - startTime) / 1000
          let segmentDuration = parseFloat(result.MPD.$.maxSegmentDuration.replace('PT', ''))
          if (result.MPD.Period.length === 2) {
            console.log('2 periods')
            let periodStart = parseFloat(result.MPD.Period[1].$.start.replace('PT', ''))
            if (timeDiff >= periodStart) {
              result.MPD.Period.splice(0, 1)
              result.MPD.Period[0].AdaptationSet[0].SegmentTemplate[0].$.startNumber = result.MPD.Period[0].AdaptationSet[0].SegmentTemplate[0].$.startNumber - (periodStart / (segmentDuration / 2))
              result.MPD.Period[0].$.start = 'PT0.000000S'
              result.MPD.Period[0].$.id = '1'
            } else {
              result.MPD.Period.splice(1, 1)
            }
          }
          let period = result.MPD.Period[0]
          let duration = parseFloat(period.$.duration.replace('PT', ''))
          let startNumber = parseInt(period.AdaptationSet[0].SegmentTemplate[0].$.startNumber - (duration / segmentDuration) + (timeDiff / segmentDuration))
          for (let adaptationSet of period.AdaptationSet) {
            adaptationSet.SegmentTemplate[0].$.startNumber = startNumber
          }
          let builder = new XmlJs.Builder()
          resolve(builder.buildObject(result))
        }
      })
    })
  }

  getRawSchedule () {
    const cacheId = 'raw-sling-schedule'
    return this.redisClient.getAsync(cacheId).then(reply => {
      if (reply) {
        return JSON.parse(reply)
      }
      return rp.get({ url: 'http://cbd46b77.cdn.cms.movetv.com/cms/api/channels/', json: true }).then(schedule => {
        this.redisClient.setex(cacheId, 10, JSON.stringify(schedule))
        return schedule
      })
    })
  }

  getExoSchedule (host) {
    let data = []
    let allPromises = []
    return this.getRawSchedule().then(res => {
      let groupedGenres = _.groupBy(res.channels, item => {
        if (item.genre) return item.genre[0]
        return 'Other'
      })
      for (let genre in groupedGenres) {
        let promises = []
        let tempObj = {
          name: genre,
          samples: []
        }
        for (let channel of groupedGenres[genre]) {
          let options = { url: channel.current_asset, simple: false, json: true }
          promises.push(rp.get(options).then(asset => {
            if (asset && asset.title) {
              let item = {
                name: `${channel.channel_name} : ${asset.title}`,
                uri: `${host}/sling/${channel.guid}.mpd?rewrite=false`,
                drm_scheme: 'widevine',
                drm_license_url: `${host}/sling/yGsZQrFlUn`
              }
              tempObj.samples.push(item)
            }
          }))
        }
        allPromises = allPromises.concat(promises)
        Promise.all(promises).then(() => data.push(tempObj))
      }
      return Promise.all(allPromises).then(() => {
        return data
      })
    })
  }

  getSchedule (host) {
    let items = { items: [] }
    return this.getRawSchedule().then(res => {
      for (let channel of res.channels) {
        let thumbnail = channel.image && channel.image.url ? channel.image.url : null
        let genre = Array.isArray(channel.genre) && channel.genre.length > 0 ? channel.genre[0] : 'Other'
        let item = {
          channel: {
            title: Buffer.from(channel.channel_name).toString('base64'),
            stream_url: `${host}/sling/${channel.guid}.mpd`,
            desc_image: thumbnail,
            genre: genre,
            drm: {
              protocol: 'mpd',
              type: 'com.widevine.alpha',
              license_url: `${host}/sling/yGsZQrFlUn`
            },
            description: null,
            category_id: null
          }
        }
        items.items.push(item)
      }
      let builder = new XmlJs.Builder({ cdata: true })
      return builder.buildObject(items)
    })
  }

  getScheduleStatus (host) {
    return this.getScheduleJsonHelper().then(res => {
      if (this.videoManager.config) {
        for (let channel of res) {
          let cacheId = `sling-${channel.guid}`
          channel.active = !!(this.videoManager.config[cacheId] && this.videoManager.config[cacheId].started)
          channel.startTime = this.videoManager.config[cacheId] ? this.videoManager.config[cacheId].startTime : null
        }
      }
      return res
    })
  }

  newRewriteStream (xml) {
    return new Promise((resolve, reject) => {
      XmlParser.parseString(xml, function (err, result) {
        if (err) {
          reject(err)
        } else {
          let builder = new XmlJs.Builder()
          let currentTime = new Date()
          let startTime = new Date(result.MPD.$.availabilityStartTime)
          let timeDiff = (currentTime - startTime) / 1000
          for (let period of result.MPD.Period) {
            let periodStart = parseFloat(period.$.start.replace('PT', ''))
            if (timeDiff <= periodStart) {
              result.MPD.Period = [period]
              result.MPD.Period[0].$.start = 'PT0.000000S'
              result.MPD.Period[0].$.id = '1'
              result.MPD.$.availabilityStartTime = new Date(startTime.getTime() + periodStart * 1000).toISOString()
              resolve(builder.buildObject(result))
              return
            }
          }
          result.MPD.Period = [result.MPD.Period[result.MPD.Period.length - 1]]
          let periodStart = parseFloat(result.MPD.Period[0].$.start.replace('PT', ''))
          result.MPD.Period[0].$.start = 'PT0.000000S'
          result.MPD.Period[0].$.id = '1'
          result.MPD.$.availabilityStartTime = new Date(startTime.getTime() + periodStart * 1000).toISOString()
          result.MPD.$.mediaPresentationDuration = result.MPD.Period[0].$.duration
          resolve(builder.buildObject(result))
        }
      })
    })
  }

  getNewPeriod (channelId, oldBaseUrl) {
    return this.getMpdInfo(channelId).then(res => {
      return rp.get(res.playback_info.dash_manifest_url).then(dash => {
        return new Promise((resolve, reject) => {
          XmlParser.parseString(dash, function (err, result) {
            if (err) {
              reject(err)
            } else {
              for (let [index, period] of result.MPD.Period.entries()) {
                let baseUrl = period.BaseURL[0]._
                if (baseUrl !== oldBaseUrl) {
                  let contentProtection = period.AdaptationSet[0].ContentProtection.find(x => x.$.schemeIdUri === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')
                  let pssh = contentProtection['cenc:pssh'][0]
                  resolve({ period, dash, baseUrl, pssh, index })
                }
              }
            }
            reject(new Error('couldnt find new period'))
          })
        })
      })
    })
  }

  newSegmentParser (xml, lastSegment = null, channelId = null) {
    return new Promise((resolve, reject) => {
      let self = this
      XmlParser.parseString(xml, function (err, result) {
        if (err) {
          reject(err)
        } else {
          let currentTime = new Date()
          let periodIndex = self.config[channelId].periodIndex || 0
          let period = result.MPD.Period[periodIndex]
          let periodStart = parseFloat(period.$.start.replace('PT', ''))
          let startTime = new Date(new Date(result.MPD.$.availabilityStartTime).getTime() + periodStart * 1000)
          let baseUrl = period.BaseURL[0]._
          let startNumber = parseInt(period.AdaptationSet[0].SegmentTemplate[0].$.startNumber)
          let segmentDuration = parseFloat(result.MPD.$.maxSegmentDuration.replace('PT', ''))
          let timeDiff = ((currentTime - startTime) / 1000) - 4.096
          let currentSegment = parseInt(startNumber + (timeDiff / segmentDuration))
          lastSegment = lastSegment || currentSegment - range
          let newPeriodPromise = null
          let newCurrentSegment = null
          if (currentSegment >= turnover) {
            if (lastSegment <= turnover) {
              console.log('switching period')
              newPeriodPromise = self.getNewPeriod(channelId, baseUrl)
              newCurrentSegment = currentSegment % turnover
            } else {
              self.config[channelId].periodIndex = 1
              resolve(self.newSegmentParser(xml, null, channelId))
              return
            }
          }
          let contentProtection = period.AdaptationSet[0].ContentProtection.find(x => x.$.schemeIdUri === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')
          let pssh = contentProtection['cenc:pssh'][0]
          let finalObj = { pssh, currentSegment, baseUrl, xml }
          return Promise.resolve(newPeriodPromise).then(newPeriod => {
            if (newPeriod) {
              finalObj.xml = newPeriod.dash
              finalObj.periodIndex = newPeriod.index
            }
            for (let adaptationSet of period.AdaptationSet) {
              let repId = adaptationSet.Representation[0].$.id
              let segmentTemplate = adaptationSet.SegmentTemplate[0].$.media.replace('$RepresentationID$', repId)
              let initSegment = baseUrl + adaptationSet.SegmentTemplate[0].$.initialization.replace('$RepresentationID$', repId)
              if (adaptationSet.$.contentType === 'audio' && adaptationSet.$.codecs === 'mp4a.40.2') {
                finalObj.audio = {}
                finalObj.audio[pssh] = [initSegment]
                for (let x = lastSegment + 1; x <= currentSegment; x++) {
                  let tempBaseUrl = baseUrl
                  let tempPssh = pssh
                  if (x > turnover) {
                    tempBaseUrl = newPeriod.baseUrl
                    tempPssh = newPeriod.pssh
                    finalObj.audio[tempPssh] = finalObj.audio[tempPssh] || [initSegment.replace(baseUrl, tempBaseUrl)]
                  }
                  let y = x % turnover
                  finalObj.audio[tempPssh].push(tempBaseUrl + segmentTemplate.replace('$Number%08x$', y.toString(16)))
                }
              }
              if (adaptationSet.$.contentType === 'video') {
                finalObj.segments = {}
                finalObj.segments[pssh] = [initSegment]
                for (let x = lastSegment + 1; x <= currentSegment; x++) {
                  let tempBaseUrl = baseUrl
                  let tempPssh = pssh
                  if (x > turnover) {
                    tempBaseUrl = newPeriod.baseUrl
                    tempPssh = newPeriod.pssh
                    finalObj.segments[tempPssh] = finalObj.segments[tempPssh] || [initSegment.replace(baseUrl, tempBaseUrl)]
                  }
                  let y = x % turnover
                  finalObj.segments[tempPssh].push(tempBaseUrl + segmentTemplate.replace('$Number%08x$', y.toString(16)))
                }
              }
            }
            if (newCurrentSegment) finalObj.currentSegment = newCurrentSegment
            resolve(finalObj)
          })
        }
      })
    })
  }

  /* getCurrentPeriod (periods, currentTime, startTime) {
    for (let tempPeriod of periods) {
      let periodStart = parseFloat(tempPeriod.$.start.replace('PT', ''))
      let periodDuration = parseFloat(tempPeriod.$.duration.replace('PT', ''))
      let periodStartTime = new Date(new Date(startTime).getTime() + periodStart * 1000)
      tempPeriod.endTime = periodStartTime.getTime() + periodDuration * 1000
      if (currentTime >= startTime && currentTime < endTime) {
        return tempPeriod
      }
    }
    return null
  }

  newSegmentParserv3 (xml, lastSegment, channelId) {
    return new Promise((resolve, reject) => {
      let self = this
      XmlParser.parseString(xml, async function (err, result) {
        if (err) {
          reject(err)
        } else {
          let currentTime = new Date().getTime()
          let finalObj = {audio: {}, segments: {}}
          while (true) {
            let refresh = false
            if (!self.config[channelId].period) {
              self.config[channelId].period = getCurrentPeriod(result.MPD.Period, currentTime, result.MPD.$.availabilityStartTime)
              if (!self.config[channelId].period) {
                let newPeriodData = await self.getNewPeriod(channelId, self.config[channelId].baseUrl)
                self.config[channelId].period = newPeriodData.period
              }
            } else if (currentTime > self.config[channelId].period.endTime) {
              refresh = true
            }
            let period = self.config[channelId].period
            let baseUrl = period.BaseURL[0]._
            self.config[channelId].baseUrl = baseUrl
            let adaptationSet = period.AdaptationSet[0]
            let repId = adaptationSet.Representation[0].$.id
            let segmentTemplate = adaptationSet.SegmentTemplate[0].$.media.replace('$RepresentationID$', repId)
            let segmentTester = baseUrl + segmentTemplate.replace('$Number%08x$', 11111)
            let testerRes = await rp.get({ uri: segmentTester, json: true })
            let currentSegment = parseInt(/stream end \(0x(.*);/.exec(testerRes.message)[1], 16)
            lastSegment = lastSegment || currentSegment - range
            let contentProtection = period.AdaptationSet[0].ContentProtection.find(x => x.$.schemeIdUri === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')
            let pssh = contentProtection['cenc:pssh'][0]
            for (let adaptationSet of period.AdaptationSet) {
              let repId = adaptationSet.Representation[0].$.id
              let segmentTemplate = adaptationSet.SegmentTemplate[0].$.media.replace('$RepresentationID$', repId)
              let initSegment = baseUrl + adaptationSet.SegmentTemplate[0].$.initialization.replace('$RepresentationID$', repId)
              if (adaptationSet.$.contentType === 'audio' && adaptationSet.$.codecs === 'mp4a.40.2') {
                finalObj.audio[pssh] = [initSegment]
                for (let x = lastSegment + 1; x <= currentSegment; x++) {
                  finalObj.audio[pssh].push(baseUrl + segmentTemplate.replace('$Number%08x$', x.toString(16)))
                }
              }
              if (adaptationSet.$.contentType === 'video') {
                finalObj.segments[pssh] = [initSegment]
                for (let x = lastSegment + 1; x <= currentSegment; x++) {
                  finalObj.segments[pssh].push(baseUrl + segmentTemplate.replace('$Number%08x$', x.toString(16)))
                }
              }
            }
            if (!refresh) break
          }
          resolve(finalObj)
        }
      })
    })
  } */

  getMaxPlaylists (parsedManifest, aCodec = 'en (main)mp4a.40.2') {
    let audioPlaylists = parsedManifest.mediaGroups.AUDIO.audio[aCodec].playlists
    let maxB = 0
    let max = null
    for (let playlist of parsedManifest.playlists) {
      if (playlist.attributes.BANDWIDTH > maxB) {
        maxB = playlist.attributes.BANDWIDTH
        max = playlist
      }
    }
    let maxAudioB = 0
    let maxAudio = null
    for (let playlist of audioPlaylists) {
      if (playlist.attributes.BANDWIDTH > maxAudioB) {
        maxAudioB = playlist.attributes.BANDWIDTH
        maxAudio = playlist
      }
    }
    return { maxAudio, max }
  }

  async newGetSegments (channelId) {
    let cacheId = `content.sling.${channelId}.mpd`
    return this.redisClient.getAsync(cacheId).then(result => {
      let promise = null
      if (result && JSON.parse(result).expiration > new Date().getTime()) {
        let jsonResult = JSON.parse(result)
        promise = mpdParser.parse(jsonResult.xml, jsonResult.url)
      } else {
        promise = this.getMpdInfo(channelId).then(res => {
          let url = res.playback_info.dash_manifest_url
          return rp.get(url).then(async manifest => {
            manifest = await this.newRewriteStream(manifest)
            let parsed = mpdParser.parse(manifest, url)
            let expiration = parseInt(parsed.attributes.sourceDuration - (parsed.attributes.NOW / 1000 - parsed.attributes.availabilityStartTime))
            let expirationDate = new Date()
            expirationDate.setSeconds(expirationDate.getSeconds() + expiration)
            let payload = JSON.stringify({ xml: manifest, url, expiration: expirationDate.getTime() })
            if (expiration > 0) {
              this.redisClient.set(cacheId, payload)
            }
            return parsed
          })
        })
      }
      return Promise.resolve(promise).then(parsedManifest => {
        let playlists = this.getMaxPlaylists(parsedManifest)
        let max = playlists.max
        let pssh = max.contentProtection['com.widevine.alpha'].psshNormal
        let maxAudio = playlists.maxAudio
        let trimmed = max.segments.slice(-Math.abs(range))
        let trimmedAudio = maxAudio.segments.slice(-Math.abs(range))
        let useOld = false
        let oldTrimmed = null
        let oldTrimmedAudio = null
        let oldPssh = null
        if (this.config[channelId].currentSegment) {
          let lastInd = this.findLastIndex(max.segments, 'number', this.config[channelId].currentSegment)
          let grabOld = false
          if (lastInd === -1) {
            lastInd = this.findLastIndex(max.segments, 'number', this.findEarliestSegment(max.segments, 'number').number)
            grabOld = true
          }
          let slicer = -Math.abs(max.segments.length - lastInd - 1)
          trimmed = max.segments.slice(slicer)
          trimmedAudio = maxAudio.segments.slice(slicer)
          if (grabOld) {
            let oldResult = JSON.parse(result)
            let oldParsed = mpdParser.parse(this.newRewriteStream(oldResult.xml), oldResult.url)
            let oldPlaylists = this.getMaxPlaylists(oldParsed)
            let oldMax = oldPlaylists.max
            let oldPssh = max.contentProtection['com.widevine.alpha'].psshNormal
            let oldMaxAudio = oldPlaylists.maxAudio
            let oldLastInd = this.findLastIndex(oldMax.segments, 'number', this.config[channelId].currentSegment)
            let oldSlicer = -Math.abs(oldMax.segments.length - oldLastInd - 1)
            let oldTrimmed = oldMax.segments.slice(oldSlicer)
            let oldTrimmedAudio = oldMaxAudio.segments.slice(oldSlicer)
            if (oldPssh === pssh) {
              trimmed = oldTrimmed.concat(trimmed)
              trimmedAudio = oldTrimmedAudio.concat(trimmedAudio)
            } else {
              useOld = true
            }
          }
        }
        let segments = [trimmed[0].map.resolvedUri]
        let audio = [trimmedAudio[0].map.resolvedUri]
        for (let segment of trimmed) {
          segments.push(segment.resolvedUri.replace('$Number%08x$', segment.number.toString(16)))
        }
        for (let segmentAudio of trimmedAudio) {
          audio.push(segmentAudio.resolvedUri.replace('$Number%08x$', segmentAudio.number.toString(16)))
        }
        this.config[channelId].currentSegment = trimmed[trimmed.length - 1].number
        let finalObj = { segments: {}, audio: {} }
        if (useOld) {
          let oldSegments = [oldTrimmed[0].map.resolvedUri]
          let oldAudio = [oldTrimmedAudio[0].map.resolvedUri]
          for (let oldSegment of oldTrimmed) {
            oldSegments.push(oldSegment.resolvedUri.replace('$Number%08x$', oldSegment.number.toString(16)))
          }
          for (let oldSegmentAudio of oldTrimmedAudio) {
            oldAudio.push(oldSegmentAudio.resolvedUri.replace('$Number%08x$', oldSegmentAudio.number.toString(16)))
          }
          finalObj.segments[oldPssh] = oldSegments
          finalObj.audio[oldPssh] = oldAudio
        }
        finalObj.segments[pssh] = segments
        finalObj.audio[pssh] = audio
        return finalObj
      })
    })
  }

  findTestCases () {
    console.log('working?')
    this.getRawSchedule().then(sched => {
      console.log(sched.channels)
      for (let channel of sched.channels) {
        this.getMpdInfo(channel.guid).then(res => {
          let url = res.playback_info.dash_manifest_url
          rp.get(url).then(dash => {
            XmlParser.parseString(dash, function (err, result) {
              if (err) {
                // console.log(err)
              } else {
                if (result.MPD.Period.length > 1) {
                  console.log('more perd', channel.guid)
                }
                // let currentTime = new Date().getTime()
                // let period = result.MPD.Period[0]
                // let periodStart = parseFloat(period.$.start.replace('PT', ''))
                // let startTime = new Date(new Date(result.MPD.$.availabilityStartTime).getTime() + periodStart * 1000)
                // let startNumber = parseInt(period.AdaptationSet[0].SegmentTemplate[0].$.startNumber)
                // let segmentDuration = parseFloat(result.MPD.$.maxSegmentDuration.replace('PT', ''))
                // let timeDiff = (currentTime - startTime) / 1000
                // let currentSegment = parseInt(startNumber + (timeDiff / segmentDuration))
                /* if (currentSegment > 40000) {
                  console.log(currentSegment, channel.guid)
                } */
                if (!res.playback_info.clips || res.playback_info.clips.length === 0) {
                  console.log('no clips', channel.guid)
                }
                for (let clip of res.playback_info.clips) {
                  if (!clip.location) {
                    console.log('no clip location', channel.guid, clip)
                  }
                }
              }
            })
          }).catch(() => {})
        }).catch(() => {})
      }
    })
  }

  getSegments () {
    let self = this
    return function processSegments (id) {
      let channelId = id.split('-')[1]
      let promise = null
      let manifest = null
      let currentSegment = null
      self.config[channelId] = self.config[channelId] || {}
      if (self.config[channelId].xml) {
        manifest = self.config[channelId].xml
        currentSegment = self.config[channelId].currentSegment
      } else {
        promise = self.getMpdInfo(channelId).then(res => {
          let url = res.playback_info.dash_manifest_url
          return rp.get(url)
        })
      }
      return Promise.resolve(promise).then(newManifest => {
        manifest = manifest || newManifest
        return self.newSegmentParser(manifest, currentSegment, channelId).then(result => {
          self.config[channelId].xml = result.xml
          self.config[channelId].currentSegment = result.currentSegment
          if (result.periodIndex) self.config[channelId].periodIndex = result.periodIndex
          return { audio: result.audio, segments: result.segments, pssh: result.pssh }
        })
      })
    }
  }

  periodParserForQmx (xml, qmxId) {
    return new Promise((resolve, reject) => {
      XmlParser.parseString(xml, async function (err, result) {
        if (err) {
          reject(err)
        } else {
          resolve(result.MPD.Period.find(x => x.BaseURL[0]._.includes(qmxId)))
        }
      })
    })
  }

  qmxReq (url) {
    return promiseRetry({ retries: 3 }, (retry, number) => {
      return fetch(url, { timeout: 1000, method: 'GET', headers: { 'accept-encoding': 'gzip, deflate' } })
        .then(res => res.json())
        .catch(retry)
    })
  }

  getSegmentsv3 () {
    let self = this
    return async function processSegments (id, finalObj = null) {
      let channelId = id.split('-')[1]
      let period = await self.redisClient.getAsync(`video.${id}.period`)
      let qmxUrl = await self.redisClient.getAsync(`video.${id}.qmxUrl`)
      let dash = null
      if (!period) {
        let mpdInfo = await self.getMpdInfo(channelId)
        dash = await rp.get(mpdInfo.playback_info.dash_manifest_url)
        let noClip = true
        for (let clip of mpdInfo.playback_info.clips) {
          if (clip.location && clip.location !== qmxUrl) {
            let qmxData = await self.qmxReq(clip.location)
            if (qmxData.live) {
              qmxUrl = clip.location
              self.redisClient.set(`video.${id}.qmxUrl`, qmxUrl)
              period = await self.periodParserForQmx(dash, qmxData.ucid)
              if (!period) throw new Error('no period! ' + dash + qmxData.ucid)
              self.redisClient.set(`video.${id}.period`, JSON.stringify(period))
              noClip = false
              break
            }
          }
        }
        if (noClip) console.error('couldn\'t find a clip', mpdInfo.playback_info.clips, qmxUrl)
      } else {
        period = JSON.parse(period)
      }
      let qmx = await self.qmxReq(qmxUrl)
      let currentSegment = qmx.segment_info.stop
      let lastSegmentCache = await self.redisClient.getAsync(`video.${id}.lastSegment`)
      lastSegmentCache = typeof lastSegmentCache === 'string' ? parseInt(lastSegmentCache) : lastSegmentCache
      let lastSegment = lastSegmentCache || currentSegment - range
      if (lastSegment < 0) throw new Error('last segment is less than 0!')
      self.redisClient.set(`video.${id}.lastSegment`, currentSegment)

      let baseUrl = period.BaseURL[0]._
      let contentProtection = period.AdaptationSet[0].ContentProtection.find(x => x.$.schemeIdUri === 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')
      let pssh = contentProtection['cenc:pssh'][0]
      finalObj = finalObj || { audio: {}, segments: {} }
      for (let adaptationSet of period.AdaptationSet) {
        let repId = adaptationSet.Representation[0].$.id
        let segmentTemplate = adaptationSet.SegmentTemplate[0].$.media.replace('$RepresentationID$', repId)
        let initSegment = baseUrl + adaptationSet.SegmentTemplate[0].$.initialization.replace('$RepresentationID$', repId)
        if (adaptationSet.$.contentType === 'audio' && adaptationSet.$.codecs === 'mp4a.40.2') {
          finalObj.audio[pssh] = [initSegment]
          for (let x = lastSegment + 1; x <= currentSegment; x++) {
            finalObj.audio[pssh].push(baseUrl + segmentTemplate.replace('$Number%08x$', x.toString(16)))
          }
        }
        if (adaptationSet.$.contentType === 'video') {
          finalObj.segments[pssh] = [initSegment]
          for (let x = lastSegment + 1; x <= currentSegment; x++) {
            finalObj.segments[pssh].push(baseUrl + segmentTemplate.replace('$Number%08x$', x.toString(16)))
          }
        }
      }
      if (!qmx.live) {
        self.redisClient.del(`video.${id}.period`)
        await self.redisClient.setAsync(`video.${id}.lastSegment`, 0)
        let segmentParser = self.getSegmentsv3()
        finalObj = await segmentParser(id, finalObj)
      }
      return Promise.resolve(finalObj)
    }
  }
}

module.exports = SlingManager
