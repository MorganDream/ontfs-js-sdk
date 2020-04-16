const address = require("./address")
const crypto = require("./crypto")
const prefix = require("./prefix")
const time = require("./time")
const random = require("./random")
module.exports = {
    ...address,
    ...crypto,
    ...prefix,
    ...time,
    ...random,
}