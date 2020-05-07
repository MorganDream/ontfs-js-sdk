const Common = require("./common")
const Config = require("./config")
const FS = require("./fs")
const Network = require("./network")
const PDP = require("./pdp")
const SDK = require("./sdk")
const TaskEntity = require("./taskentity")
const TaskManage = require("./taskmanage")
const Types = require("./types")
const Utils = require("./utils")
const OntSDK = require("ontology-ts-sdk")
const { client } = require("@ont-dev/ontology-dapi")
client.registerClient({});
module.exports = {
    Common,
    Config,
    FS,
    Network,
    PDP,
    SDK,
    TaskEntity,
    TaskManage,
    Types,
    Utils,
    OntSDK
}