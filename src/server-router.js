const express = require('express')
const bodyParser = require('body-parser')
const services = null
const childProcess = require('child_process')

class ServerRouter {
  constructor (util, slingManager) {
    this.router = express.Router()
    this.util = util
    this.slingManager = slingManager
    this.router.get('/services', this.getServices.bind(this))
    this.router.get('/exo', this.getExo.bind(this))
    this.router.get('/test2', this.getExo.bind(this))
    this.router.post('/deploy', this.deploy.bind(this))

    this.router.use(bodyParser.json())
    this.router.use(this.routeError.bind(this))
  }

  getServices (req, res) {
    this.util.r(req, res, () => Promise.resolve(services))
  }

  getExo (req, res) {
    let host = this.util.getReqHost(req)
    let promises = [
      this.slingManager.getExoSchedule(host)
    ]
    Promise.all(promises).then(result => {
      this.util.r(req, res, () => Promise.resolve([].concat.apply([], result)))
    })
  }

  deploy (req, res) {
    childProcess.exec('./deploy.sh', (err, stdout, stderr) => {
      if (err) {
        console.log(err)
        return res.sendStatus(500)
      }
      return res.sendStatus(204)
    })
  }

  routeError (err, req, res, next) {
    this.util.routeError(err, req, res, next)
  }
}

module.exports = ServerRouter
