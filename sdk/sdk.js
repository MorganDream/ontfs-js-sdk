
const pdp = require("../pdp")
const config = require("../config")
const fs = require("../fs")
const common = require("../common")
const utils = require("../utils")
const OntFs = require("./ontfs").OntFs
const Buffer = require('buffer/').Buffer
const { client } = require("@ont-dev/ontology-dapi")

class Sdk {
    constructor(
        _sdkConfig,
        _ontFs,
        _fs,
        _stop,
        _pdpServer
    ) {
        this.sdkConfig = _sdkConfig
        this.ontFs = _ontFs
        this.fs = _fs
        this.isStop = _stop
        this.pdpServer = _pdpServer
    }

    /**
     * get current SDK version
     *
     * @returns {string}
     * @memberof Sdk
     */
    getVersion() {
        return common.VERSION
    }

    /**
     * start SDK as daemon
     *
     * @returns
     * @memberof Sdk
     */
    async start() {
        return await this.fs.start()
    }

    /**
     * stop SDK daemon
     *
     * @memberof Sdk
     */
    async stop() {
        if (this.fs) {
            const err = await this.fs.close()
            if (err) {
                throw err
            }
        }
        this.isStop = true
    }

    /**
     * get current wallet account
     *
     * @returns {Account}
     * @memberof Sdk
     */
    async currentAccount() {
        return client.api.asset.getAccount()
    }

    /**
     * get wallet Base58 address
     *
     * @returns {string}
     * @memberof Sdk
     */
    async walletAddress() {
        return this.currentAccount()
    }

    /**
     * wait for block confirmed 
     *
     * @param {number} blockHeight
     * @memberof Sdk
     */
    async waitForBlock(blockHeight) {
        try {
            const currentBlockHeight = await client.api.network.getBlockHeight()
            if (blockHeight <= currentBlockHeight) {
                return
            }
            const timeout = common.WAIT_FOR_GENERATEBLOCK_TIMEOUT * (blockHeight - currentBlockHeight)
            if (timeout > common.DOWNLOAD_FILE_TIMEOUT) {
                timeout = common.DOWNLOAD_FILE_TIMEOUT
            }
            await this.waitForGenerateBlock(timeout, blockHeight - currentBlockHeight)
        } catch (e) {
            throw e
        }
    }



    /**
     * wait for {blockCount} blocks confirmed in {timeout} second
     *
     * @param {number} timeout
     * @param {number} blockCount
     * @returns {boolean}
     * @memberof Sdk
     */
    async waitForGenerateBlock(timeout, blockCount) {
        if (!blockCount) {
            return
        }
        let blockHeight = await client.api.network.getBlockHeight()
        if (!timeout) {
            timeout = 1
        }
        for (let i = 0; i < timeout; i++) {
            await utils.sleep(1000)
            let curBlockHeigh = await client.api.network.getBlockHeight()
            if ((curBlockHeigh - blockHeight) >= blockCount) {
                return true
            }
        }
        throw new Error(`timeout after ${timeout} (s)`)
    }

    /**
     * create user storage space
     *
     * @param {number} volume: volume size in KB
     * @param {number} copyNum: copy number
     * @param {number} timeExpired: space expired timestamp, second
     * @returns {SpaceInfo}
     * @memberof Sdk
     */
    async createSpace(volume, copyNum, timeExpired) {
        try {
            if (copyNum > common.MAX_COPY_NUM) {
                throw new Error(`max copy num limit ${common.MAX_COPY_NUM}, (copyNum: ${copyNum})`)
            }
            const nodeInfoList = await this.ontFs.getNodeInfoList(common.DEFAULT_FS_NODES_LIST)
            const nodeCount = nodeInfoList.nodesInfo.length
            if (nodeCount < copyNum) {
                throw new Error(`create space failed, nodeCount ${nodeCount} is less than copyNum ${copyNum}`)
            }
            const tx = await this.ontFs.createSpace(volume, copyNum, timeExpired)
            if (!tx) {
                throw new Error(`create space err`)
            }
            const info = this.getSpaceInfo()
            return info
        } catch (e) {
            throw e
        }
    }

