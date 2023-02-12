// const fetch = require('node-fetch')
const fs = require('fs-extra')
// const exec = require('child_process').exec
const execPromise = require('child-process-promise').exec
var spawn = require('child_process').spawn
const fg = require('fast-glob')
const XmlJs = require('xml2js')
const XmlParser = new XmlJs.Parser()
let builder = new XmlJs.Builder()
const url = require('url')
const mpdParser = require('mpd-parser')
const rp = require('request-promise')
const path = require('path')
const mkdirp = require('mkdirp')
const rimraf = require('rimraf')
const querystring = require('querystring')
const box = require('mp4-box-encoding')
const download = require('download')

var opsys = process.platform
let mp4decrypt = 'binaries/linux/mp4decrypt'
let decrypter = 'binaries/linux/foobar'
if (opsys === 'darwin') {
  decrypter = 'binaries/mac/foobar'
} else if (opsys === 'win32' || opsys === 'win64') {
  console.error('FUCK NOT SUPPORTED YET')
} else if (opsys === 'linux') {
  decrypter = 'binaries/linux/foobar'
  mp4decrypt = 'binaries/linux/mp4decrypt'
}
const videoDir = 'video'
const publicDir = 'public'

class VideoManager {
  constructor (util, redisClient, bufferRedisClient) {
    this.redisClient = redisClient
    this.bufferRedisClient = bufferRedisClient
    this.util = util
    this.config = {}
    /* setInterval(() => {
      this.deleteOldFiles('video')
      this.deleteOldFiles('public')
    }, 120000) */
  }

  testMpd () {
    let mpd = 'http://p-cdn1-802-cg14-linear-cbd46b77.movetv.com/cms/publish3/container/scheduleqvt/5b23df86e8dc45fa9880c5c01664a93d.mpd'
    return rp.get(mpd).then(manifest => {
      return mpdParser.parse(manifest, mpd)
    })
  }

  parseMpd (manifest, mpd) {
    let command = `node -e "console.log(JSON.stringify(require('mpd-parser').b64Parse('${Buffer.from(manifest).toString('base64')}', '${mpd}')))"`
    return execPromise(command, { maxBuffer: 1024 * 100000 }).then(resp => {
      return JSON.parse(resp.stdout)
    })
  }

  async decryptMpd (mpd) {
    let manifest = await rp.get({ uri: mpd })
    let parsedManifest = await new Promise((resolve, reject) => {
      XmlParser.parseString(manifest, function (err, result) {
        if (err) {
          reject(err)
        } else {
          resolve(result)
        }
      })
    })
    parsedManifest.MPD = Object.assign({ BaseURL: 'http://example.com' }, parsedManifest.MPD)
    for (let period of parsedManifest.MPD.Period) {
      for (let adaptationSet of period.AdaptationSet) {
        let baseUrl = adaptationSet.BaseURL || period.BaseURL || parsedManifest.MPD.BaseURL || mpd
        if (Array.isArray(baseUrl)) baseUrl = baseUrl[0]._
        delete adaptationSet.ContentProtection
        adaptationSet.SegmentTemplate[0].$.initialization = url.resolve(baseUrl, adaptationSet.SegmentTemplate[0].$.initialization)
        adaptationSet.SegmentTemplate[0].$.media = url.resolve(baseUrl, adaptationSet.SegmentTemplate[0].$.media)
      }
    }
    return builder.buildObject(parsedManifest)
  }

  getPssh (init) {
    let buffer = fs.readFileSync(init)
    let moov = box.decodeWithoutHeaders({ type: 'moof' }, buffer)
    let rawPssh = moov.otherBoxes[1].otherBoxes[1].buffer.toString('base64')
    return 'CAES' + rawPssh.split('CAES')[1]
  }

  async getDecryptionKeys (pssh, licenseUrl) {
    let cache = await this.redisClient.getAsync(pssh)
    if (cache) return JSON.parse(cache)
    let command = `${decrypter} -p ${pssh} -l "${licenseUrl}"`
    return execPromise(command).then(response => {
      let responseLines = response.stdout.split('\n')
      let keyArr = []
      for (let line of responseLines) {
        if (line.includes(' : ')) {
          let rawKey = line.split(' : ')[1].trim().split(':')
          if (rawKey.length > 1 && rawKey[1].length === 32) keyArr.push(rawKey[1])
        }
      }
      if (keyArr.length > 0) this.redisClient.set(pssh, JSON.stringify(keyArr))
      else console.warn(`no keys found for ${pssh} @ ${licenseUrl}`)
      return keyArr
    })
  }

