const types = require("../types")
const utils = require("../utils")
const common = require("../common")
const pdp = require("../pdp")
const sdk = require("../sdk")
const { TaskStart, TaskPause, TaskFinish } = require("./const")

const message = require("../network/message")
const client = require("../network/http/http_client")
const Upload_AddTask = 0
const Upload_FsAddFile = 1
const Upload_FsGetPdpHashData = 2
const Upload_ContractStoreFiles = 3
const Upload_FindReceivers = 4
const Upload_FilePreTransfer = 5
const Upload_FileTransferBlocks = 6
const Upload_WaitPdpRecords = 7
const Upload_Done = 8
const Upload_Error = 9

const newTaskUpload = (taskID, option, baseInfo, transferInfo) => {
    if (!baseInfo && !transferInfo) {
        try {
            checkParams(option)
        } catch (e) {
            throw e
        }
    }
    const taskUpload = new TaskUpload(option)
    if (baseInfo) {
        taskUpload.baseInfo = baseInfo
    } else {
        taskUpload.baseInfo = {
            taskID: taskID,
            progress: Upload_AddTask,
            fileReceivers: {},
            allOffset: {}
        }
    }
    if (taskUpload.baseInfo.status != TaskFinish) {
        taskUpload.baseInfo.status = TaskPause
    }
    if (transferInfo) {
        transferInfo.blockMsgDataMap = {}
        transferInfo.blockSendNotify = {}
        taskUpload.transferInfo = transferInfo
    } else {
        taskUpload.transferInfo = {
            blockMsgDataMap: {},
            blockSendNotify: {},
            blockSendDetails: {},
        }
    }
    return taskUpload
}

class TaskUpload {
    constructor(_option, _baseInfo, _transferInfo) {
        this.option = _option
        this.baseInfo = _baseInfo
        this.transferInfo = _transferInfo
    }

    async checkUploadTask() {
        const uploaded = await fileHasUploaded(this.baseInfo.fileHash)
        if (uploaded) {
            throw new Error(`file ${this.baseInfo.fileHash} info has been exist on chain`)
        }
        if (this.option.storageType != types.FileStorageTypeUseSpace) {
            return
        }
        try {
            console.log("get space info")
            const spaceInfo = await sdk.globalSdk().ontFs.getSpaceInfo()
            if (spaceInfo.restVol * 1024 < this.baseInfo.blockCount * common.CHUNK_SIZE) {
                throw new Error("space rest volume is not enough")
            }
            if (this.option.copyNum != spaceInfo.copyNum) {
                throw new Error(`copyNum must be equal with space copyNum`)
            }
            this.option.pdpInterval = spaceInfo.pdpInterval
            this.option.timeExpired = spaceInfo.timeExpired
        } catch (e) {
            console.log(`get space info error ${e.toString()}`)
            throw e
        }
    }

