const types = require("../types")
const utils = require("../utils")
const common = require("../common")
const sdk = require("../sdk")
const { TaskStart, TaskPause, TaskFinish } = require("./const")
const { hexstr2str } = require("ontology-ts-sdk").utils
const message = require("../network/message")
const client = require("../network/http/http_client")
const Buffer = require('buffer/').Buffer
const { client: dapi } = require("@ont-dev/ontology-dapi")

const Download_AddTask = 0
const Download_FsFoundFileServers = 1
const Download_FsReadPledge = 2
const Download_FsBlocksDownloadOver = 3
const Download_Done = 4
const Download_Error = 5



/**
 * Download Task
 *
 * @class TaskDownload
 */
class TaskDownload {
    constructor(_option, _baseInfo, _transferInfo) {
        this.option = _option
        this.baseInfo = _baseInfo
        this.transferInfo = _transferInfo
    }

    /**
     * start the task
     *
     * @memberof TaskDownload
     */
    start() {
        if (this.baseInfo.status == TaskStart) {
            throw new Error("Task is already start.")
        }
        if (this.baseInfo.status == TaskFinish) {
            throw new Error("Task is already finished.")
        }
        if (this.baseInfo.progress == Download_Error) {
            throw new Error(`Start task error: ${this.baseInfo.errorInfo}`)
        }
        this.download().then(() => {
            this.baseInfo.status = TaskFinish
        }).catch((err) => {
            console.log(`download err ${err.toString()}`)
            this.baseInfo.progress = Download_Error
            this.baseInfo.errorInfo = err.toString()
            this.baseInfo.status = TaskFinish
        })
    }

    /**
     * resume the task
     *
     * @memberof TaskDownload
     */
    resume() {
        this.start()
    }

    /**
     * stop the task
     *
     * @memberof TaskDownload
     */
    stop() {
    }

    /**
     * clean the task
     *
     * @memberof TaskDownload
     */
    async clean() {
        if (this.baseInfo.status == TaskFinish || this.baseInfo.status == TaskPause) {

        } else {
            if (this.baseInfo.status == TaskStart) {
                throw new Error("Task clean error: task is running")
            }
        }
    }

    /**
     * start download
     *
     * @memberof TaskDownload
     */
    async download() {
        this.baseInfo.status = TaskStart
        if (this.baseInfo.progress < Download_FsFoundFileServers) {
            const fileInfo = await sdk.globalSdk().ontFs.getFileInfo(this.option.fileHash).catch((err) => {
                throw new Error(`get file info err: ${err.toString()}`)
            })
            if (!fileInfo) {
                throw new Error(`get file info nil`)
            }
            const pdpRecordList = await sdk.globalSdk().ontFs.getFilePdpRecordList(this.option.fileHash).catch((err) => {
                throw err
            })
            if (!pdpRecordList || !pdpRecordList.pdpRecords || !pdpRecordList.pdpRecords.length) {
                throw new Error("no available fs nodes to download file: no node had commit pdp prove data")
            }
            let nodeAddrs = []
            let walletAddrs = []
            for (let pdpRecord of pdpRecordList.pdpRecords) {
                const nodeInfo = await sdk.globalSdk().ontFs.getNodeInfo(pdpRecord.nodeAddr).catch((e) => {
                    console.log(`get node ${pdpRecord.nodeAddr} info err: ${e.toString()}`)
                })
                if (!nodeInfo) {
                    continue
                }
                const nodeHttpAddr = common.getHTTPAddrFromNodeNetAddr(nodeInfo.nodeNetAddr)
                if (!nodeHttpAddr || nodeHttpAddr == "") {
                    console.log(`GetTcpAddrFromNodeNetAddr ${nodeInfo.nodeNetAddr} error:` +
                        ` server(${nodeInfo.nodeAddr.tBase58()}) doesn't support tcp protocol`)
                    continue

                }
                nodeAddrs.push(nodeHttpAddr)
                walletAddrs.push(walletAddrs, pdpRecord.nodeAddr)
            }
            if (!nodeAddrs.length || !walletAddrs.length) {
                throw new Error(`no available fs nodes to download file: get nodes information error`)
            }
            this.baseInfo.fileBlockCount = fileInfo.fileBlockCount
            this.baseInfo.fileDesc = fileInfo.fileDesc
            this.baseInfo.fileServerNetAddrs = nodeAddrs
            this.baseInfo.progress = Download_FsFoundFileServers
        }
        await this.blocksDownload().catch((err) => {
            throw err
        })
    }

