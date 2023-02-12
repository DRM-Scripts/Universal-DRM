const express = require('express')
const bodyParser = require('body-parser')

class RAPRouter {
  constructor (rapManager, util) {
    this.rapManager = rapManager
    this.router = express.Router()
    this.util = util
    this.router.use(bodyParser.raw({ type: function (req) { return true } }))

    this.router.get('/:id.mpd', this.getStream.bind(this))
    this.router.post('/widevine', this.processWidevine.bind(this))
    this.router.get('/channels', this.channels.bind(this))

    this.router.use(this.routeError.bind(this))
  }

  processWidevine (req, res) {
    res.setHeader('Content-Type', 'application/octet-stream')
    this.util.r(req, res, () => this.rapManager.processWidevine(req.body, req.query.playbackId))
  }

  channels (req, res) {
    this.util.r(req, res, () => this.rapManager.getChannels())
  }

  getStream (req, res) {
    this.rapManager.getStreamUrl(req.params.id).then(streamData => {
      res.redirect(streamData.url)
    })
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = RAPRouter