  async mpdToHLSManifest (mpd, licenseUrl, bandwidthIndex = 0, returnObj = false) {
    let manifest = await rp.get({ uri: mpd, followAllRedirects: true, resolveWithFullResponse: true })
    mpd = url.format(manifest.request.uri)
    manifest = manifest.body
    this.config[mpd] = this.config[mpd] || {}
    let parsedManifest = await this.parseMpd(manifest, mpd)
    let variantArr = { audio: [], video: [] }
    let template = ['#EXTM3U']
    let audio = Object.keys(parsedManifest.mediaGroups.AUDIO.audio).find(x => parsedManifest.mediaGroups.AUDIO.audio[x].playlists[0].attributes.CODECS.includes('mp4a.40')) || Object.keys(parsedManifest.mediaGroups.AUDIO.audio)[0]
    console.log(audio)
    let audioPlaylist = parsedManifest.mediaGroups.AUDIO.audio[audio].playlists[0]
    let isDefault = parsedManifest.mediaGroups.AUDIO.audio[audio].default ? 'YES' : 'NO'
    let qs = {
      mpd,
      bandwidth: audioPlaylist.attributes.BANDWIDTH,
      audio,
      licenseUrl
    }
    let variantUri = `variant.m3u8?${querystring.stringify(qs)}`
    variantArr.audio.push(variantUri)
    template.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${parsedManifest.mediaGroups.AUDIO.audio[audio].language || 'en'}",NAME="${parsedManifest.mediaGroups.AUDIO.audio[audio].language || 'en'}",AUTOSELECT=YES, DEFAULT=${isDefault},URI="${variantUri}"`)
    parsedManifest.playlists = parsedManifest.playlists.sort((a, b) => (a.BANDWIDTH > b.BANDWIDTH) ? 1 : ((b.BANDWIDTH > a.BANDWIDTH) ? -1 : 0)).reverse()
    let playlists = []
    if (!isNaN(bandwidthIndex)) {
      let maxIndex = parsedManifest.playlists.length - 1
      bandwidthIndex = Math.min(bandwidthIndex, maxIndex)
      playlists = [parsedManifest.playlists[bandwidthIndex]]
    } else {
      playlists = parsedManifest.playlists
    }
    for (let playlist of playlists) {
      let attributes = playlist.attributes
      let bandwidth = attributes.BANDWIDTH
      let resolution = attributes.RESOLUTION.width + 'x' + attributes.RESOLUTION.height
      /* eslint no-eval: 0 */
      let frameRate = (Math.round(eval(attributes.FRAMERATE) * 100) / 100)
      let frameRateString = frameRate ? `FRAME-RATE=${frameRate},` : ''
      let codec = attributes.CODECS
      let qs = {
        mpd,
        bandwidth,
        licenseUrl
      }
      let variantUri = `variant.m3u8?${querystring.stringify(qs)}`
      variantArr.video.push(variantUri)
      template.push(`#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="${codec}",${frameRateString}AUDIO="audio"
${variantUri}`)
    }
    let returner = !returnObj ? Promise.resolve(template.join('\n')) : variantArr
    return returner
  }

