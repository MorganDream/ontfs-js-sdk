const { hexstr2str, reverseHex, str2hexstr, StringReader } = require("ontology-ts-sdk").utils;
const { RpcClient } = require("ontology-ts-sdk"); //todo
const { Address, Signature, PublicKey } = require("ontology-ts-sdk").Crypto; // todo
const { client } = require("@ont-dev/ontology-dapi");
const {
	FsNodeInfo,
	FsNodeInfoList,
	SpaceInfo,
	FileInfo,
	FileHashList,
	FsResult,
	ReadPlan,
	ReadPledge,
	PdpRecordList,
	ChallengeList,
	FileReadSettleSlice
} = require("ontology-ts-sdk/fs");
const { sleep } = require("../utils");
const common = require("../common");

class OntFs {
	/**
	 *Creates an instance of OntFs.
	 * @param {Account} _account account object
	 * @param {string} _pwd password for account
	 * @param {string} _chainRpcAddr ontology chain rpc address. e.g http://127.0.0.1:20336
	 * @param {number} [_gasPrice=500] gas price for smart contract transaction
	 * @param {number} [_gasLimit=20000] gas limit for smart contract transaction
	 * @memberof OntFs
	 */
	constructor(_account, _pwd, _chainRpcAddr, _gasPrice = 500, _gasLimit = 20000) {
		client.registerClient({});
		this.account = _account;
		this.walletAddr = _account.address;
		this.password = _pwd;
		this.chainRpcAddr = _chainRpcAddr;
		this.gasPrice = _gasPrice;
		this.gasLimit = _gasLimit;
		this.rpcClient = new RpcClient(_chainRpcAddr);
	}

	/**
	 * pre invoke a native contract
	 *
	 * @param {Transaction} tx
	 * @returns {FsResult}
	 * @memberof OntFs
	 */
	async preInvokeNativeContract(tx) {
		const rawTx = tx.serialize();
		const ret = await this.rpcClient.sendRawTransaction(rawTx, true);
		// console.log('ret', ret)
		const result = FsResult.deserializeHex(ret.result.Result);
		return result;
	}

	/**
	 * Invoke a native contract
	 *
	 * @param {Transaction} tx
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async invokeNativeContract(tx) {
		const signedTx = this.account.signTransaction(this.password, tx);
		const rawTx = signedTx.serialize();
		const ret = await this.rpcClient.sendRawTransaction(rawTx, false);
		console.log("ret", ret);
		if (!ret || !ret.result) {
			throw new Error("result is invalid");
		}
		if (ret && ret.error == 0) {
			try {
				await this.waitForTxConfirmed(common.WAIT_FOR_TX_COMFIRME_TIMEOUT, ret.result);
			} catch (e) {
				throw e;
			}
			return ret.result;
		}
		throw new Error(ret.result);
	}

	/**
	 * wait for a transaction to be confirmed
	 *
	 * @param {number} timeout: timeout, second
	 * @param {string} txHashStr: transaction hash string
	 * @returns {boolean} success or not
	 * @memberof OntFs
	 */
	async waitForTxConfirmed(timeout, txHashStr) {
		if (!timeout) {
			timeout = 1;
		}
		for (let i = 0; i < timeout; i++) {
			await sleep(1000);
			let { result } = await this.rpcClient.getBlockHeightByTxHash(txHashStr);
			if (result > 0) {
				return true;
			}
		}
		throw new Error(`timeout after ${timeout} (s)`);
	}

	/**
	 * get storage node info list
	 *
	 *
	 * @returns {FsNodeInfoList}
	 * @memberof OntFs
	 */
	async getNodeInfoList(limit = 1) {
		return client.api.fs.getNodeInfoList({ count: limit });
	}

