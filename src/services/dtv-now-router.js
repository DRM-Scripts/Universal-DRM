const express = require('express')
const bodyParser = require('body-parser')

class DTVNowRouter {
  constructor (dtvNowManager, util) {
    this.dtvNowManager = dtvNowManager
    this.router = express.Router()
    this.util = util
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))

    this.router.post('/widevine', this.processWidevine.bind(this))
    this.router.get('/login', this.login.bind(this))
    this.router.get('/schedule', this.getSchedule.bind(this))
    this.router.get('/meta', this.getChannelMeta.bind(this))
    this.router.use(this.routeError.bind(this))
  }

  processWidevine (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.dtvNowManager.processWidevine(req.body, req.query.contentId))
  }

  login (req, res) {
    this.util.r(req, res, () => this.dtvNowManager.login())
  }

  getSchedule (req, res) {
    this.util.r(req, res, () => this.dtvNowManager.getSchedule())
  }

  getChannelMeta (req, res) {
    this.util.r(req, res, () => this.dtvNowManager.getChannelMeta(req.query.ccid))
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = DTVNowRouter
