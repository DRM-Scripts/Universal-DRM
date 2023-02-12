const express = require('express')
const bodyParser = require('body-parser')

class TataSkyRouter {
  constructor (tataSkyManager, util, videoManager) {
    this.router = express.Router()
    this.util = util
    this.tataSkyManager = tataSkyManager
    this.videoManager = videoManager
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))
    this.router.post('/widevine', this.processWidevine.bind(this))
    this.router.get('/schedule', this.schedule.bind(this))
    this.router.use(this.routeError.bind(this))
  }

  processWidevine (req, res) {
    this.util.r(req, res, () => this.tataSkyManager.processWidevine(req.body))
  }

  schedule (req, res) {
    this.util.r(req, res, () => this.tataSkyManager.schedule())
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = TataSkyRouter
