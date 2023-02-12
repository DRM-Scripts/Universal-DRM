const express = require('express')
const bodyParser = require('body-parser')
let root = 'live'

class LiveRouter {
  constructor (liveManager, util, videoManager) {
    this.router = express.Router()
    this.util = util
    this.liveManager = liveManager
    this.videoManager = videoManager
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))
    this.router.get('/stream', this.stream.bind(this))
    this.router.post('/widevine', this.processWidevine.bind(this))
    this.router.get('/schedule', this.schedule.bind(this))
    this.router.get('/build', this.build.bind(this))
    this.router.use(this.routeError.bind(this))
  }

  stream (req, res) {
    this.util.r(req, res, () => this.liveManager.getStream(req.query.id))
  }

  build (req, res) {
    this.util.r(req, res, () => this.videoManager.startBuild(`${root}-${req.query.channelId}`, 'http://localhost:3001/live/widevine', this.liveManager.getSegments(), this.liveManager.mpdRefresher(), true))
  }

  processWidevine (req, res) {
    this.util.r(req, res, () => this.liveManager.processWidevine(req.body))
  }

  schedule (req, res) {
    this.util.r(req, res, () => this.liveManager.getSchedule(this.util.getReqHost(req)))
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = LiveRouter