	/**
	 * create a storage space
	 *
	 * @param {number} volume: volume size in KB
	 * @param {number} copyNum: copy number
	 * @param {Date} timeExpired: space expired timestamp, second
	 * @returns
	 * @memberof OntFs
	 */
	async createSpace(volume, copyNum, timeExpired) {
		return client.api.fs.sapce.create({
			volume,
			copyNum,
			timeStart: new Date(),
			timeExpired,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 *
	 * get space info for user
	 * @returns {SpaceInfo}
	 * @memberof OntFs
	 */
	async getSpaceInfo() {
		return client.api.fs.space.get();
	}

	/**
	 * delete current user space
	 *
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async deleteSpace() {
		return client.api.fs.space.delete({
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * update a exist space
	 *
	 * @param {number} volume volume size in KB
	 * @param {Date} timeExpired space expired timestamp, second
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async updateSpace(volume, timeExpired) {
		return client.api.fs.space.update({
			volume,
			timeExpired,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * store a file
	 *
	 * @param {Array} files, array of file info object
	 * @returns  {string} tx hash
	 * @memberof OntFs
	 */
	async storeFiles(files) {
		let newFiles = [];
		for (let file of files) {
			let newFile = file;
			newFile.fileHash = str2hexstr(file.fileHash);
			newFile.fileDesc = str2hexstr(file.fileDesc);
			newFile.pdpParam = file.pdpParam;
			newFiles.push(newFile);
		}
		return client.api.fs.storeFiles({
			fileInfo: newFiles,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * get file info of hash
	 *
	 * @param {string} fileHash
	 * @returns {FileInfo}
	 * @memberof OntFs
	 */
	async getFileInfo(fileHash) {
		const fileInfo = await client.api.fs.getFileInfo({ flieHash });
		fileInfo.fileHash = client.api.utils.hexToStr(fileInfo.fileHash);
		fileInfo.fileDesc = client.api.utils.hexToStr(fileInfo.fileDesc);
		fileInfo.pdpParam = client.api.utils.hexToStr(fileInfo.pdpParam);
		return fileInfo;
	}

	/**
	 * get stored file list
	 *
	 * @returns {FileHashList}
	 * @memberof OntFs
	 */
	async getFileList() {
		return client.api.fs.getFileList();
	}

	/**
	 * renew a exist file
	 *
	 * @param {Array} renews: array of renew object
	 * @returns  {string} tx hash
	 * @memberof OntFs
	 */
	async renewFile(renews) {
		for (let item of renews) {
			item.fileHash = str2hexstr(item.fileHash);
		}
		return client.api.fs.renewFile({
			filesRenew: renews,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * change file owner
	 *
	 * @param {Array} renews: array of renew object
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async transferFiles(renews) {
		for (let item of renews) {
			item.fileHash = strhexstr(i2tem.fileHash);
		}
		return client.api.fs.transferFiles({
			fileTransfers: renews,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * delete files
	 *
	 * @param {Array} fileHashes, array of file hashes
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async deleteFiles(fileHashes) {
		let newFileHashes = [];
		for (let item of fileHashes) {
			newFileHashes.push(str2hexstr(item));
		}
		return client.api.fs.deleteFiles({
			fileHashes: newFileHashes,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * make a file read pledge for download
	 *
	 * @param {string} fileHash: file hash to download
	 * @param {Array} plans: plans of download detail
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async fileReadPledge(fileHash, plans) {
		let readPlans = [];
		for (let p of plans) {
			readPlans.push(
				new ReadPlan(new Address(p.nodeAddr), p.maxReadBlockNum, p.haveReadBlockNum, 0)
			);
		}
		return client.api.fs.fileReadPledge({
			fileHash: fileHash,
			readPlans: readPlans,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * get a file read pledge
	 *
	 * @param {string} fileHash  file hash
	 * @param {Address} walletAddr read pledge owner wallet addr
	 * @returns
	 * @memberof OntFs
	 */
	async getFileReadPledge(fileHash, walletAddr) {
		const readPledge = await client.api.fs.getFileReadPledge({
			fileHash,
			downloader: walletAddr
		});
		readPledge.fileHash = hexstr2str(readPledge.fileHash);
		return readPledge;
	}

	/**
	 * cancel the file read pledge
	 *
	 * @param {string} fileHash
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async cancelFileRead(fileHash) {
		return client.api.fs.cancelFileRead({
			fileHash: fileHash,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * get file pdp record list
	 *
	 * @param {string} fileHash
	 * @returns {PdpRecordList}
	 * @memberof OntFs
	 */
	async getFilePdpRecordList(fileHash) {
		return client.api.fs.getFilePdpRecordList({ fileHash });
	}

	/**
	 * challenge a file with a specific node
	 *
	 * @param {string} fileHash
	 * @param {string} nodeAddr node wallet base58 string
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async challenge(fileHash, nodeAddr) {
		return client.api.fs.challenge({
			fileHash,
			nodeAddr,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * judge a file with a specific node
	 *
	 * @param {string} fileHash
	 * @param {string} nodeAddr node wallet base58 string
	 * @returns {string} tx hash
	 * @memberof OntFs
	 */
	async judge(fileHash, nodeAddr) {
		return client.api.fs.judge({
			fileHash,
			nodeAddr,
			gasPrice: this.gasPrice,
			gasLimit: this.gasLimit
		});
	}

	/**
	 * get file challenge list
	 *
	 * @param {string} fileHash
	 * @returns {ChallengeList}
	 * @memberof OntFs
	 */
	async getFileChallengeList(fileHash) {
		return client.api.fs.getFileChallengeList({ fileHash });
	}

	/**
	 * get node info
	 *
	 * @param {string} walletAddr node wallet base58 string
	 * @returns {FsNodeInfo}
	 * @memberof OntFs
	 */
	async getNodeInfo(walletAddr) {
		return client.api.fs.getNodeInfo({
			nodeWallet: walletAddr
		});
	}

	/**
	 * verify file read settle slice
	 *
	 * @param {Object} settleSlice
	 * @returns {boolean}
	 * @memberof OntFs
	 */
	async verifyFileReadSettleSlice(settleSlice) {
		return client.api.fs.verifyFileReadSettleSlice({
			settleSlice
		});
	}

	/**
	 * generate a file read settle slice
	 *
	 * @param {string} fileHash file hash
	 * @param {string} peerWalletAddr node wallet base58 string
	 * @param {number} sliceId slice id
	 * @param {number} blockHeight block height
	 * @returns
	 * @memberof OntFs
	 */
	async genFileReadSettleSlice(fileHash, peerWalletAddr, sliceId, blockHeight) {
		return client.api.fs.genFileReadSettleSlice({
			fileHash,
			payTo: peerWalletAddr,
			sliceId,
			pledgeHeight: blockHeight
		});
	}
}

module.exports = {
	OntFs
};