    /**
     *
     * get space info for user
     * @returns {SpaceInfo}
     * @memberof Sdk
     */
    async getSpaceInfo() {
        try {
            const info = await this.ontFs.getSpaceInfo()
            if (!info) {
                throw new Error(`get space info error`)
            }
            let space = {}
            space.spaceOwner = info.spaceOwner.toBase58()
            space.volume = common.formatVolumeStringFromKb(info.volume)
            space.restVol = common.formatVolumeStringFromKb(info.restVol)
            space.payAmount = common.formatOng(info.payAmount)
            space.restAmount = common.formatOng(info.restAmount)
            space.timeStart = common.formatDateLocaleString(new Date(info.timeStart * 1000));
            space.timeExpired = common.formatDateLocaleString(new Date(info.timeExpired * 1000))
            space.currFeeRate = info.currFeeRate
            space.validFlag = info.validFlag
            return space
        } catch (e) {
            throw e
        }
    }

    /**
     * delete current user space 
     *
     * @memberof Sdk
     */
    async deleteSpace() {
        try {
            const tx = await this.ontFs.deleteSpace()
            const info = await this.ontFs.getSpaceInfo().catch((e) => { })
            console.log(`delete space tx = ${tx}, info = ${info}`)
            if (!info) {
                console.log(`delete space success`)
            } else {
                throw new Error(`get space info also exist`)
            }
        } catch (e) {
            throw e
        }
    }

    /**
     * update a exist space 
     *
     * @param {number} volume volume size in KB
     * @param {number} timeExpired space expired timestamp, second
     * @memberof Sdk
     */
    async updateSpace(volume, timeExpired) {
        try {
            const spaceInfo1 = await this.ontFs.getSpaceInfo()
            const tx = await this.ontFs.updateSpace(volume, timeExpired)
            const spaceInfo2 = await this.ontFs.getSpaceInfo()
            if (spaceInfo1.volume == spaceInfo2.volume && spaceInfo1.timeExpired == spaceInfo2.timeExpired) {
                throw new Error(`update failed, before volume(${spaceInfo1.Volume}), time expired(${spaceInfo1.TimeExpired});
                 updated volume(${spaceInfo2.Volume}), time expired(${spaceInfo2.TimeExpired})`)
            } else {
                console.log("update space success")
            }
        } catch (e) {
            throw e
        }
    }

    /**
      * get storage node info list
     *
     * @param {number} : max number of list
     * @returns {Array}
     * @memberof Sdk
     */
    async getFsNodesList(limit) {
        try {
            const fsNodeList = await this.ontFs.getNodeInfoList(limit)
            var count = 0
            var fsNodesInfoList = []
            for (let index in fsNodeList.nodesInfo) {
                let nodeInfo = fsNodeList.nodesInfo[index]
                if (count >= limit) {
                    break
                }
                fsNodesInfoList.push({
                    pledge: nodeInfo.pledge,
                    profit: nodeInfo.profit,
                    volume: common.formatVolumeStringFromKb(nodeInfo.volume),
                    restVol: common.formatVolumeStringFromKb(nodeInfo.restVol),
                    serviceTime: common.formatTimeStringFromUnixTime(nodeInfo.serviceTime),
                    nodeAddr: nodeInfo.nodeAddr.toBase58(),
                    nodeNetAddr: nodeInfo.nodeNetAddr,
                })
                count++
            }
            return fsNodesInfoList
        } catch (e) {
            throw e
        }
    }

    /**
     * get file info of hash
     *
     * @param {string} fileHash
     * @returns {Object}
     * @memberof Sdk
     */
    async getFileInfo(fileHashStr) {
        try {
            const fi = await this.ontFs.getFileInfo(fileHashStr)
            if (fi) {
                return {
                    fileHash: fi.fileHash,
                    fileOwner: fi.fileOwner.toBase58(),
                    fileDesc: fi.fileDesc,
                    fileBlockCount: fi.fileBlockCount,
                    realFileSize: common.formatVolumeStringFromByteNum(fi.realFileSize),
                    copyNumber: fi.copyNumber,
                    payAmount: common.formatOng(fi.payAmount),
                    restAmount: common.formatOng(fi.restAmount),
                    firstPdp: fi.firstPdp,
                    timeStart: common.formatTimeStringFromUnixTime(fi.timeStart),
                    timeExpired: common.formatTimeStringFromUnixTime(fi.timeExpired),
                    beginHeight: fi.beginHeight,
                    expiredHeight: fi.expireHeight ? fi.expireHeight : 0,
                    pdpParam: fi.pdpParam,
                    validFlag: fi.validFlag,
                    currFeeRate: fi.currFeeRate,
                    storageType: fi.storageType,
                }
            }
            throw new Error(`fileinfo is nil`)
        } catch (e) {
            throw e
        }
    }