    async upload() {
        let fileEnc = false
        this.baseInfo.status = TaskStart
        if (this.baseInfo.progress < Upload_FsAddFile) {
            this.baseInfo.filePrefix = getFilePrefix(this.option)
            if (this.option.encPassword && this.option.encPassword.length) {
                fileEnc = true
            }
            try {
                this.baseInfo.blockHashes = await sdk.globalSdk().fs.addFile(this.option.filePath, this.baseInfo.filePrefix,
                    fileEnc, this.option.encPassword)
                this.baseInfo.fileHash = this.baseInfo.blockHashes[0]
                this.baseInfo.blockCount = this.baseInfo.blockHashes.length
                this.baseInfo.progress = Upload_FsAddFile
            } catch (e) {
                throw e
            }
        }

        if (this.baseInfo.progress < Upload_FsGetPdpHashData) {
            await this.checkUploadTask().catch((e) => {
                throw e
            })
            console.log("here")
            const filePdpHash = await getFilePdpHashes(sdk.globalSdk().pdpServer.version,
                this.baseInfo.blockHashes).catch((e) => {
                    console.log(`fs GetFilePdpHashes err ${e.toString()}`)
                    throw e
                })
            console.log("here2")
            this.baseInfo.pdpHashData = filePdpHash.serialize()
            this.baseInfo.progress = Upload_FsGetPdpHashData
        }
        console.log("here3")
        if (this.baseInfo.progress < Upload_ContractStoreFiles) {
            const fileStore = {
                fileHash: this.baseInfo.fileHash,
                fileDesc: this.option.fileDesc,
                fileBlockCount: this.baseInfo.blockCount,
                realFileSize: this.option.fileSize,
                copyNumber: this.option.copyNum,
                firstPdp: this.option.firstPdp,
                pdpInterval: this.option.pdpInterval,
                timeExpired: this.option.timeExpired,
                pdpParam: this.baseInfo.pdpHashData,
                storageType: this.option.storageType,
            }
            console.log("will store file")
            const tx = await sdk.globalSdk().ontFs.storeFiles([fileStore]).catch((e) => {
                throw e
            })
            console.log('fileStore', fileStore, tx)
            const uploaded = await fileHasUploaded(this.baseInfo.fileHash)
            if (!uploaded) {
                throw new Error(`contract interface StoreFile called failed`)
            }
            this.baseInfo.storeTxHash = tx
            const blockHeightRet = await sdk.globalSdk().chain.getBlockHeightByTxHash(tx).catch((e) => {
                console.log("get height err", e)
                throw e
            })
            if (blockHeightRet && blockHeightRet.error == 0) {
                this.baseInfo.storeTxHeight = blockHeightRet.result
            }
            this.baseInfo.progress = Upload_ContractStoreFiles
        }
        console.log('base info', this.baseInfo)
        if (this.baseInfo.progress < Upload_FindReceivers) {
            const nodeList = await sdk.globalSdk().ontFs.getNodeInfoList(common.DEFAULT_FS_NODES_LIST).catch((e) => {
                throw e
            })

            if (!nodeList.nodesInfo || nodeList.nodesInfo.length < this.option.copyNum) {
                throw new Error(`fs nodes count ${nodeList.nodesInfo ? nodeList.nodesInfo.length : 0} less 
                than copyNum(${this.option.copyNum})`)
            }
            for (let fsNode of nodeList.nodesInfo) {
                const fsNodeAddr = fsNode.nodeAddr.toBase58()
                if (fsNode.serviceTime < this.option.timeExpired) {
                    console.log(`"CheckFsServerStatus ${fsNodeAddr} error: fsNode.ServiceTime(${fsNode.serviceTime}) 
                    < opt.TimeExpired(${this.option.timeExpired})"`)
                    continue
                }
                if (fsNode.restVol * 1024 < this.baseInfo.blockCount * common.CHUNK_SIZE) {
                    console.log(`"CheckFsServerStatus ${fsNodeAddr} error: fsNode.RestVol(${fsNode.restVol * 1024})
                     >= fileSize(${this.baseInfo.blockCount * common.CHUNK_SIZE})"`)
                    continue
                }
                if (this.option.pdpInterval < fsNode.minPdpInterval) {
                    console.log(`CheckFsServerStatus  ${fsNodeAddr}error: PdpInterval(${this.option.pdpInterval})
                     >= node's MinPdpInterval(${fsNode.minPdpInterval})`)
                    continue
                }
                let fsNodeNetAddr = `tcp://${fsNode.nodeNetAddr}`
                fsNodeNetAddr = utils.tcpAddrToHTTPAddr(fsNodeNetAddr)
                await this.checkFsServerStatus(sdk.globalSdk().account, fsNodeNetAddr).then(() => {
                    this.baseInfo.fileReceivers[fsNodeNetAddr] = fsNodeAddr
                }).catch((e) => { })
                console.log(`receivers =`, this.baseInfo.fileReceivers)
                if (this.baseInfo.fileReceivers && Object.keys(this.baseInfo.fileReceivers).length == this.option.copyNum) {
                    break
                }
            }
            let receiverLen = 0
            if (this.baseInfo.fileReceivers) {
                receiverLen = Object.keys(this.baseInfo.fileReceivers).length
            }
            if (receiverLen < this.option.copyNum) {
                throw new Error(`find fs receivers count(${receiverLen}) less than copyNum(${this.option.copyNum})`)
            }
            this.baseInfo.progress = Upload_FindReceivers
        }

        if (this.baseInfo.progress < Upload_FilePreTransfer) {
            this.baseInfo.allOffset = await sdk.globalSdk().fs.getFileAllBlockHashAndOffset(this.baseInfo.fileHash).catch((e) => {
                throw e
            })
            this.baseInfo.progress = Upload_FilePreTransfer
        }
        await this.blocksSend().catch((e) => {
            throw e
        })
        console.log("block send this.baseInfo.allOffse", this.baseInfo)

        if (this.baseInfo.progress < Upload_WaitPdpRecords) {
            let waitPdpSecond = 0
            let isPdpCommitted = false
            let checkPdpErr
            while (true) {
                await utils.sleep(common.UPLOAD_WAIT_PDP_RECIRDS_INTERVAL * 1000)
                waitPdpSecond += common.UPLOAD_WAIT_PDP_RECIRDS_INTERVAL
                if (waitPdpSecond >= common.MAX_UPLOAD_WAIT_PDP_RECORDS_TIMEWAIT) {
                    if (isPdpCommitted) {
                        console.log(`pdp commit true`)
                        break
                    }
                    checkPdpErr = new Error(`wait pdp prove records failed`)
                    break
                }
                try {
                    const pdpRecordList = await sdk.globalSdk().ontFs.getFilePdpRecordList(this.baseInfo.fileHash)
                    console.log("pdpRecordList", pdpRecordList)
                    isPdpCommitted = (pdpRecordList && pdpRecordList.pdpRecords &&
                        pdpRecordList.pdpRecords.length == Object.keys(this.baseInfo.fileReceivers).length)
                } catch (e) {
                    console.log(`get file pdp record list err ${e.toString()}`)
                    checkPdpErr = e
                    break
                }
                if (isPdpCommitted) {
                    console.log(`pdp commit true`)
                    break
                }
            }
            if (checkPdpErr) {
                throw checkPdpErr
            }
            this.baseInfo.progress = Upload_WaitPdpRecords
        }
        console.log("pdp finish")
    }

