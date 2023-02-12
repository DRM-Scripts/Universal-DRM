const express = require('express')
const bodyParser = require('body-parser')
let root = 'sling'
class SlingRouter {
  constructor (slingManager, util, videoManager) {
    this.slingManager = slingManager
    this.videoManager = videoManager
    this.router = express.Router()
    this.util = util
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))

    this.router.post('/yGsZQrFlUn', this.processWidevine.bind(this))
    this.router.get('/:channelId.mpd', this.getStream.bind(this))
    this.router.get('/schedule', this.getSchedule.bind(this))
    this.router.get('/schedule.json', this.getRawSchedule.bind(this))
    this.router.get('/scheduleStatus.json', this.getScheduleStatus.bind(this))
    this.router.get('/segments', this.getSegments.bind(this))
    this.router.get('/build', this.build.bind(this))
    this.router.get('/stop', this.stop.bind(this))
    this.router.get('/findTestCases', this.findTestCases.bind(this))
    // this.router.get('/new.m3u8', this.rewriteM3u8.bind(this))

    this.router.use(this.routeError.bind(this))
  }

  rewriteM3u8 (req, res) {
    res.setHeader('content-type', 'application/x-mpegURL')
    this.util.r(req, res, () => this.slingManager.rewriteM3u8(req.query.channelId))
  }

  getSegments (req, res) {
    this.util.r(req, res, () => this.slingManager.getSegments(req.query.channelId))
  }

  findTestCases (req, res) {
    this.slingManager.findTestCases()
  }

  build (req, res) {
    this.util.r(req, res, () => this.videoManager.startBuild(`${root}-${req.query.channelId}`, 'http://localhost:3001/sling/yGsZQrFlUn', this.slingManager.getSegmentsv3()))
  }

  stop (req, res) {
    this.util.r(req, res, () => this.videoManager.stop(`${root}-${req.query.channelId}`))
  }

  processWidevine (req, res) {
    this.util.r(req, res, () => this.slingManager.processWidevine(req.body, req.query.channelId))
  }

  getStream (req, res) {
    res.setHeader('Content-Type', 'application/dash+xml')
    this.util.r(req, res, () => this.slingManager.getStream(req.params.channelId, req.query.rewrite !== 'false'))
  }

  getSchedule (req, res) {
    res.setHeader('Content-Type', 'application/xml')
    let host = this.util.getReqHost(req)
    this.util.r(req, res, () => this.slingManager.getSchedule(host))
  }

  getScheduleStatus (req, res) {
    this.util.r(req, res, () => this.slingManager.getScheduleStatus())
  }

  getRawSchedule (req, res) {
    this.util.r(req, res, () => this.slingManager.getRawSchedule())
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = SlingRouter