    /**
     * download blocks from peer
     *
     * @memberof TaskDownload
     */
    async blocksDownload() {
        this.initMicroTasks()
        const account = await dapi.api.asset.getAccount();
        await this.getValidServers(account).catch((err) => {
            throw err
        })
        await this.pledge().catch((err) => {
            throw err
        })
        this.transferInfo.combineInfo.combinedBlockNum = 0
        this.transferInfo.combineInfo.isFileEncrypted = utils.getPrefixEncrypted(this.baseInfo.filePrefix)
        this.transferInfo.combineInfo.hasCutPrefix = false
        let promiseList = []
        for (let [peerNetAddr, peerDownloadInfo] of Object.entries(this.transferInfo.blockDownloadInfo)) {
            console.log(`StartRoutine (${peerDownloadInfo.peerWallet} ${peerNetAddr})`)
            const promise = new Promise(async (resolve, reject) => {
                const routineInfo = `TaskId: ${this.baseInfo.taskID} FileHash: ${this.option.fileHash}` +
                    ` Node[${peerDownloadInfo.peerWallet} ${peerNetAddr}]`
                while (true) {
                    const blocksReqObj = await this.getBlocksReq()
                    if (!blocksReqObj) {
                        console.log(`${routineInfo} DownloadBlockFlightsFromPeer getBlocksReq return nil`)
                        break
                    }
                    const { blocksReq, taskIndex } = blocksReqObj
                    if (!blocksReq) {
                        console.log(`DownloadBlockFlightsFromPeer getBlocksReq return nil`)
                        break
                    }
                    const blocksResp = await this.downloadBlockFlightsFromPeer(
                        peerNetAddr, peerDownloadInfo.peerWallet, blocksReq).catch((err) => {
                            console.log(`DownloadBlockFlightsFromPeer error: ${err.toString()}`)
                            // promiseErr = err
                        })
                    console.log('blockResponses', blocksResp ? blocksResp.length : 0)
                    if (!blocksResp) {
                        console.log(`${routineInfo} DownloadBlockFlightsFromPeer error: blocksResp is nil`)
                        this.transferInfo.microTasks[taskIndex].status = types.BlockTaskUnStart
                        break
                    }
                    for (let blockResp of blocksResp) {
                        console.log(`${routineInfo} Process BlockResp: ${blockResp.index}, ${blockResp.hash}`)
                        this.transferInfo.blockDownloadNotify.respNotify = blockResp
                        await this.combine().catch((err) => {
                            console.log("combine err", err)
                        })
                    }
                    this.transferInfo.microTasks[taskIndex].status = types.BlockTaskComplete
                }
                this.fileDownloadOk(peerNetAddr)
                this.transferInfo.blockDownloadInfo[peerNetAddr].routineStatus = types.RoutineExit
                console.log(`ExitRoutine ${routineInfo}`)
                resolve()
            })
            promiseList.push(promise)
        }
        await Promise.all(promiseList).catch((err) => {
            console.log(`promise download block flights from peer ${err.toString()}`)
        })
        console.log('DownloadBlockFlightsFromPeer finished', this.transferInfo.combineInfo.combinedBlockNum, this.baseInfo.fileBlockCount)
        this.transferInfo.blockDownloadNotify.respNotify = null
        if (this.transferInfo.combineInfo.combinedBlockNum != this.baseInfo.fileBlockCount) {
            await this.combine().catch((err) => {
                console.log("combine err", err)
                this.baseInfo.errorInfo = err.toString()
                this.transferInfo.blockDownloadNotify.finished = false
                throw err
            })
            this.baseInfo.progress = Download_Done
            this.transferInfo.blockDownloadNotify.finished = true
        } else {
            this.baseInfo.progress = Download_Done
            this.transferInfo.blockDownloadNotify.finished = true
        }
    }
    /**
     * init micro tasks object
     *
     * @memberof TaskDownload
     */
    initMicroTasks() {
        for (let index = 0; index < this.baseInfo.fileBlockCount; index += common.MAX_REQ_BLOCK_COUNT) {
            const microTaskInfo = {
                beginIndex: index,
                status: types.BlockTaskUnStart,
            }
            this.transferInfo.microTasks.push(microTaskInfo)
        }
    }