    start() {
        if (this.baseInfo.status == TaskStart) {
            throw new Error("Task is already start.")
        }
        if (this.baseInfo.status == TaskFinish) {
            throw new Error("Task is already finished.")
        }
        if (this.baseInfo.progress == Upload_Error) {
            throw new Error(`Start task error: ${this.baseInfo.errorInfo}`)
        }
        this.upload().then(() => {
            this.baseInfo.status = TaskFinish
        }).catch((e) => {
            console.log(`file upload failed`, e.toString())
            this.baseInfo.progress = Upload_Error
            this.baseInfo.errorInfo = e.toString()
            this.baseInfo.status = TaskFinish
        })
    }

    resume() {
        this.start()
    }

    stop() {
    }

    async clean() {
        if (this.baseInfo.status == TaskFinish || this.baseInfo.status == TaskPause) {

        } else {
            if (this.baseInfo.status == TaskStart) {
                throw new Error("Task clean error: task is running")
            }
        }
    }

    async checkFsServerStatus(account, nodeNetAddr) {
        const sessionId = getUploadSessionId(this.baseInfo.taskID, nodeNetAddr)
        const msg = message.newFileMsg(this.baseInfo.fileHash, message.FILE_OP_UPLOAD_ASK, [
            message.withSessionId(sessionId),
            message.withBlockHashes(this.baseInfo.blockHashes),
            message.withWalletAddress(account.address.toBase58()),
            message.withTxHash(this.baseInfo.storeTxHash),
            message.withTxHeight(this.baseInfo.storeTxHeight),
        ])
        try {
            const fileAskRet = await client.httpSendWithRetry(msg, nodeNetAddr, 1, 30)
            if (!fileAskRet.data) {
                throw new Error(`send file ask msg err`)
            }
            console.log("fileAskRet.data", fileAskRet.data)
            console.log(`p2p broadcast file ask msg ret `, message.decodeMsg(fileAskRet.data))
        } catch (e) {
            console.log(`wait file receivers broadcast err ${e.toString()} `)
            throw e
        }
    }

    async blocksSend() {
        if (this.baseInfo.progress < Upload_FileTransferBlocks) {
            let promiseList = []
            for (let peerNetAddr in this.baseInfo.fileReceivers) {
                const peerAddr = this.baseInfo.fileReceivers[peerNetAddr]
                const peerUploadInfo = {
                    index: 0,
                    peerWalletAddr: peerAddr,
                }
                const peerUploadNotify = {}
                this.transferInfo.blockSendDetails[peerNetAddr] = peerUploadInfo
                this.transferInfo.blockSendNotify[peerNetAddr] = peerUploadNotify
                // const sessionId = getUploadSessionId(this.baseInfo.taskID, peerNetAddr)
                const promise = new Promise((resolve, reject) => {
                    this.sendBlockToPeer(peerNetAddr).then(() => {
                        resolve()
                    }).catch((e) => {
                        console.log(`send block to peer error ${e.toString()} `)
                        resolve()
                    })
                })
                promiseList.push(promise)
            }
            this.baseInfo.progress = Upload_FileTransferBlocks
            console.log("this.baseInfo.progress", this.baseInfo.progress)
            try {
                await Promise.all(promiseList)
                this.baseInfo.progress = Upload_Done
            } catch (e) {

            }
        }
    }

