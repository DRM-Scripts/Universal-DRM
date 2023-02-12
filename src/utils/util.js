const HLS = require('hls-parser')
const request = require('request-promise')
const readHLS = require('m3u8-reader')
const writeHLS = require('m3u8-write')
const url = require('url')
const crypto = require('crypto')
const CryptoJS = require('crypto-js')

class Util {
  constructor (origin) {
    this.origin = origin
  }
  postError (logData, extra = null) {
    let msg = 'module: ' + this.origin
    if (extra) {
      msg += ' (' + extra + ')'
    }
    msg = msg + ' error: '
    console.error(msg, logData)
  }

  getReqHost (req) {
    let host = req.protocol + '://' + req.hostname
    if (process.env.PORT) {
      host = host + ':' + process.env.PORT
    }
    return host
  }

  postInfo (logData) {
    console.info('module: ' + this.origin + ' info: ', logData)
  }
  routeError (err, req, res, next) {
    this.postError(err)
    this.sendError(req, res, 500, err)
  }
  createError (code, err = null, customclientErrorMessage = null) {
    let clientErrorMessage
    if (customclientErrorMessage) {
      clientErrorMessage = customclientErrorMessage
    } else {
      switch (code) {
        case 500:
          clientErrorMessage = 'Unexpected server error'
          break
        case 404:
          clientErrorMessage = 'object not found'
          break
        case 400:
          clientErrorMessage = 'bad request'
          break
      }
    }
    let obj = { clientErrorMessage: clientErrorMessage, statusCode: code }
    if (err) {
      obj.devErrorMessage = err.message
      obj.stack = err.stack
    }
    return obj
  }

  badInputError (msg = 'Bad input', code = 400) {
    let err = new Error(msg)
    err.code = code
    err.customClientErrorMessage = msg
    return err
  }

  sendError (req, res, code, err = null, customClientErrorMessage = null) {
    if (err && err.code) {
      code = err.code
    }
    if (err && err.customClientErrorMessage) {
      customClientErrorMessage = err.customClientErrorMessage
    }
    let error = this.createError(code, err, customClientErrorMessage)

    let extra = null
    if (req) {
      extra = ''
      if (req.user && Object.keys(req.user).length > 0) {
        extra = extra + JSON.stringify(req.user)
      }
      if (req.body) {
        Object.keys(req.body).forEach(key => {
          if (key !== 'password') {
            extra = extra + ' ' + key + ':' + JSON.stringify(req.body[key])
          } else {
            extra = extra + ' password:XXXXXXX'
          }
        })
      }
      if (req.params && Object.keys(req.params).length > 0) {
        extra = extra + ' ' + JSON.stringify(req.params)
      }
    }
    this.postError(error, extra)
    res.status(code).json(error)
  }
  //  Generic implementation for function that expects results
  r (req, res, funcResult) {
    try {
      funcResult()
        .then(obj => {
          if (obj) {
            if (typeof obj === 'object' && !Buffer.isBuffer(obj)) res.json(obj)
            else res.send(obj)
          } else {
            this.sendError(req, res, 404)
          }
        }, err => {
          this.sendError(req, res, 500, err)
        })
    } catch (err) {
      this.sendError(req, res, 500, err)
    }
  }
  //  Generic implementation for function that doesn't expect results
  nr (req, res, funcResult) {
    try {
      funcResult()
        .then(obj => {
          if (obj) {
            res.sendStatus(204)
          } else {
            this.sendError(req, res, 404)
          }
        }, err => {
          this.sendError(req, res, 500, err)
        })
    } catch (err) {
      this.sendError(req, res, 500, err)
    }
  }

  makeRequest (options) {
    return request(options)
  }

  parseHLS (body, hlsUrl = null, cacheId = null, client = null) {
    let playlist = readHLS(body)
    for (let i in playlist) {
      // rewrite key files
      if (playlist[i] && playlist[i].KEY && playlist[i].KEY.URI) {
        let encodedKey = Buffer.from(playlist[i].KEY.URI).toString('base64')
        playlist[i].KEY.URI = `../key?key=${encodedKey}`
      }
      // rewrite variants and segments
      if (typeof playlist[i] === 'string') {
        // add host
        if (hlsUrl) {
          playlist[i] = url.resolve(hlsUrl, playlist[i])
        }
        // cache variant and change host to local
        if (cacheId) {
          let lastSegment = playlist[i - 1]
          if (lastSegment && lastSegment['STREAM-INF'] && lastSegment['STREAM-INF'].BANDWIDTH) {
            let bandwidth = lastSegment['STREAM-INF'].BANDWIDTH
            if (client) client.setex(`${cacheId}-${bandwidth}`, 43200, playlist[i])
            playlist[i] = `${cacheId}/${bandwidth}.m3u8`
          }
        }
      }
    }
    return writeHLS(playlist)
  }

  randomFileName (ext = '') {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15) + ext
  }

  findLastIndex (array, searchKey, searchValue) {
    let index = array.slice().reverse().findIndex(x => x[searchKey] === searchValue)
    let count = array.length - 1
    let finalIndex = index >= 0 ? count - index : index
    return finalIndex
  }

  sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  getMD5 (string) {
    return crypto.createHash('md5').update(string).digest('hex')
  }

  decryptRightsObject (rights) {
    let key = CryptoJS.enc.Hex.parse('')
    let iv = CryptoJS.enc.Hex.parse('')
    let data = Buffer.from(rights, 'hex').toString('base64')
    let decrypted = CryptoJS.AES.decrypt({ ciphertext: CryptoJS.enc.Base64.parse(data), salt: '' }, key, { iv })
    return JSON.parse(Buffer.from(decrypted.toString(), 'hex').toString('utf8'))
  }

  getMaxPlaylists (parsedManifest, aCodec = null) {
    aCodec = aCodec || Object.keys(parsedManifest.mediaGroups.AUDIO.audio)[0]
    let audioPlaylists = parsedManifest.mediaGroups.AUDIO.audio[aCodec].playlists
    let maxB = 0
    let maxVideo = null
    for (let playlist of parsedManifest.playlists) {
      if (playlist.attributes.BANDWIDTH > maxB) {
        maxB = playlist.attributes.BANDWIDTH
        maxVideo = playlist
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
    return { maxAudio, maxVideo }
  }

  maxBandwidthUri (manifest, manifestUrl) {
    const playlist = HLS.parse(manifest)
    let maxBw = 0
    let uri = null
    for (let variant of playlist.variants) {
      if (variant.bandwidth > maxBw) {
        maxBw = variant.bandwidth
        uri = url.resolve(manifestUrl, variant.uri)
      }
    }
    return uri
  }
}

module.exports = Util