    /**
     * get blocks request
     *
     * @returns {Object}
     * @memberof TaskDownload
     */
    async getBlocksReq() {
        let currTaskIndex = 0
        const microTaskTotalNum = this.transferInfo.microTasks ? this.transferInfo.microTasks.length : 0
        if (!microTaskTotalNum) {
            return
        }
        while (true) {
            let completeTaskCount = 0
            for (currTaskIndex = 0; currTaskIndex < microTaskTotalNum; currTaskIndex++) {
                if (this.transferInfo.microTasks[currTaskIndex].status == types.BlockTaskUnStart) {
                    break
                } else if (this.transferInfo.microTasks[currTaskIndex].status == types.BlockTaskComplete) {
                    completeTaskCount++
                }
            }
            if (completeTaskCount == microTaskTotalNum) {
                return
            } else if (currTaskIndex == microTaskTotalNum) {
                await utils.sleep(1000)
            } else {
                break
            }
        }
        const beginReqIndex = this.transferInfo.microTasks[currTaskIndex].beginIndex
        let blocksReq = []
        for (let i = 0; i < common.MAX_REQ_BLOCK_COUNT; i++) {
            const blockReqIndex = beginReqIndex + i
            if (blockReqIndex >= this.baseInfo.fileBlockCount) {
                break
            }
            const blockHash = this.baseInfo.fileBlockHashes[blockReqIndex]
            const req = {
                Index: blockReqIndex,
                Hash: blockHash,
            }
            blocksReq.push(req)
        }
        console.log(`blocksReq len`, blocksReq.length)
        this.transferInfo.microTasks[currTaskIndex].status = types.BlockTaskStart
        return {
            blocksReq: blocksReq,
            taskIndex: currTaskIndex
        }
    }