    async sendBlockToPeer(peerNetAddr) {
        const blockSendDetail = this.transferInfo.blockSendDetails[peerNetAddr]
        const newFileResp = await this.sendFetchReadyMsg(peerNetAddr).catch((e) => {
            console.log(`notify fetch ready msg failed, err ${e.toString()} `)
            throw e
        })
        if (newFileResp.error && newFileResp.error.code != message.MSG_ERROR_CODE_NONE) {
            console.log(`receive rdy msg reply err ${newFileResp.error.code}, msg ${newFileResp.error.message} `)
            throw new Error(`receive rdy msg reply err ${newFileResp.error.code}, msg ${newFileResp.error.message} `)
        }
        const respFileMsg = newFileResp.payload
        console.log(`respFileMsg`, blockSendDetail, peerNetAddr)
        console.log('respFileMsg.breakpoint', respFileMsg.breakpoint)
        if (respFileMsg.breakpoint && respFileMsg.breakpoint.hash && respFileMsg.breakpoint.hash.length &&
            respFileMsg.breakpoint.index && respFileMsg.breakpoint.index < this.baseInfo.blockCount &&
            this.baseInfo.blockHashes[respFileMsg.breakpoint.index] == respFileMsg.breakpoint.hash) {
            blockSendDetail.index = respFileMsg.breakpoint.index + 1
        }
        let toBeSentBlocks = []
        for (let blockIndex = blockSendDetail.index; blockIndex < this.baseInfo.blockCount; blockIndex++) {
            const blockHash = this.baseInfo.blockHashes[blockIndex]
            const blockMsgData = await this.getMsgData(blockHash, blockIndex)
            if (!blockMsgData) {
                throw new Error(`no block msg data to send`)
            }
            const b = {
                index: blockIndex,
                hash: blockHash,
                data: blockMsgData.blockData,
                offset: blockMsgData.offset,
            }
            toBeSentBlocks.push(b)
            if (blockIndex != this.baseInfo.blockCount - 1 && toBeSentBlocks.length < common.MAX_SEND_BLOCK_COUNT) {
                continue
            }
            // console.log("toBeSentBlocks", toBeSentBlocks)
            const blocksAck = await this.sendBlockFlightMsg(peerNetAddr, toBeSentBlocks).catch((e) => {
                throw e
            })
            console.log("blockAck", blocksAck)
            this.cleanMsgData(blocksAck)
            blockSendDetail.index = blockIndex
            toBeSentBlocks = []
        }
    }

    async generateBlockMsgData(hash, index, offset) {
        const block = await sdk.globalSdk().fs.getBlockWithHash(hash).catch((e) => {
            throw e
        })
        const blockData = sdk.globalSdk().fs.getBlockData(block)
        return {
            blockData: blockData,
            offset: offset,
            refCnt: this.option.copyNum,
        }
    }

    async sendBlockFlightMsg(peerAddr, blocks) {
        if (!blocks || !blocks.length) {
            console.log(`task ${this.baseInfo.taskID} has no block to send`)
            return 0
        }
        for (let block of blocks) {
            block.Hash = block.hash
            block.Index = block.index
            block.Offset = block.offset
            block.Data = utils.hex2base64str(block.data)
            delete block['hash']
            delete block['index']
            delete block['offset']
            delete block['data']
        }
        const sessionId = getUploadSessionId(this.baseInfo.taskID, peerAddr)
        const flights = {
            SessionId: sessionId,
            FileHash: this.baseInfo.fileHash,
            Operation: message.BLOCK_FLIGHTS_OP_PUSH,
            Blocks: blocks,
        }
        const msg = message.newBlockFlightMsg(flights)
        // console.log("flights", flights)
        // console.log("msg", msg)
        const ret = await client.httpSend(peerAddr, msg).catch((e) => {
            console.log(`send block err ${e.toString()} `)
            throw e
        })
        if (ret.data) {
            console.log("send block ret", message.decodeMsg(ret.data))
        }
        let blockAck = []
        for (let blk of blocks) {
            blockAck.push({
                hash: blk.Hash,
                index: blk.Index
            })
        }
        return blockAck
    }

    async sendFetchReadyMsg(peerAddr) {
        const sessionId = getUploadSessionId(this.baseInfo.taskID, peerAddr)
        const msg = message.newFileMsg(this.baseInfo.fileHash, message.FILE_OP_UPLOAD_RDY, [
            message.withSessionId(sessionId),
            message.withWalletAddress(sdk.globalSdk().walletAddress()),
            message.withBlocksRoot(this.baseInfo.fileHash),
            message.withTxHash(this.baseInfo.storeTxHash),
            message.withTxHeight(this.baseInfo.storeTxHeight),
            message.withPrefix(this.baseInfo.filePrefix),
            message.withTotalBlockCount(this.baseInfo.blockCount),
        ])
        const newFileResp = await client.httpSendWithRetry(msg, peerAddr, 1, 15).catch((e) => {
            throw e
        })
        if (!newFileResp.data) {
            throw new Error(`get file rdy msg repsone err`)
        }
        const p2pMsg = message.decodeMsg(newFileResp.data)
        console.log(`p2p send file rdy msg ret `, p2pMsg)
        return p2pMsg
    }