  async mpdToHLSManifestV1 (mpd, licenseUrl, bandwidthIndex = 0, jsonHeaders = null) {
    let headers = jsonHeaders ? JSON.parse(jsonHeaders) : undefined
    let manifest = await rp.get({ uri: mpd, headers, followAllRedirects: true, resolveWithFullResponse: true })
    mpd = url.format(manifest.request.uri)
    manifest = manifest.body
    this.config[mpd] = this.config[mpd] || {}
    let parsedManifest = mpdParser.parse(manifest, mpd)
    let template = ['#EXTM3U']
    let audio = Object.keys(parsedManifest.mediaGroups.AUDIO.audio).find(x => parsedManifest.mediaGroups.AUDIO.audio[x].playlists[0].attributes.CODECS.includes('mp4a.40')) || Object.keys(parsedManifest.mediaGroups.AUDIO.audio)[0]
    let audioPlaylist = parsedManifest.mediaGroups.AUDIO.audio[audio].playlists[0]
    let isDefault = parsedManifest.mediaGroups.AUDIO.audio[audio].default ? 'YES' : 'NO'
    let qs = {
      mpd,
      headers: jsonHeaders,
      bandwidth: audioPlaylist.attributes.BANDWIDTH,
      audio,
      licenseUrl
    }
    template.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${parsedManifest.mediaGroups.AUDIO.audio[audio].language || 'en'}",NAME="${parsedManifest.mediaGroups.AUDIO.audio[audio].language || 'en'}",AUTOSELECT=YES, DEFAULT=${isDefault},URI="variant.m3u8?${querystring.stringify(qs)}"`)
    parsedManifest.playlists = parsedManifest.playlists.sort((a, b) => (a.attributes.BANDWIDTH > b.attributes.BANDWIDTH) ? 1 : ((b.attributes.BANDWIDTH > a.attributes.BANDWIDTH) ? -1 : 0)).reverse()
    let playlists = []
    if (!isNaN(bandwidthIndex)) {
      let maxIndex = parsedManifest.playlists.length - 1
      bandwidthIndex = Math.min(bandwidthIndex, maxIndex)
      playlists = [parsedManifest.playlists[bandwidthIndex]]
    } else {
      playlists = parsedManifest.playlists
    }
    for (let playlist of playlists) {
      let attributes = playlist.attributes
      let bandwidth = attributes.BANDWIDTH
      let resolution = attributes.RESOLUTION.width + 'x' + attributes.RESOLUTION.height
      /* eslint no-eval: 0 */
      let frameRate = (Math.round(eval(attributes.FRAMERATE) * 100) / 100).toString()
      let codec = attributes.CODECS
      let qs = {
        mpd,
        headers: jsonHeaders,
        bandwidth,
        licenseUrl
      }
      template.push(`#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="${codec}",FRAME-RATE=${frameRate},AUDIO="audio"
variant.m3u8?${querystring.stringify(qs)}`)
    }
    return Promise.resolve(template.join('\n'))
  }

  getKeyString (keys) {
    let keyStringArr = []
    for (let [index, key] of keys.entries()) {
      keyStringArr.push(`--key ${index + 1}:${key}`)
    }
    return keyStringArr.join(' ')
  }

  async audioVideoM3u8 (mpd, licenseUrl, bandwidthIndex = 0, checkDTS = false) {
    this.config[mpd] = this.config[mpd] || {}
    let m3u8Dir = `public/${this.util.getMD5(mpd)}.m3u8`
    if (this.config[mpd].started) return m3u8Dir
    this.config[mpd].started = true
    let data = await this.mpdToHLSManifest(mpd, licenseUrl, bandwidthIndex, true)
    let ffmpegCommand = `ffmpeg -loglevel warning -i http://localhost:3001/video/${data.video[0]} -i http://localhost:3001/video/${data.audio[0]} -c:v copy -c:a aac -strict experimental -map 1:a:0 -map 0:v:0 -hls_time 6 -hls_list_size 10 -hls_flags delete_segments+append_list+omit_endlist -f hls ${m3u8Dir}`
    let ffmpegSpawn = ffmpegCommand.split(' ')
    let ffmpegHead = ffmpegSpawn.shift()
    console.log(ffmpegHead, ffmpegSpawn)
    let ffmpegRun = spawn(ffmpegHead, ffmpegSpawn)
    ffmpegRun.stdout.on('data', data => {
      let output = data.toString()
      console.log('stdout: ' + output)
      if (checkDTS && output.includes(' DTS ')) {
        this.config[mpd].started = false
        console.err('DTS error, restarting stream')
        ffmpegRun.kill()
        this.audioVideoM3u8(mpd, licenseUrl, bandwidthIndex, checkDTS)
      }
    })
    ffmpegRun.stderr.on('data', data => {
      let output = data.toString()
      console.log('stdout: ' + output)
      if (checkDTS && output.includes(' DTS ')) {
        this.config[mpd].started = false
        console.err('DTS error, restarting stream')
        ffmpegRun.kill()
        this.audioVideoM3u8(mpd, licenseUrl, bandwidthIndex, checkDTS)
      }
    })
    ffmpegRun.on('exit', code => {
      this.config[mpd].started = false
      console.log('child process exited with code ' + code.toString())
    })
    await new Promise((resolve, reject) => setTimeout(resolve, 20000))
    return m3u8Dir
  }