    /**
     * handler of block download ask
     *
     * @param {Object} res: response msg
     * @param {string} addr: peer http host address
     * @returns {boolean} stop broadcast or not
     * @memberof TaskDownload
     */
    async responseProcess(res, addr) {
        if (!res || !res.data) {
            return false
        }
        if (this.transferInfo.blockDownloadInfo &&
            Object.keys(this.transferInfo.blockDownloadInfo).length >= this.option.maxPeerCnt) {
            console.log('stop here')
            return true
        }
        console.log('res.data', res.data)
        const msg = message.decodeMsg(res.data)
        console.log('msg', msg)
        if (msg.error) {
            console.log(`get download ack err ${JSON.stringify(msg.error)} from ${addr}`)
            return false
        }
        const fileMsg = msg.payload
        if (!fileMsg.prefix) {
            console.log(`get file prefix empty from ${addr}`)
            return false
        }
        const filePrefix = new utils.FilePrefix()
        filePrefix.fromString(fileMsg.prefix)
        if (!this.baseInfo.filePrefix || !this.baseInfo.filePrefix.length) {
            this.baseInfo.filePrefix = fileMsg.prefix
        } else {
            if (fileMsg.prefix != this.baseInfo.filePrefix) {
                console.log(`file prefix not equal last`)
                return false
            }
        }

        if (this.baseInfo.fileBlockCount) {
            if (!fileMsg.blockHashes || fileMsg.blockHashes.length != this.baseInfo.fileBlockCount) {
                console.log(`BlockHashes count not equal last`)
                return false
            }
        } else {
            this.baseInfo.fileBlockCount = fileMsg.blockHashes ? fileMsg.blockHashes.length : 0
        }
        if (!this.baseInfo.fileBlockHashes) {
            this.baseInfo.fileBlockHashes = fileMsg.blockHashes
        }

        if (this.option.decryptPwd && this.option.decryptPwd.length &&
            !filePrefix.verifyEncryptPassword(this.option.decryptPwd)) {
            console.log(`encrypt password not match hash`)
            return false
        }
        if (!fileMsg.payInfo) {
            console.log(`get download ack, no payInfo`)
            return false
        }

        let latestSliceId = 0
        let settleSlice = {}
        try {
            if (fileMsg.payInfo.latestPayment && fileMsg.payInfo.latestPayment.length) {
                const sliceObj = JSON.parse(utils.base64str2utf8str(fileMsg.payInfo.latestPayment))
                settleSlice = {
                    fileHash: utils.base64str2utf8str(sliceObj.FileHash),
                    payFrom: utils.bytes2address(sliceObj.PayFrom),
                    payTo: utils.bytes2address(sliceObj.PayTo),
                    sliceId: sliceObj.SliceId,
                    pledgeHeight: sliceObj.PledgeHeight,
                    sig: utils.base64str2hex(sliceObj.Sig),
                    pubKey: utils.base64str2hex(sliceObj.PubKey),
                }
                console.log('check payment', fileMsg.payInfo.latestPayment, settleSlice)
                if (settleSlice.fileHash != this.option.fileHash) {
                    console.log(`file hash in the settle slice ${settleSlice.fileHash} is 
                    not same as in the msg ${this.option.fileHash}`)
                    return false
                }
                if (settleSlice.payFrom.toBase58() != sdk.globalSdk().walletAddress()) {
                    console.log(`"payer ${settleSlice.payFrom.toBase58()} in the settle slice is 
                    not same as in the msg ${sdk.globalSdk().walletAddress()}"`)
                    return false
                }
                const ok = await sdk.globalSdk().ontFs.verifyFileReadSettleSlice(settleSlice)
                if (!ok) {
                    console.log(`check sign in the settle slice failed`)
                    return false
                }
                latestSliceId = settleSlice.sliceId
            }
        } catch (err) {
            console.log('process response err', err)
            return false
        }

        this.transferInfo.blockDownloadInfo[addr] = {
            index: 0,
            peerWallet: fileMsg.payInfo.walletAddress,
            sliceId: latestSliceId,
            totalCount: 0,
        }
        console.log('response process', this.transferInfo.blockDownloadInfo)
        return false
    }

    /**
     * get valid servers for download the file
     *
     * @param {Account} account: current account
     * @memberof TaskDownload
     */
    async getValidServers(account) {
        const msg = message.newFileMsg(this.option.fileHash, message.FILE_OP_DOWNLOAD_ASK, [
            message.withWalletAddress(account),
        ])
        const action = async (res, addr) => {
            const result = await this.responseProcess(res, addr)
            return result
        }
        console.log("get valid msg", msg)
        await client.httpBroadcast(this.baseInfo.fileServerNetAddrs, msg, true, action).catch((err) => {
            console.log(`broadcast err ${err.toString()}`)
            throw err
        })
        // console.log("broadcast file download ask msg ret", message.decodeMsg(ret.data))
        console.log("peers:", Object.keys(this.transferInfo.blockDownloadInfo).length)
        if (!this.transferInfo.blockDownloadInfo ||
            Object.keys(this.transferInfo.blockDownloadInfo).length == 0) {
            throw new Error(`no fs nodes available when ask for download `)
        }
    }

