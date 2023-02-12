const express = require('express')
const bodyParser = require('body-parser')

class BellRouter {
  constructor (bellManager, util) {
    this.router = express.Router()
    this.util = util
    this.bellManager = bellManager

    this.router.use(bodyParser.raw({ type: function (req) { return true } }))
    this.router.get('/:id.mpd', this.getStream.bind(this))
    this.router.post('/widevine', this.processWidevine.bind(this))
    this.router.get('/scheduleStatus.json', this.channels.bind(this))

    this.router.use(this.routeError.bind(this))
  }

  processWidevine (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.bellManager.processWidevine(req.body, req.query.callsign))
  }

  channels (req, res) {
    this.util.r(req, res, () => this.bellManager.getChannels())
  }

  getStream (req, res) {
    this.bellManager.getStreamUrl(req.params.id).then(streamData => {
      res.redirect(streamData.url)
    })
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = BellRouter
