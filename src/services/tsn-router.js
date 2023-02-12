const express = require('express')
const bodyParser = require('body-parser')

class TSNRouter {
  constructor (tsnManager, util) {
    this.tsnManager = tsnManager
    this.router = express.Router()
    this.util = util
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))

    this.router.get('/bKIvEvxhlH', this.getFairplayCert.bind(this))
    this.router.post('/g1Ilryrq0i', this.processFairplayCert.bind(this))
    this.router.post('/yGsZQrFlUn', this.processWidevine.bind(this))
    this.router.post('/6Wn029orzF', this.processPlayReady.bind(this))

    this.router.use(this.routeError.bind(this))
  }

  getFairplayCert (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.tsnManager.getFairplayCert())
  }

  processFairplayCert (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.tsnManager.processFairplayCert(req.body))
  }

  processWidevine (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.tsnManager.processWidevine(req.body))
  }

  processPlayReady (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.tsnManager.processPlayReady(req.body))
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = TSNRouter