    /**
     * make read pledge for file
     *
     * @memberof TaskDownload
     */
    async pledge() {
        let readPlan = []
        for (let [peerAddr, peerDownloadInfo] of Object.entries(this.transferInfo.blockDownloadInfo)) {
            let plan = {
                nodeAddr: peerDownloadInfo.peerWallet,
                maxReadBlockNum: this.baseInfo.fileBlockCount,
                haveReadBlockNum: 0,
                numOfSettlements: 0
            }
            readPlan.push(plan)
        }
        console.log('readPlan', readPlan)
        const readPledgeRet = await sdk.globalSdk().ontFs.fileReadPledge(this.option.fileHash, readPlan).catch((err) => {
            console.log(`read file pledge err: ${err.toString()}`)
            throw err
        })
        console.log('readPledgeRet', readPledgeRet)
        const account = await dapi.api.asset.getAccount();
        const readPledge = await sdk.globalSdk().ontFs.getFileReadPledge(this.option.fileHash,
            account).catch((err) => {
                console.log(`contract interface FileReadPledge called failed`)
                throw err
            })
        console.log("readPledge", readPledge)
        this.baseInfo.readPlanTx = readPledgeRet
        this.baseInfo.progress = Download_FsReadPledge
    }

    /**
     * download blocks from peer
     *
     * @param {string} peerNetAddr peer http host address
     * @param {string} peerWalletAddr peer wallet base58 address
     * @param {Object} blocksReq download block request
     * @returns
     * @memberof TaskDownload
     */
    async downloadBlockFlightsFromPeer(peerNetAddr, peerWalletAddr, blocksReq) {
        console.log(`DownloadBlockFlightsFromPeer(${peerWalletAddr} ${peerNetAddr}) begin, Routine start`)
        const peerTransferInfo = this.transferInfo.blockDownloadInfo[peerNetAddr]
        peerTransferInfo.index = blocksReq[0].Index
        const sessionId = getDownloadSessionId(this.baseInfo.taskID, peerTransferInfo.peerWallet)
        const account = await dapi.api.asset.getAccount();
        const reqMsg = message.newBlockFlightsReqMsg(this.option.fileHash, account,
            blocksReq, message.BLOCK_FLIGHTS_OP_GET, [message.withSessionId(sessionId)])
        console.log('reqMsg', reqMsg, peerNetAddr)
        const blocksReqM = {}
        for (let req of blocksReq) {
            blocksReqM[keyOfBlockHashAndIndex(req.Hash, req.Index)] = {}
        }
        const resp = await client.httpSendWithRetry(reqMsg, peerNetAddr, 5, 30).catch((err) => {
            console.log(`send download block flights msg err: ${err.toString()}`)
            throw err
        })
        if (!resp || !resp.data) {
            console.log("resp.data", resp.data)
            throw new Error(`receive invalid msg from peer ${peerNetAddr}`)
        }
        // console.log('resp.data', resp.data)
        const msg = message.decodeMsg(resp.data)
        // console.log('send download block flights msg, resp', msg)
        if (!msg) {
            console.log("resp.data", resp.data)
            throw new Error(`receive invalid msg from peer ${peerNetAddr}`)
        }
        if (!msg.payload || !msg.payload.blocks || !msg.payload.blocks.length) {
            throw new Error(`receive empty block flights of task ${this.baseInfo.taskID}`)
        }
        const blockFlightsMsg = msg.payload
        console.log(`taskID: ${this.baseInfo.taskID}, sessionID: ${blockFlightsMsg.sessionId},` +
            ` receive ${blockFlightsMsg.blocks ? blockFlightsMsg.blocks.length : 0} blocks from peer: ${peerNetAddr}`)
        let blocksResp = []
        for (let blockMsg of blockFlightsMsg.blocks) {
            const blockRespKey = keyOfBlockHashAndIndex(blockMsg.hash, blockMsg.index)
            if (!blocksReqM[blockRespKey]) {
                console.log(`block ${blockMsg.hash}-${blockMsg.index} is not match any request task`)
                throw new Error(`block ${blockRespKey} is not match request task`)
            }
            // console.log('received blockMsg.data', blockMsg.data)
            const block = sdk.globalSdk().fs.encodedToBlockWithCid(Buffer.from(blockMsg.data, 'hex'), blockMsg.hash)
            // console.log('encode block ', blockMsg.data, blockMsg.hash)
            // console.log('encode block result ', block)
            if (!block || block.cid.toString() != blockMsg.hash) {
                console.log(`receive wrong block ${blockMsg.hash}-${blockMsg.index}`)
                throw new Error(`receive wrong block ${blockMsg.hash}-${blockMsg.index}`)
            }
            blocksResp.push({
                hash: blockMsg.hash,
                index: blockMsg.index,
                block: blockMsg.data,
                offset: blockMsg.offset,
                paymentId: blockFlightsMsg.payment.paymentId,
                peerAddr: peerNetAddr,
            })
        }
        const blocksRespCount = blocksResp.length
        if (blocksRespCount != blocksReq.length) {
            console.log(`blocksResp is not match request`)
            throw new Error(`blocksRespCount(${blocksRespCount}) is not match blocksReqCount(${blocksReq.length})`)
        }
        let blockHashes = []
        for (let req of blocksReq) {
            blockHashes.push(req.Hash)
        }
        console.log('blockHashes', blockHashes)
        peerTransferInfo.totalCount += blocksRespCount
        await this.payForBlocks(peerNetAddr, peerWalletAddr, peerTransferInfo.sliceId + peerTransferInfo.totalCount,
            blockHashes, blocksResp[0].paymentId).catch((err) => {
                // throw err
            })
        return blocksResp
    }

