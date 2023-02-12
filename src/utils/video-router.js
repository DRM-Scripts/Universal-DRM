const express = require('express')
const bodyParser = require('body-parser')

class VideoRouter {
  constructor (util, videoManager) {
    this.videoManager = videoManager
    this.router = express.Router()
    this.util = util
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))

    this.router.get('/stop', this.stop.bind(this))
    this.router.get('/master.m3u8', this.mpdToHLSManifest.bind(this))
    this.router.get('/master2.m3u8', this.audioVideoM3u8.bind(this))
    this.router.get('/variant.m3u8', this.mpdToHLSVariant.bind(this))
    this.router.get('/downloader.m4s', this.downloader.bind(this))
    this.router.get('/decrypted.mpd', this.decryptMpd.bind(this))
    this.router.get('/getMpd', this.getMpd.bind(this))

    this.router.use(this.routeError.bind(this))
  }

  getMpd (req, res) {
    this.util.r(req, res, () => this.videoManager.testMpd())
  }

  audioVideoM3u8 (req, res) {
    res.setHeader('Content-Type', 'application/x-mpegURL')
    let bandwidthIndex = 0
    if (req.query.bandwidthIndex === 'false') {
      bandwidthIndex = req.query.bandwidthIndex
    } else {
      bandwidthIndex = parseInt(req.query.bandwidthIndex) || undefined
    }
    this.videoManager.audioVideoM3u8(req.query.mpd, req.query.licenseUrl, bandwidthIndex, req.query.checkDTS).then(m3u8Dir => {
      res.redirect(m3u8Dir.replace('public/', '/dev/'))
    })
  }

  mpdToHLSVariant (req, res) {
    res.setHeader('Content-Type', 'application/x-mpegURL')
    this.util.r(req, res, () => this.videoManager.mpdToHLSVariantV1(req.query.bandwidth, req.query.mpd, req.query.audio, req.query.licenseUrl, req.query.headers))
  }

  decryptMpd (req, res) {
    res.setHeader('Content-Type', 'application/dash+xml')
    this.util.r(req, res, () => this.videoManager.decryptMpd(req.query.mpd))
  }

  mpdToHLSManifest (req, res) {
    res.setHeader('Content-Type', 'application/x-mpegURL')
    let bandwidthIndex = 0
    if (req.query.bandwidthIndex === 'false') {
      bandwidthIndex = req.query.bandwidthIndex
    } else {
      bandwidthIndex = parseInt(req.query.bandwidthIndex) || undefined
    }
    this.util.r(req, res, () => this.videoManager.mpdToHLSManifestV1(req.query.mpd, req.query.licenseUrl, bandwidthIndex, req.query.headers))
  }

  downloader (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.videoManager.downloaderV1(req.query.init, req.query.key, req.query.url, req.query.audio, req.query.headers).then(segment => {
      if (typeof directory === 'string') res.redirect(segment.replace('public/', '/dev/'))
      else res.send(segment)
    })
  }

  stop (req, res) {
    this.util.r(req, res, () => this.videoManager.stop(req.query.id))
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = VideoRouter