    /**
     * get stored file list 
     *
     * @returns {Array}
     * @memberof Sdk
     */
    async getFileList() {
        let fileHashes = []
        try {
            const list = await this.ontFs.getFileList()
            if (!list) {
                return fileHashes
            }
            for (let hash of list.filesH) {
                if (!hash || !hash.fHash) {
                    continue
                }
                fileHashes.push(hash.fHash)
            }
            return fileHashes
        } catch (e) {
            throw e
        }
    }

    /**
     * renew a exist file
     *
     * @param {string} fileHash : file hash
     * @param {number} addTime : added second
     * @memberof Sdk
     */
    async  renewFile(fileHash, addTime) {
        try {
            const fileInfo = await this.ontFs.getFileInfo(fileHash)
            const fileRenews = {
                fileHash,
                renewTime: fileInfo.timeExpired + addTime,
            }
            await this.ontFs.renewFile([fileRenews])
        } catch (e) {
            throw e
        }
    }

    /**
     * change file owner
     *
     * @param {string} fileHash
     * @param {Address} newOwner
     * @memberof Sdk
     */
    async changeOwner(fileHash, newOwner) {
        try {
            const fileRenews = {
                fileHash,
                newOwner,
            }
            await this.ontFs.transferFiles([fileRenews])
            const fileInfo = await this.ontFs.getFileInfo(fileHash).catch((err) => {
                throw err
            })
            if (fileInfo && fileInfo.fileOwner == newOwner) {
                console.log('change owner success')
            } else {
                throw new Error(`check upload file info owner is not newOwner`, newOwner)
            }
        } catch (e) {
            throw e
        }
    }

    /**
     * get a file read pledge 
     *
     * @param {string} fileHash  file hash 
     * @returns {Object}
     * @memberof Sdk
     */
    async getFileReadPledge(fileHashStr) {
        try {
            const pledge = await this.ontFs.getFileReadPledge(fileHashStr, this.ontFs.walletAddr)
            if (!pledge) {
                throw new Error(`file read pledge not exist`)
            }
            const readPledge = {
                fileHash: pledge.fileHash,
                downloader: pledge.downloader.toBase58(),
                restMoney: pledge.restMoney,
                readPlans: [],
            }
            for (let plan of pledge.readPlans) {
                readPledge.readPlans.push({
                    nodeAddr: plan.nodeAddr.toBase58(),
                    maxReadBlockNum: plan.maxReadBlockNum,
                    haveReadBlockNum: plan.haveReadBlockNum,
                    numOfSettlements: plan.numOfSettlements
                })
            }
            return readPledge
        } catch (e) {
            throw e
        }
    }

    /**
     * cancel the file read pledge
     * 
     * @param {string} fileHash
     * @memberof Sdk
     */
    async cancelFileRead(fileHashStr) {
        try {

            const pledge = await this.ontFs.getFileReadPledge(fileHashStr, this.ontFs.walletAddr)
            if (!pledge) {
                throw new Error(`get file read pledge error`)
            }
            await this.ontFs.cancelFileRead(fileHashStr)
        } catch (e) {
            throw e
        }

    }

    /**
     * get file pdp record list
     *
     * @param {string} fileHash
     * @returns {Array}
     * @memberof Sdk
     */
    async getFilePdpInfoList(fileHashStr) {
        try {
            let records = []
            const fileInfo = await this.ontFs.getFileInfo(fileHashStr)
            if (!fileInfo) {
                throw new Error(`get file info fileHash ${fileHashStr} error`)
            }
            const pdpRecordList = await this.ontFs.getFilePdpRecordList(fileHashStr)
            console.log('pdpRecordList', pdpRecordList)
            if (!pdpRecordList) {
                throw new Error(`get pdp records list error`)
            }
            for (let pr of pdpRecordList.pdpRecords) {
                records.push({
                    nodeAddr: pr.nodeAddr.toBase58(),
                    fileHash: pr.fileHash,
                    fileOwner: pr.fileOwner.toBase58(),
                    lastPdpTime: common.formatTimeStringFromUnixTime(pr.lastPdpTime),
                    settleFlag: pr.settleFlag,
                })
            }
            return records
        } catch (e) {
            throw e
        }
    }

    /**
     * challenge a file with a specific node
     *
     * @param {string} fileHash
     * @param {string} nodeAddr node wallet base58 string
     * @memberof Sdk
     */
    async  challenge(fileHash, nodeAddr) {
        try {
            await this.ontFs.challenge(fileHash, nodeAddr)
        } catch (e) {
            throw e
        }
    }