    /**
     * send file download ok msg to peer
     *
     * @param {string} peerNetAddr peer http host address
     * @memberof TaskDownload
     */
    async fileDownloadOk(peerNetAddr) {
        const sessionId = getDownloadSessionId(this.baseInfo.taskID, peerNetAddr)
        const fileDownloadOkMsg = message.newFileMsg(this.option.fileHash,
            message.FILE_OP_DOWNLOAD_OK,
            [
                message.withSessionId(sessionId),
                message.withWalletAddress(sdk.globalSdk().walletAddress())
            ])
        await client.httpBroadcast([peerNetAddr], fileDownloadOkMsg, false, null).then(() => { }).catch((err) => {
            console.log(`fileDownloadOk msg P2pBroadcast error`)
        })
    }

    /**
     * pay for downloaded blocks to peers
     *
     * @param {string} peerNetAddr peer http host address
     * @param {string} peerWalletAddr peer wallet base58 address
     * @param {number} sliceId settle slice id
     * @param {Array} blockHashes block hashes array
     * @param {number} paymentId payment id from peer 
     * @memberof TaskDownload
     */
    async payForBlocks(peerNetAddr, peerWalletAddr, sliceId, blockHashes, paymentId) {

        console.log(`paying to node peer addr ${peerNetAddr}, wallet addr ${sdk.globalSdk().walletAddress()}` +
            `, sliceId: ${sliceId}`)
        const fileReadSlice = await sdk.globalSdk().ontFs.genFileReadSettleSlice(this.option.fileHash,
            peerWalletAddr, sliceId, 0).catch((err) => {
                throw err
            })
        const sliceData = {
            FileHash: utils.str2base64(hexstr2str(fileReadSlice.fileHash)),
            PayFrom: utils.address2bytestr(fileReadSlice.payFrom),
            PayTo: utils.address2bytestr(fileReadSlice.payTo),
            SliceId: fileReadSlice.sliceId,
            PledgeHeight: fileReadSlice.pledgeHeight,
            Sig: utils.hex2base64str(fileReadSlice.sig.serializeHex()),
            PubKey: utils.hex2base64str(fileReadSlice.pubKey.serializeHex()),
        }
        // console.log('fileReadSlice', fileReadSlice, fileReadSlice.sig.serializeHex(), fileReadSlice.pubKey.serializeHex())
        // console.log('sliceData', sliceData)

        const msg = message.newPaymentMsg(fileReadSlice.payFrom.toBase58(), fileReadSlice.payTo.toBase58(),
            message.PAYMENT_OP_PAY, paymentId, this.option.fileHash, blockHashes, sliceData,
            [message.withWalletAddress(sdk.globalSdk().walletAddress())])
        // console.log('payment msg', msg)

        const ret = await client.httpSendWithRetry(msg, peerNetAddr, common.MAX_NETWORK_REQUEST_RETRY,
            common.P2P_REQUEST_WAIT_REPLY_TIMEOUT).catch((err) => {
                console.log(`paymentMsg payment id ${paymentId}, for file: ${this.option.fileHash},` +
                    ` error: ${err.toString()}`)
            })
        if (!ret.data) {
            throw new Error(``)
        }
        console.log(`payment msg response:`, message.decodeMsg(ret.data))
    }