    async getMsgData(hash, index) {
        const key = keyOfBlockHashAndIndex(hash, index)
        let data = this.transferInfo.blockMsgDataMap[key]
        if (data) {
            return data
        }
        const offsetKey = `${hash}-${index}`
        const offset = this.baseInfo.allOffset[offsetKey]
        data = await this.generateBlockMsgData(hash, index, offset).catch((e) => {
            throw e
        })
        this.transferInfo.blockMsgDataMap[key] = data
        return data
    }

    cleanMsgData(blocksAck) {
        for (let reqInfo of blocksAck) {
            const { hash, index } = reqInfo
            const key = keyOfBlockHashAndIndex(hash, index)
            const data = this.transferInfo.blockMsgDataMap[key]
            if (!data) {
                continue
            }
            data.refCnt--
            if (data.refCnt > 0) {
                continue
            }
            delete this.transferInfo.blockMsgDataMap[key]
            sdk.globalSdk().fs.returnBuffer(data.blockData)
        }
    }
}


const getFilePrefix = (to) => {
    const filePrefix = new utils.FilePrefix(utils.PREFIX_VERSION, false, 0, "", "", "", to.fileSize, "")
    if (to.encPassword && to.encPassword.length) {
        filePrefix.encryptPwd = to.encPassword
        filePrefix.encryptPwdLen = to.encPassword.length
        filePrefix.encrypt = true
    }
    const prefix = filePrefix.string()
    console.log(`getFilePrefix prefix: ${prefix}, len: ${prefix.length} `)
    return prefix
}

const checkParams = (to) => {
    if (!common.pathExisted(to.filePath)) {
        throw new Error(`[TaskUploadOption] CheckParams file ${to.filePath} not exists`)
    }
    if (!to.fileDesc || !to.fileDesc.length) {
        throw new Error("[TaskUploadOption] CheckParams file desc is missing")
    }

    if (to.fileSize > common.MAX_UPLOAD_FILE_SIZE) {
        throw new Error(`[TaskUploadOption] CheckParams file size out of limit,
            max support ${ common.MAX_UPLOAD_FILE_SIZE} in kb unit`)
    }
    if (parseInt((new Date().getTime()) / 1000) >= to.timeExpired) {
        throw new Error("[TaskUploadOption] CheckParams file expired time error")
    }
    if (to.copyNum <= 0) {
        throw new Error(`[TaskUploadOption] CheckParams file copy num must > 0, (CopyNum: ${to.copyNum})`)
    }
    if (to.copyNum > common.MAX_COPY_NUM) {
        throw new Error(`[TaskUploadOption] CheckParams max copy num limit ${common.MAX_COPY_NUM}, (CopyNum: ${to.copyNum})`)
    }

    if (to.storageType != types.FileStorageTypeUseFile && to.storageType != types.FileStorageTypeUseSpace) {
        throw new Error("[TaskUploadOption] CheckParams file storage type error")
    }
}

const fileHasUploaded = async (fileHash) => {
    const fi = await sdk.globalSdk().ontFs.getFileInfo(fileHash).catch((e) => { })
    if (fi && fi.validFlag) {
        return true
    }
    return false
}

const getFilePdpHashes = async (version, blockHashes) => {
    console.log('getFilePdpHashes blockHashes', blockHashes)
    let filePdpHash = new pdp.FilePdpHashSt(version, [])
    const blockCount = blockHashes.length
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
        const block = await sdk.globalSdk().fs.getBlockWithHash(blockHashes[blockIndex]).catch((e) => {
            throw e
        })
        const pdpBlockHash = sdk.globalSdk().pdpServer.fileBlockHash(block.rawData())
        console.log('pdpBlockHash', pdpBlockHash)
        filePdpHash.blockPdpHashes.push(pdpBlockHash)
    }
    return filePdpHash
}


const getUploadSessionId = (taskId, peerAddr) => {
    return `${taskId}_${peerAddr}_upload`
}

const keyOfBlockHashAndIndex = (hash, index) => {
    return `${hash} -${index} `
}

module.exports = {
    newTaskUpload,
    TaskUpload,
}