    /**
     * judge a file with a specific node
     *
     * @param {string} fileHash
     * @param {string} nodeAddr node wallet base58 string
     * @memberof Sdk
     */
    async  judge(fileHash, nodeAddr) {
        try {
            await this.ontFs.judge(fileHash, nodeAddr)
        } catch (e) {
            throw e
        }
    }

    /**
     * get file challenge list
     *
     * @param {string} fileHash
     * @returns {Array}
     * @memberof Sdk
     */
    async  getChallengeList(fileHash) {
        try {
            const challengeListTmp = await this.ontFs.getFileChallengeList(fileHash)
            let challengeList = []
            for (let challenge of challengeListTmp.challenges) {
                challengeList.push({
                    fileHash: challenge.fileHash,
                    fileOwner: challenge.fileOwner.toBase58(),
                    nodeAddr: challenge.nodeAddr.toBase58(),
                    challengeHeight: challenge.challengeHeight,
                    reward: challenge.reward,
                    expiredTime: challenge.expiredTime,
                    state: challenge.state,
                })
            }
            return challengeList
        } catch (e) {
            console.log('er', e.toString())
            throw e
        }
    }

    /**
     * delete file
     *
     * @param {string} fileHash
     * @memberof Sdk
     */
    async deleteFile(fileHash) {
        try {
            let fileInfo = await this.ontFs.getFileInfo(fileHash)
            if (!fileInfo) {
                throw new Error(`DeleteFile error: file is not exist`)
            }
            await this.ontFs.deleteFiles([fileHash])
            fileInfo = await this.ontFs.getFileInfo(fileHash).catch((e) => { })
            if (!fileInfo) {
                console.log(`file ${fileHash} has deleted`)
                return
            }
            console.log('fileInfo', fileInfo)
            throw new Error(`contract interface DeleteFile called error`)
        } catch (e) {
            throw e
        }
    }

    /**
     * delete files
     *
     * @param {Array} fileHashes
     * @memberof Sdk
     */
    async  deleteFiles(fileHashes) {
        try {
            await this.ontFs.deleteFiles(fileHashes)
        } catch (e) {
            throw e
        }
    }

    /**
     * decrypt a downloaded file
     *
     * @param {ArrayBuffer} fileContent: encrypted array buffer
     * @param {string} decryptPwd : encrypted password
     * @returns {ArrayBuffer} : decrypted array buffer
     * @memberof Sdk
     */
    decryptDownloadedFile(fileContent, decryptPwd) {
        if (!decryptPwd || !decryptPwd.length) {
            throw new Error(`no decrypt password`)
        }
        // to do test
        const filePrefix = new utils.FilePrefix()
        let prefix = Buffer.from(fileContent).toString().substr(0, utils.PREFIX_LEN)
        console.log("read first n prefix :", prefix)
        filePrefix.fromString(prefix)
        if (!filePrefix.encrypt) {
            console.log(`file not encrypt`)
            return fileContent
        }
        if (!filePrefix.verifyEncryptPassword(decryptPwd)) {
            throw new Error(`wrong password`)
        }
        console.log('password verified')
        return this.fs.aesDecryptFile(fileContent, decryptPwd, utils.PREFIX_LEN)
    }

}

/**
 * init a SDK
 *
 * @param {Object} sdkCfg: sdk config
 * @returns
 */
const initSdk = async (sdkCfg) => {
    const s = new Sdk()
    s.sdkConfig = sdkCfg
    s.pdpServer = await pdp.newPdp(sdkCfg.pdpVersion)
    s.ontFs = new OntFs(sdkCfg.gasPrice, sdkCfg.gasLimit)
    if (!s.ontFs) {
        throw new Error("ontfs contract api init failed")
    }
    // console.log('config.DaemonConfig', config.DaemonConfig)
    if (config.DaemonConfig && config.DaemonConfig.fsRepoRoot && config.DaemonConfig.fsRepoRoot.length) {
        s.fs = fs.newFs()
    }
    return s
}

var Global = {}
var Version = 0

/**
 * global sdk setter
 *
 * @param {Sdk} sdk
 */
const setGlobalSdk = (sdk) => {
    Global['sdk'] = sdk
}
/**
 * global sdk getter 
 *
 * @returns {Sdk}
 */
const globalSdk = () => {
    return Global['sdk']
}

module.exports = {
    Sdk,
    initSdk,
    Version,
    setGlobalSdk,
    globalSdk,
}