    /**
     * handler for downloaded block
     *
     * @memberof TaskDownload
     */
    async combine() {
        let hasCutPrefix = this.transferInfo.combineInfo.hasCutPrefix
        const isFileEncrypted = this.transferInfo.combineInfo.isFileEncrypted
        const file = this.transferInfo.combineInfo.fileStream
        const value = this.transferInfo.blockDownloadNotify.respNotify

        if (value) {
            console.log(`received block ${this.option.fileHash}-${value.hash}-${value.index} from ` +
                `${value.peerAddr}`)
            const block = sdk.globalSdk().fs.encodedToBlockWithCid(Buffer.from(value.block, 'hex'), value.hash)
            if (block.cid.toString() != value.hash) {
                console.log(`receive a unmatched hash block ${block.cid.toString()} ${value.hash}`)
                throw new Error(`receive a unmatched hash block ${block.cid.toString()} ${value.hash}`)
            }
            const links = await sdk.globalSdk().fs.getBlockLinks(block).catch((err) => {
            })
            console.log('get links of block', block.cid, links ? links.length : 0)
            if (!links || !links.length) {
                let data = sdk.globalSdk().fs.getBlockData(block)
                let writeAtPos = value.offset
                if (!isFileEncrypted && !hasCutPrefix && data.length > this.baseInfo.filePrefix.length &&
                    data.toString().substr(0, this.baseInfo.filePrefix.length) == this.baseInfo.filePrefix) {
                    data = data.slice(this.baseInfo.filePrefix.length)
                    hasCutPrefix = true
                    console.log('cut prefix')
                    this.transferInfo.combineInfo.hasCutPrefix = true
                }
                if (value.offset > 0 && !isFileEncrypted && hasCutPrefix) {
                    writeAtPos = value.offset - this.baseInfo.filePrefix.length
                }
                console.log(`block ${block.cid.toString()} block-len ${data.length}, offset ${value.offset}` +
                    ` prefix ${this.baseInfo.filePrefix}, pos ${writeAtPos}`)
                if (this.option.receiveBlock) {
                    this.option.receiveBlock(data, data.length, writeAtPos)
                }
            }
            console.log(`${this.option.fileHash}-${value.hash}-${value.index} set downloaded`)
        }
        this.transferInfo.combineInfo.combinedBlockNum++
        if (this.transferInfo.combineInfo.combinedBlockNum != this.baseInfo.fileBlockCount) {
            let exitDownloadRoutineCount = 0
            console.log('this.transferInfo.blockDownloadInfo', this.transferInfo == undefined, this.transferInfo.blockDownloadInfo == undefined)
            for (let [_, peerDownloadInfo] of Object.entries(this.transferInfo.blockDownloadInfo)) {
                if (peerDownloadInfo.routineStatus == types.RoutineExit) {
                    exitDownloadRoutineCount += 1
                }
            }
            if (this.transferInfo.blockDownloadInfo &&
                exitDownloadRoutineCount == Object.keys(this.transferInfo.blockDownloadInfo)) {
                throw new Error("[Combine] all download routine exited but blocks is not complete")
            }
            return
        }
        this.baseInfo.progress = Download_FsBlocksDownloadOver
    }
}