  async mpdToHLSVariantV2 (bandwidth, mpd, audio = null, licenseUrl, buildCache = true) {
    let manifest = await rp.get({ uri: mpd, followAllRedirects: true, resolveWithFullResponse: true })
    mpd = url.format(manifest.request.uri)
    manifest = manifest.body
    this.config[mpd] = this.config[mpd] || {}
    audio = audio || ''
    let subId = audio + bandwidth
    this.config[mpd][subId] = this.config[mpd][subId] || {}
    let parsedManifest = await this.parseMpd(manifest, mpd)
    let playlists = audio ? parsedManifest.mediaGroups.AUDIO.audio[audio].playlists : parsedManifest.playlists
    let max = playlists.find(x => x.attributes.BANDWIDTH === parseInt(bandwidth)) || playlists[0]
    this.config[mpd][subId].pssh = max.contentProtection['com.widevine.alpha'].psshNormal
    let keys = []
    if (!this.config[mpd][subId].decryptedInit) {
      let initVideo = url.resolve(mpd, max.segments[0].map.uri)
      this.config[mpd][subId].init = `video/${this.util.randomFileName('.mp4')}`
      await download(initVideo, path.dirname(this.config[mpd][subId].init), { filename: path.basename(this.config[mpd][subId].init) })
      this.config[mpd][subId].decryptedInit = this.util.randomFileName('.mp4')
      if (!this.config[mpd][subId].pssh) this.config[mpd][subId].pssh = await this.getPssh(this.config[mpd][subId].init)
      keys = await this.getDecryptionKeys(this.config[mpd][subId].pssh, licenseUrl)
      let command = `${mp4decrypt} ${this.getKeyString(keys)} ${this.config[mpd][subId].init} public/${this.config[mpd][subId].decryptedInit}`
      await execPromise(command)
    } else {
      if (!this.config[mpd][subId].pssh) this.config[mpd][subId].pssh = await this.getPssh(this.config[mpd][subId].init)
      keys = await this.getDecryptionKeys(this.config[mpd][subId].pssh, licenseUrl)
    }

    let template = []
    this.config[mpd][subId].segmentMap = this.config[mpd][subId].segmentMap || {}
    var segmentArr = Object.keys(this.config[mpd][subId].segmentMap).map(key => {
      return this.config[mpd][subId].segmentMap[key]
    })
    let segmentIndex = 0
    if (segmentArr.length > 0) {
      segmentIndex = Math.max(0, ...segmentArr) + 1
    }
    let cutoffSeconds = 80
    let avgLength = max.targetDuration
    let cutOffSegment = max.segments.length - (cutoffSeconds / avgLength)
    let trimmed = cutOffSegment > 0 ? max.segments.slice(cutOffSegment, max.segments.length - 1) : max.segments
    let latencySeconds = 0
    let latencySegment = trimmed.length - (latencySeconds / avgLength)
    let latencySegments = trimmed.slice(0, latencySegment)
    if (buildCache) {
      let cacheSegments = []
      for (let segment of trimmed) {
        let segmentUrl = url.resolve(mpd, segment.uri)
        let segmentFile = 'video/segment-' + this.util.getMD5(segmentUrl) + '.m4s'
        if (!fs.existsSync(segmentFile)) {
          cacheSegments.push([segmentUrl, segmentFile])
          // download(segmentUrl, path.dirname(segmentFile), { filename: path.basename(segmentFile) })
        }
      }
      let m4sFiles = []
      for (let segment of cacheSegments) {
        m4sFiles.push(`${segment[0]}\n\tout=${segment[1]}`)
      }
      if (m4sFiles.length > 0) {
        let urlFile = `video/${this.util.randomFileName('.txt')}`
        fs.writeFileSync(urlFile, m4sFiles.join('\n'))
        execPromise(`aria2c -i ${urlFile}`, { maxBuffer: 1024 * 500 }).then(() => {
          fs.unlink(urlFile)
        })
      }
    }
    // return segments with latency
    for (let segment of latencySegments) {
      let segmentUrl = url.resolve(mpd, segment.uri)
      if (!this.config[mpd][subId].segmentMap[segmentUrl]) {
        this.config[mpd][subId].segmentMap[segmentUrl] = segmentIndex
        segmentIndex++
      }
      if (template.length === 0) {
        template.push(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA-SEQUENCE:${this.config[mpd][subId].segmentMap[segmentUrl]}
#EXT-X-TARGETDURATION:${avgLength}
#EXT-X-MAP:URI="/dev/${this.config[mpd][subId].decryptedInit}"`)
      }
      let qs = {
        url: segmentUrl,
        key: keys.join(','),
        init: this.config[mpd][subId].init,
        audio: audio
      }
      let segmentTemplate = `#EXTINF:${segment.duration},
downloader.m4s?${querystring.stringify(qs)}`
      template.push(segmentTemplate)
    }
    let m3u8 = template.join('\n')
    return Promise.resolve(m3u8)
  }

  async mpdToHLSVariantV1 (bandwidth, mpd, audio = null, licenseUrl, jsonHeaders = null) {
    let headers = jsonHeaders ? JSON.parse(jsonHeaders) : undefined
    let manifest = await rp.get({ uri: mpd, headers, followAllRedirects: true, resolveWithFullResponse: true })
    mpd = url.format(manifest.request.uri)
    manifest = manifest.body
    this.config[mpd] = this.config[mpd] || {}
    audio = audio || ''
    let subId = audio + bandwidth
    this.config[mpd][subId] = this.config[mpd][subId] || {}
    let parsedManifest = mpdParser.parse(manifest, mpd)
    let playlists = audio ? parsedManifest.mediaGroups.AUDIO.audio[audio].playlists : parsedManifest.playlists
    let max = playlists.find(x => x.attributes.BANDWIDTH === parseInt(bandwidth)) || playlists[0]
    let initVideo = url.resolve(mpd, max.segments[0].map.uri)
    let keys = []
    let initFile = `video/${this.util.getMD5(initVideo)}.mp4`
    let decryptedInitFile = `decrypted_${this.util.getMD5(initVideo)}.mp4`
    if (max.contentProtection) {
      if (!fs.existsSync(initFile)) {
        let initData = await rp.get(initVideo, { headers, encoding: null })
        fs.writeFileSync(initFile, initData)
      }
      if (!fs.existsSync(`public/${decryptedInitFile}`)) {
        let command = `${mp4decrypt} ${this.getKeyString(keys)} ${initFile} public/${decryptedInitFile}`
        await execPromise(command)
      }
      let pssh = max.contentProtection['com.widevine.alpha'].psshNormal || await this.getPssh(initFile)
      keys = await this.getDecryptionKeys(pssh, licenseUrl)
    }

    let template = []
    this.config[mpd][subId].segmentMap = this.config[mpd][subId].segmentMap || {}
    var segmentArr = Object.keys(this.config[mpd][subId].segmentMap).map(key => {
      return this.config[mpd][subId].segmentMap[key]
    })
    let segmentIndex = 0
    if (segmentArr.length > 0) {
      segmentIndex = Math.max(0, ...segmentArr) + 1
    }
    let cutoffSeconds = 60
    let avgLength = parseInt(parsedManifest.minimumUpdatePeriod / 1000)
    let cutOffSegment = max.segments.length - (cutoffSeconds / avgLength)
    let trimmed = cutOffSegment > 0 ? max.segments.slice(cutOffSegment, max.segments.length - 1) : max.segments
    for (let segment of trimmed) {
      let segmentUrl = url.resolve(mpd, segment.uri)
      if (!this.config[mpd][subId].segmentMap[segmentUrl]) {
        this.config[mpd][subId].segmentMap[segmentUrl] = segmentIndex
        segmentIndex++
      }
      if (template.length === 0) {
        let initUri = max.contentProtection ? `/dev/${decryptedInitFile}` : initVideo
        template.push(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA-SEQUENCE:${this.config[mpd][subId].segmentMap[segmentUrl]}
#EXT-X-TARGETDURATION:${parseInt(parsedManifest.minimumUpdatePeriod / 1000)}
#EXT-X-MAP:URI="${initUri}"`)
      }
      let newSegmentUri = segmentUrl
      if (max.contentProtection) {
        let qs = {
          url: segmentUrl,
          key: keys.join(','),
          init: initFile,
          audio: audio,
          headers: jsonHeaders
        }
        newSegmentUri = `downloader.m4s?${querystring.stringify(qs)}`
      }
      let segmentTemplate = `#EXTINF:${segment.duration},
${newSegmentUri}`
      template.push(segmentTemplate)
    }
    let m3u8 = template.join('\n')
    return Promise.resolve(m3u8)
  }

  async downloaderV2 (init, key, url, audio = null, returnBuffer = true) {
    let segDir = `video/segment-${this.util.getMD5(url)}.m4s`
    let decryptedSegDir = `public/segment-${this.util.randomFileName('.m4s')}`
    let cache = fs.existsSync(segDir)
    if (!cache) {
      let startTime = new Date()
      await download(url, path.dirname(segDir), { filename: path.basename(segDir) })
      console.log(`we had to redownload ${url}, ${new Date() - startTime}`)
    }
    let keys = key.split(',')
    keys = audio ? [keys[keys.length - 1]] : keys
    let command = `${mp4decrypt} ${this.getKeyString(keys)} --fragments-info ${init} ${segDir} ${decryptedSegDir}`
    await execPromise(command)
    if (!returnBuffer) return decryptedSegDir
    return fs.readFileSync(decryptedSegDir)
  }

  async downloaderV1 (init, key, url, audio = null, jsonHeaders = null) {
    let headers = jsonHeaders ? JSON.parse(jsonHeaders) : undefined
    let segDir = `video/${this.util.randomFileName('.m4s')}`
    let decryptedSegDir = `video/${this.util.randomFileName('.m4s')}`
    let segment = await rp.get(url, { headers, encoding: null })
    fs.writeFileSync(segDir, segment)
    let keys = key.split(',')
    keys = audio ? [keys[keys.length - 1]] : keys
    let command = `${mp4decrypt} ${this.getKeyString(keys)} --fragments-info ${init} ${segDir} ${decryptedSegDir}`
    await execPromise(command)
    let segData = fs.readFileSync(decryptedSegDir)
    fs.unlink(decryptedSegDir)
    fs.unlink(segDir)
    return Promise.resolve(segData)
  }

  deleteOldFiles (dir, expireTime = 86400, prefix = 'segment-') {
    fs.readdir(dir, (err, files) => {
      if (err) console.log(err)
      files.forEach((file, index) => {
        fs.stat(path.join(dir, file), (err, stat) => {
          var endTime, now
          if (err) {
            return console.error(err)
          }
          now = new Date().getTime()
          endTime = new Date(stat.ctime).getTime() + expireTime
          if (now > endTime && (!prefix || file.startsWith(prefix))) {
            return rimraf(path.join(dir, file), (err) => {
              if (err) {
                return console.error(err)
              }
              console.log('successfully deleted')
            })
          }
        })
      })
    })
  }

  async getDecrypted (inputs, rootDir, licenseUrl) {
    let promises = []
    for (let input of inputs) {
      let inputContent = input.filename
      let pssh = input.pssh
      inputContent = path.resolve(inputContent)
      let outputContent = `${rootDir}/${this.util.randomFileName('.mp4')}`
      mkdirp.sync(rootDir)
      let promise = null
      let cacheId = `${pssh}`
      let key = await this.redisClient.getAsync(cacheId)
      if (!key) {
        let command = `${decrypter} -p ${pssh} -l ${licenseUrl}`
        promise = execPromise(command).then(response => {
          let keyData = response.stdout.split(':')
          let key = keyData[keyData.length - 1].trim()
          this.redisClient.set(cacheId, key)
          return key
        })
      } else {
        promise = Promise.resolve(key)
      }
      promises.push(promise.then(key => {
        let decryptCommand = `${mp4decrypt} --key 1:${key} --key 2:${key} ${inputContent} ${outputContent}`
        return execPromise(decryptCommand).then(() => {
          fs.unlink(inputContent)
          return outputContent
        })
      }))
    }
    return Promise.all(promises).then(files => {
      if (files.length === 1) return files[0]
      let finalOutput = `${rootDir}/${this.util.randomFileName('.mp4')}`
      if (files.length > 1) {
        return execPromise(`MP4Box -add ${files[0]} -cat ${files[1]} ${finalOutput}`).then(() => {
          fs.unlink(files[0])
          fs.unlink(files[1])
          return finalOutput
        })
      }
    })
  }

  concatFiles (files, newFileName) {
    let catString = files.join(' ')
    return execPromise(`cat ${catString} > ${newFileName}`)
  }

  async buildEncrypted (segments, baseDir, useLocal = false) {
    let promises = []
    mkdirp.sync(baseDir)
    for (let pssh in segments) {
      let dir = null
      let m4sFiles = segments[pssh]
      let filename = `${baseDir}/${this.util.randomFileName('.mp4')}`
      if (!useLocal) {
        let urlFile = `${baseDir}/${this.util.randomFileName('.txt')}`
        dir = `${baseDir}/${this.util.randomFileName()}`
        fs.writeFileSync(urlFile, m4sFiles.join('\n'))
        let ariaCommand = `mkdir ${dir} && aria2c -i ${urlFile} --dir ${dir}`
        await execPromise(ariaCommand, { maxBuffer: 1024 * 500 })
        fs.unlink(urlFile)
        m4sFiles = await fg([`${dir}/*`])
        m4sFiles.unshift(m4sFiles.pop())
      }
      await this.concatFiles(m4sFiles, filename)
      for (let file of m4sFiles) fs.unlink(file)
      if (dir) fs.remove(dir)
      promises.push(Promise.resolve({ pssh, filename }))
    }
    return Promise.all(promises)
  }

  /* async buildEncrypted (segments, baseDir, dir = null) {
      let promises = []
      mkdirp.sync(baseDir)
      for (let pssh in segments) {
        let filename = `${baseDir}/${this.util.randomFileName('.mp4')}`
        let urlFile = `${baseDir}/${this.util.randomFileName('.txt')}`
        dir = dir || `${baseDir}/${this.util.randomFileName()}`
        fs.writeFileSync(urlFile, segments[pssh].join('\n'))
        let command = `aria2c -i ${urlFile} --dir ${dir}`
        promises.push(execPromise(command, { maxBuffer: 1024 * 500 }).then(async () => {
          let m4sFiles = await fg([`${dir}/*.m4s`])
          await concat(m4sFiles, filename)
          fs.unlink(urlFile)
          fs.remove(dir)
          return { pssh, filename }
        }))
      }
      return Promise.all(promises)
    }
    */

  build (id, licenseUrl, segmentParser, useLocal) {
    return segmentParser(id).then(segments => {
      let promise1 = this.buildEncrypted(segments.segments, `${videoDir}/${id}`, useLocal).then(newFiles => {
        return this.getDecrypted(newFiles, `${videoDir}/${id}/video`, licenseUrl)
      })
      let promise2 = this.buildEncrypted(segments.audio, `${videoDir}/${id}`, useLocal).then(newFiles => {
        return this.getDecrypted(newFiles, `${videoDir}/${id}/audio`, licenseUrl)
      })
      return Promise.all([promise1, promise2]).then(decryptedFiles => {
        mkdirp.sync(`${publicDir}/${id}`)
        this.config[id].index = this.config[id].index || 0
        mkdirp.sync(`${videoDir}/${id}`)
        let combinedFilename = `${videoDir}/${id}/${this.config[id].index}.mp4`
        this.config[id].index++
        let mp4Command = `MP4Box -add ${decryptedFiles[0]} -add ${decryptedFiles[1]} -new ${combinedFilename}`
        return execPromise(mp4Command).then(() => {
          console.log('finished making mp4')
          fs.unlink(decryptedFiles[0])
          fs.unlink(decryptedFiles[1])
          if (!this.config[id].startedPlaylist) {
            this.config[id].startedPlaylist = true
            let playlistLines = []
            for (let i = this.config[id].index - 1; i <= 50000; i++) {
              playlistLines.push(`file '${path.resolve(`${videoDir}/${id}/${i}.mp4`)}'`)
            }
            let playlistFilename = `${videoDir}/${id}/playlist.txt`
            fs.writeFileSync(playlistFilename, playlistLines.join('\n'))
            let m3u8Command = `ffmpeg -y -nostdin -hide_banner -loglevel panic -err_detect ignore_err -nofix_dts -start_at_zero -copyts -vsync 0 -correct_ts_overflow 0 -avoid_negative_ts disabled -max_interleave_delta 0 -re -probesize 9000000 -analyzeduration 9000000 -f concat -safe 0 -i ${path.resolve(playlistFilename)} -vcodec copy -scodec copy -acodec copy -individual_header_trailer 0 -f segment -segment_format mpegts -segment_time 10 -segment_list_size 6 -segment_format_options mpegts_flags=+initial_discontinuity:mpegts_copyts=1 -segment_list_type m3u8 -segment_list_flags +live+delete -segment_list ${path.resolve(`${publicDir}/${id}/playlist.m3u8`)} ${path.resolve(`${publicDir}/${id}/playlist%d.ts`)}`
            setTimeout(() => {
              execPromise(m3u8Command, { maxBuffer: 1024 * 500 })
                .then(ffmpegOutput => {
                  if (this.config[id].startedPlaylist) this.config[id].startedPlaylist = false
                  console.error('ffmpeg ended nicely:', ffmpegOutput)
                })
                .catch(err => {
                  if (this.config[id].startedPlaylist) this.config[id].startedPlaylist = false
                  console.error('ffmpeg ended with a crash, may or may not be a problem, error is:', err)
                })
            }, 10000)
          }
          setTimeout(() => {
            if (fs.existsSync(combinedFilename)) fs.unlink(combinedFilename)
          }, 300000)
          return true
        })
      })
    })
  }

  async startBuild (id, licenseUrl, segmentParser, mpdRefresher, useLocal = false) {
    console.log('building', id)
    let self = this
    this.config[id] = this.config[id] || {}
    if (this.config[id].started) {
      return Promise.resolve({ status: 'error', msg: 'stream already started' })
    } else {
      this.config[id].started = true
    }
    this.config[id].stopped = false
    this.config[id].startTime = new Date()
    if (mpdRefresher) {
      mpdRefresher(id)
      this.config[`refresh-interval-${id}`] = setInterval(() => {
        mpdRefresher(id)
      }, 10000)
      await this.util.sleep(60000)
    }
    this.build(id, licenseUrl, segmentParser, useLocal).catch(err => {
      this.resetVideo(id)
      this.config[id].started = true
      this.config[id].startTime = new Date()
      console.error('stream is fuqed up', err)
    })
    this.config[`interval-${id}`] = setInterval(() => {
      return self.build(id, licenseUrl, segmentParser, useLocal).catch(err => {
        this.config[id].startTime = new Date()
        console.error('restarting stream due to error: ', err)
        self.resetVideo(id)
        clearInterval(self.config[`interval-${id}`])
        clearInterval(self.config[`refresh-interval-${id}`])
        if (!self.config[id].stopped) return self.startBuild(id, licenseUrl, segmentParser, mpdRefresher, useLocal)
        else return true
      })
    }, 30000)
    return Promise.resolve({ status: 'success' })
  }

  resetVideo (id) {
    this.config[id] = {}
    this.flushCache(id)
    fs.removeSync(`${videoDir}/${id}`)
    fs.removeSync(`${publicDir}/${id}`)
  }

  stop (id) {
    clearInterval(this.config[`interval-${id}`])
    clearInterval(this.config[`refresh-interval-${id}`])
    this.resetVideo(id)
    this.config[id].stopped = true
    return Promise.resolve({ status: 'success' })
  }

  flushCache (key = null, wild = true) {
    if (key && wild) key = `*${key}*`
    console.log('flushCache: key=', key)

    if (!key) {
      this.redisClient.flushdb((err, succeeded) => {
        if (err) {
          this.util.postInfo('Error from flushCache: ', err)
        }
      })
    } else {
      this.redisClient.keys(key, (err, rows) => {
        if (err) {
          this.util.postInfo('Error from flushCache: ', err)
        }
        for (let row of rows) {
          this.redisClient.del(row)
        }
      })
    }
  }
}

module.exports = VideoManager
