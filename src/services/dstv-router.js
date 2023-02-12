const express = require('express')
const bodyParser = require('body-parser')
let root = 'dstv'

class DSTVRouter {
  constructor (dstvManager, util, videoManager) {
    this.router = express.Router()
    this.util = util
    this.dstvManager = dstvManager
    this.videoManager = videoManager
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))
    this.router.post('/widevine', this.processWidevine.bind(this))
    this.router.get('/scheduleStatus.json', this.getScheduleStatus.bind(this))
    this.router.get('/build', this.build.bind(this))
    this.router.use(this.routeError.bind(this))
  }

  build (req, res) {
    this.util.r(req, res, () => this.videoManager.startBuild(`${root}-${req.query.channelId}`, 'http://localhost:3001/dstv/widevine', this.dstvManager.getSegments()))
  }

  processWidevine (req, res) {
    this.util.r(req, res, () => this.dstvManager.processWidevine(req.body))
  }

  getScheduleStatus (req, res) {
    this.util.r(req, res, () => this.dstvManager.getScheduleStatus())
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = DSTVRouter