/** 
 * init a download task
 *
 * @param {string} taskID taskID
 * @param {Object} option download option
 * @param {Object} baseInfo base info, for a new task, it is null
 * @param {Object} transferInfo transfer info, for a new task, it is null
 * @returns
 */
const newTaskDownload = async (taskID, option, baseInfo, transferInfo) => {
    if (!baseInfo && !transferInfo) {
        try {
            await checkDownloadParams(option)
        } catch (err) {
            throw err
        }
    }

    let taskDownload = new TaskDownload(option)
    if (baseInfo) {
        taskDownload.baseInfo = baseInfo
    } else {
        taskDownload.baseInfo = {
            taskID: taskID,
            progress: Download_AddTask,
        }
    }
    if (taskDownload.baseInfo.status != TaskFinish) {
        taskDownload.baseInfo.status = TaskPause
    }
    if (transferInfo) {
        transferInfo.blockDownloadNotify = {
            finished: {},
            respNotify: {},
        }
        taskDownload.transferInfo = transferInfo
    } else {
        const transferInfo = {}
        transferInfo.blockDownloadInfo = {}
        transferInfo.combineInfo = {}
        transferInfo.blockDownloadNotify = {
            finished: {},
            respNotify: {},
        }
        transferInfo.microTasks = []
        taskDownload.transferInfo = transferInfo
    }
    return taskDownload
}

/**
 * check download params
 *
 * @param {Object} to download option
 */
const checkDownloadParams = async (to) => {
    if (!to.inOrder) {
        throw new Error("[TaskDownloadOption] checkParams param inOrder should be true")
    }
    if (!to.fileHash || !to.fileHash.length) {
        throw new Error("[TaskDownloadOption] checkParams param fileHash error")
    }
    const fileInfo = await sdk.globalSdk().ontFs.getFileInfo(to.fileHash).catch((err) => {
        throw new Error(`[TaskDownloadOption] checkParams file(hash: ${to.fileHash}) is not exist, err ${err.toString()}`)
    })
    if (!fileInfo) {
        throw new Error(`[TaskDownloadOption] checkParams file(hash: ${to.fileHash}) is not exist, err ${err.toString()}`)
    }
}

/**
 * get session id with peer
 *
 * @param {string} taskId
 * @param {string} peerAddr
 * @returns
 */
const getDownloadSessionId = (taskId, peerAddr) => {
    return `${taskId}_${peerAddr}_download`
}


/**
 * decrypt a downloaded file
 *
 * @param {ArrayBuffer} fileContent: encrypted array buffer
 * @param {string} decryptPwd : encrypted password
 * @returns {ArrayBuffer} : decrypted array buffer
 */
const decryptDownloadedFile = async (fileContent, decryptPwd) => {
    try {
        const data = sdk.globalSdk().decryptDownloadedFile(fileContent, decryptPwd)
        return data
    } catch (e) {
        console.log('decrypt file err', e)
        throw e
    }
}

/**
 * get key of block hash and index
 *
 * @param {string} hash
 * @param {number} index
 * @returns
 */
const keyOfBlockHashAndIndex = (hash, index) => {
    return `${hash}-${index}`
}

module.exports = {
    newTaskDownload,
    TaskDownload,
    decryptDownloadedFile
}