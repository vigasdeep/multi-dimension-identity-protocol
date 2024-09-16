const path = require('path');
const { randomBytes } = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const bitcoinMessage = require('bitcoinjs-message');
const Tx = require('ethereumjs-tx').Transaction;
const propertiesReader = require('properties-reader');
const Web3 = require('web3');
const { OMNI_TRANSACTION_TYPES: omniTxTypes } = require('../utils/constants');

const { uptime } = require('./node');
const { btcClient, helpers, checkConnections } = require('../utils/util');
const i18n = require('../../i18n');
const { credentialTypes } = require('../config');
const { txrefToTxid } = require('../utils/tx-ref');
const ethDID = require('../services/eth.did.service');
const ipfs = require('../ipfs');
const env = require('../config/eth.env.json');
const {
  BTC_DUST,
  NO_OF_TX_OUTPUTS,
  FINAL_NO_OF_TX_INPUTS,
  FINAL_NO_OF_TX_OUTPUTS,
  OMNI_BLOCKCHAIN,
  BTC_BLOCKCHAIN,
  ETH_BLOCKCHAIN,
  ALLOWED_CHAINS,
} = require('../utils/constants');

const props = propertiesReader(path.join(`${__dirname}/../../bin/etc/local.conf`));
const web3 = new Web3(new Web3.providers.HttpProvider(env.ethNodeURL));

const api = exports;

let txChainLevel = 1;
let txChain = {};

/**
 * Tx Chain parsing logic
 * @param {string} txid
 * @param {string} vout
 * @param {string} blockhash
 * @returns {Object}
 */
async function parseBlocks(txid, vout, blockhash, isOmni) {
  let txidBuf = txid;
  let voutBuf = vout;
  const { tx, nTx, nextblockhash } = (
    await btcClient('getblock', [blockhash, 2])
  ).result;
  for (let x = 0; x < nTx; x++) {
    const { vin, vout: currVout, txid: currTxid } = tx[x];
    for (let y = 0; y < vin.length; y++) {
      const { txid: vinTxid, vout: vinVout } = vin[y];
      if (vinTxid === txid && vinVout === vout) {
        let OP_RETURN = null;
        for (let i = 0; i < currVout.length; i++) {
          const { asm, type } = currVout[i].scriptPubKey;
          if (type === 'nulldata') {
            [OP_RETURN] = asm.split('OP_RETURN ');
          }
        }
        if (!OP_RETURN) {
          throw new Error(
            `DID continuation doc not found at level ${txChainLevel}.`,
          );
        }
        txidBuf = currTxid;
        voutBuf = currVout[0].n;
        tx[x].ddo = OP_RETURN;
        txChain[txChainLevel] = tx[x];
        txChainLevel += 1;
      }
    }
  }
  if (!nextblockhash) {
    const res = { ...txChain };
    res.final = res[txChainLevel - 1];
    txChain = {};
    txChainLevel = 1;
    return res;
  }
  return parseBlocks(txidBuf, voutBuf, nextblockhash, isOmni);
}

/**
 * Funtion to obtain transactions that spent the utxos.
 * @param {string} txid
 * @param {string} vout
 * @returns {Object}
 */
async function getTxsChain(txid, vout, isOmni) {
  try {
    await btcClient('gettxout', [txid, vout], isOmni);
    return {};
  } catch (errTxo) {
    const getRawTx = (await btcClient('getrawtransaction', [txid, true], isOmni))
      .result;
    const { blockhash } = getRawTx;
    return parseBlocks(txid, vout, blockhash, isOmni);
  }
}

/**
 * API to check daemon's uptime.
 * @returns {object} "uptime" in milliseconds
 */
api.getuptime = (req, res) => {
  res.status(200).send({ uptime: new Date().getTime() - uptime() });
};

api.getServerInfo = async (req, res) => {
  // TODO: it will have its own info.
  try {
    const serverInfo = await checkConnections();
    return res.status(500).send({ error: null, result: serverInfo });
  } catch (error) {
    if (error && error.message) {
      return res.status(500).send({ error: error.message, result: null, errorObj: error });
    }
    if (error && error.error && error.error.message) {
      return res.status(500).send({
        error: error.error.message,
        result: null,
        errorObj: error.error,
      });
    }
    return res.status(500).send({ error: 'Internal error', result: null });
  }
};

/**
 * API to prepare a transaction for DID creation.
 * @returns {object}
 */
api.prepareTransaction = async (req, res) => {
  const { blockchain } = req.body;
  try {
    if (blockchain === 'eth') {
      const { type } = req.body;
      if (!type) {
        return res
          .status(400)
          .send({ result: null, error: i18n('Missing parameters') });
      }
      if (type === 'create') {
        const { didDoc, publicKey } = req.body;
        if (!didDoc || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.create(didDoc, publicKey);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'update') {
        const { didDoc, cid, publicKey } = req.body;
        if (!didDoc || !cid || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.setMetadata(publicKey, cid, didDoc);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'transfer') {
        const { publicKey, newOwner, cid } = req.body;
        if (!newOwner || !cid || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.setController(publicKey, newOwner, cid);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'delete') {
        const { publicKey, cid } = req.body;
        if (!publicKey || !cid) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.deleteDID(publicKey, cid);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
    }
    const { didCreator, didUpdater } = req.body;
    if (!didCreator || !didUpdater) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }

    const amount = BTC_DUST;
    let fee = 0;
    const unspents = (
      await btcClient('listunspent', [1, 9999999, [didCreator]])
    ).result;
    if (unspents.length) {
      const inputs = [];
      const outputs = {};
      fee = helpers.calculateFee(unspents.length, NO_OF_TX_OUTPUTS);
      let totalAmount = 0;
      unspents.forEach((x) => {
        inputs.push({ txid: x.txid, vout: x.vout });
        totalAmount += x.amount;
      });
      if (totalAmount >= Number(amount) + Number(fee)) {
        const changeAmt = (
          totalAmount - (Number(amount) + Number(fee))
        ).toFixed(8);
        outputs[didUpdater] = String(amount);
        if (Number(changeAmt) > 0) {
          outputs[didCreator] = changeAmt;
        }
        const rawTx = await btcClient('createrawtransaction', [
          inputs,
          outputs,
        ]);
        if (rawTx.result) {
          return res.status(200).send({
            message: 'Tx created successfully.',
            result: rawTx.result,
            error: null,
          });
        }
        return res.status(500).send({
          result: null,
          error: i18n('Error occurred while creating a raw transaction.'),
        });
      }
      return res.status(500).send({
        result: null,
        error: i18n('Sender does not have sufficient balance.'),
      });
    }
    fee = helpers.calculateFee(FINAL_NO_OF_TX_INPUTS, FINAL_NO_OF_TX_OUTPUTS);
    return res.status(500).send({
      result: null,
      error: i18n(
        `Sender does not have funds. Please fund this address "${didCreator}" with ${fee} BTC.`,
      ),
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to upload and store a document on IPFS.
 * @returns {object}
 */
api.storeDoc = async (req, res) => {
  try {
    const resp = await ipfs.upload(req);
    return res.status(200).send({
      cid: resp.data.cid,
      message: 'DID document uploaded',
      error: null,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to broadcast a signed transaction onto BTC or ETH network.
 * @returns {object}
 */
api.broadcast = async (req, res) => {
  try {
    const { signedTx, blockchain } = req.body;
    if (!signedTx) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    let sentTx;
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    if (blockchain === 'eth') {
      sentTx = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    } else {
      sentTx = await btcClient('sendrawtransaction', [signedTx], isOmni);
    }
    return res.status(200).send({
      error: null,
      message: 'Txn sent successfully.',
      result: sentTx,
    });
  } catch (errorT) {
    console.log('[broadcast] error', errorT);
    if (errorT && errorT.message) {
      return res.status(500).send({ result: null, error: errorT.message });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

/**
 * API to issue a new claim.
 * @returns {object}
 */
api.issueNewClaim = async (req, res) => {
  try {
    const {
      attestorDID,
      requestorDID,
      claimType,
      claimData,
      attestorName,
      attestorPublicKey,
      attestorPrivateKey,
      network: givenNetwork,
      blockchain,
    } = req.body;
    if (
      !attestorDID
      || !requestorDID
      || !claimType
      || !claimData
      || !attestorPublicKey
      || !attestorPrivateKey
      || !attestorName
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    if (!credentialTypes.includes(claimType)) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid claimType sent.') });
    }
    let [part1, part2, part3] = attestorDID.split(':');
    if (
      part1 !== 'did'
      || part2 !== 'mdip'
      || !ALLOWED_CHAINS.includes(part3.split('-')[0])
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid DID sent.') });
    }
    [part1, part2, part3] = requestorDID.split(':');
    if (
      part1 !== 'did'
      || part2 !== 'mdip'
      || !ALLOWED_CHAINS.includes(part3.split('-')[0])
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid DID sent.') });
    }
    let claim = {};
    const validFrom = new Date().toISOString();
    const validUntil = new Date(
      Date.now() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 6-months validity.
    if (
      (claimType === 'ageOver18' || claimType === 'ageOver21' || claimType === 'isPlatformXUser')
      && claimData[claimType]
    ) {
      claim = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        id: attestorDID,
        type: ['VerifiableCredential', claimType],
        issuer: {
          id: attestorDID,
          name: attestorName,
        },
        issuanceDate: validFrom,
        expirationDate: validUntil,
        credentialSubject: {
          id: requestorDID,
          // [claimType]: true,
          [claimType]: claimData[claimType],
        },
      };
    }
    const message = JSON.stringify(claim);
    let signature;
    if (blockchain === 'eth') {
      const web3Instance = new Web3(new Web3.providers.HttpProvider());
      signature = await web3Instance.eth.accounts.sign(
        message,
        `0x${attestorPrivateKey}`,
      );
    } else {
      let network = bitcoin.networks.testnet;
      if (givenNetwork === 'mainnet') {
        network = bitcoin.networks.bitcoin;
      }
      const keyPair = bitcoin.ECPair.fromWIF(attestorPrivateKey, network);
      const obatinedPrivKey = keyPair.privateKey;

      signature = bitcoinMessage.sign(
        message,
        obatinedPrivKey,
        keyPair.compressed,
        { extraEntropy: randomBytes(32) },
      );
    }

    claim.proof = {
      type: 'EcdsaSecp256k1VerificationKey2019',
      created: validFrom,
      proofPurpose: 'assertionMethod',
      verificationMethod: attestorPublicKey,
      // This will be more generic e.g: did:mdip:btc-1234#pubkey1 so that id does not get hardcoded.
      jws: signature.toString('base64'),
    };
    return res.status(200).send({
      error: null,
      message: 'Verifiable credential generated successfully.',
      result: JSON.stringify(claim),
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to update a DID.
 * @returns {object}
 */
// eslint-disable-next-line consistent-return
api.updateDID = async (req, res) => {
  try {
    const { network } = req.body;
    if (!network) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const {
      did,
      didUpdaterKeypair: { address, privateKey },
      newReceiver,
      didDocURL,
    } = req.body;
    if (
      !did
      || !address
      || !privateKey
      || !newReceiver
      || !didDocURL
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient);
    let txoCall;
    try {
      txoCall = await btcClient('gettxout', [txid, utxoIndex], isOmni);
    } catch (errTxo) {
      return res.status(400).send({
        error: true,
        message: 'DID already revoked.',
      });
    }
    const txo = txoCall.result;
    if (txo && txo.scriptPubKey.addresses[0] !== address) {
      return res.status(400).send({
        error: null,
        message: 'Invalid DID updater key pair provided.',
      });
    }
    if (txo) {
      let inputs = [{ txid, vout: utxoIndex }];
      const fee = helpers.calculateFee(1, 1);
      let totalAmount = txo.value;
      if (totalAmount < fee) {
        const unspents = (
          await btcClient('listunspent', [
            1,
            9999999,
            [txo.scriptPubKey.addresses[0]],
          ], isOmni)
        ).result;
        totalAmount = unspents.reduce((acc, u) => acc + u.amount, 0);
        if (totalAmount < fee) {
          return res.status(400).send({
            error: null,
            message: 'DID does not have funds to pay for update fee.',
          });
        }
        inputs = unspents.map((x) => ({ txid: x.txid, vout: x.vout }));
      }
      const outputs = { [newReceiver]: (totalAmount - fee).toFixed(8) };
      outputs.data = Buffer.from(didDocURL).toString('hex'); // OP_RETURN
      if (isOmni) {
        /**
         * data embedded for a tx to be identified as omni layer tx.
         * contains omni chain + version data
         */
        outputs.data = `6f6d6e69000000c8${outputs.data}`;
      }
      const rawTx = await btcClient('createrawtransaction', [inputs, outputs], isOmni);
      const signedTx = await btcClient('signrawtransactionwithkey', [
        rawTx.result,
        [privateKey],
      ], isOmni);
      if (signedTx.result && signedTx.result.complete) {
        const sentTx = await btcClient('sendrawtransaction', [
          signedTx.result.hex,
        ], isOmni);
        return res.status(400).send({
          error: null,
          message: `DID: ${did} updated successfully.`,
          result: sentTx,
        });
      }
      if (signedTx.result && !signedTx.result.complete) {
        return res.status(400).send({
          error: true,
          message: 'Invalid private key provided.',
        });
      }
    }
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to delete a DID.
 * @returns {object}
 */
// eslint-disable-next-line consistent-return
api.deleteDID = async (req, res) => {
  try {
    const { network } = req.body;
    if (!network) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const {
      did,
      didUpdaterKeypair: { address, privateKey },
      newReceiver,
    } = req.body;
    if (!did || !address || !privateKey || !newReceiver) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient, isOmni);
    let txoCall;
    try {
      txoCall = await btcClient('gettxout', [txid, utxoIndex], isOmni);
    } catch (errTxo) {
      return res.status(400).send({
        error: true,
        message: 'DID already revoked.',
      });
    }
    const txo = txoCall.result;
    if (txo && txo.scriptPubKey.addresses[0] !== address) {
      return res.status(400).send({
        error: null,
        message: 'Invalid DID updater key pair provided.',
      });
    }
    if (txo) {
      let inputs = [{ txid, vout: utxoIndex }];
      const fee = helpers.calculateFee(1, 1);
      let totalAmount = txo.value;
      if (totalAmount < fee) {
        const unspents = (
          await btcClient('listunspent', [
            1,
            9999999,
            [txo.scriptPubKey.addresses[0]],
          ], isOmni)
        ).result;
        totalAmount = unspents.reduce((acc, u) => acc + u.amount, 0);
        if (totalAmount < fee) {
          return res.status(400).send({
            error: null,
            message: 'DID does not have funds to pay for revoke fee.',
          });
        }
        inputs = unspents.map((x) => ({ txid: x.txid, vout: x.vout }));
      }
      /** TODO: validate newReceiver address. */
      const outputs = { [newReceiver]: (totalAmount - fee).toFixed(8) };
      const rawTx = await btcClient('createrawtransaction', [inputs, outputs], isOmni);
      const signedTx = await btcClient('signrawtransactionwithkey', [
        rawTx.result,
        [privateKey],
      ], isOmni);
      if (signedTx.result && signedTx.result.complete) {
        const sentTx = await btcClient('sendrawtransaction', [
          signedTx.result.hex,
        ], isOmni);
        return res.status(400).send({
          error: null,
          message: `DID: ${did} revoked successfully.`,
          result: sentTx,
        });
      }
      if (signedTx.result && !signedTx.result.complete) {
        return res.status(400).send({
          error: true,
          message: 'Invalid private key provided.',
        });
      }
    }
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to read a DID.
 * @returns {object}
 */
api.readDID = async (req, res) => {
  try {
    const { did } = req.query;
    if (!did) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const [chain] = did.split('did:mdip:')[1].split('-');
    if (chain === 'eth') {
      const didTx = await ethDID.getDID(did);
      const didDoc = await ipfs.download(didTx.data.metadata);
      return res.status(200).send({
        error: null,
        message: 'DID Doucment obtained successfully.',
        result: didDoc,
      });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const network = props.get('mdip.testnet') === 1 ? 'testnet' : 'mainnet';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient, isOmni);
    const resp = await getTxsChain(txid, utxoIndex, isOmni);
    if (Object.keys(resp).length) {
      const {
        final: { ddo },
      } = resp;
      const didDocURL = Buffer.from(ddo, 'hex').toString();
      return res.status(200).send({
        error: null,
        result: didDocURL,
        message: 'DID Document obtained successfully.',
      });
    }
    const { vout } = (
      await btcClient('getrawtransaction', [txid, true], isOmni)
    ).result;
    let OP_RETURN = null;
    for (let i = 0; i < vout.length; i++) {
      const { asm, type } = vout[i].scriptPubKey;
      if (type === 'nulldata') {
        // eslint-disable-next-line prefer-destructuring
        OP_RETURN = asm.split('OP_RETURN ')[1];
      }
    }
    if (OP_RETURN) {
      if (isOmni) {
        OP_RETURN = OP_RETURN.substr(16);
      }
      const document = Buffer.from(OP_RETURN, 'hex').toString();
      return res.status(200).send({
        error: null,
        result: document,
        message: 'DID Document obtained successfully.',
      });
    }
    return res.status(200).send({
      error: 'Invalid DID. IPNS name not found.',
      result: null,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to obtain utxos of a given address using scantxoutset.
 * @returns {object}
 */
api.getutxos = async (req, res) => {
  try {
    const { address, blockchain, numberOfOutputs = 3 } = req.body;
    if (!address) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    // const { success, unspents, total_amount: totalAmount } = (
    //   await btcClient('scantxoutset', ['start', [{ desc: `addr(${address})` }]], isOmni)
    // ).result;
    let { result: unspents } = await btcClient('getaddressutxos', [{ addresses: [address] }], isOmni);
    const totalAmount = unspents.reduce((prev, curr) => prev + curr.satoshis, 0);
    const { fee, nulldataFee } = await helpers.calculateFee(
      unspents.length, numberOfOutputs, isOmni,
    );
    const sanitizedFee = fee.toFixed(8);
    const sanitizedNulldataFee = nulldataFee.toFixed(8);
    const getRawTxPromiseArr = [];
    const mempoolTx = (await btcClient('getaddressmempool', [{ addresses: [address] }], isOmni)).result;

    if (totalAmount >= Number(sanitizedFee)) {
      unspents = unspents
        .filter((e) => {
          const a = mempoolTx
            .filter((ele) => (e.txid === ele.prevtxid && e.outputIndex === ele.prevout));

          if (a.length > 0) {
            return false;
          }
          return true;
        });
      for (let i = 0; i < unspents.length; i++) {
        const { txid } = unspents[i];
        getRawTxPromiseArr.push(btcClient('getrawtransaction', [txid], isOmni));
      }
      const promisesResp = await Promise.allSettled(getRawTxPromiseArr);
      promisesResp.forEach((resp, index) => {
        unspents[index].rawTx = { hex: resp?.value?.result };
      });
      return res.status(200).send({
        error: null,
        message: 'Inputs obtained.',
        result: { unspents, fee: sanitizedFee, nulldataFee: sanitizedNulldataFee },
      });
    }
    let errMessage = 'Sender does not have funds.';
    if (mempoolTx && mempoolTx.length) {
      errMessage = 'Unconfirmed transaction found. Please retry in sometime';
    }
    return res.status(200).send({
      error: true,
      message: errMessage,
      result: null,
      mempoolTx,
    });
  } catch (errorT) {
    console.log('[errorT]', errorT);
    if (errorT && errorT.message) {
      return res.status(500).send({ result: false, error: errorT.message });
    }
    return res.status(500).send({ result: false, error: errorT || 'Internal error' });
  }
};

const getTransactionDetails = async (txids, getConfirmations = false) => {
  const txDetails = [];
  const invalidTxids = [];
  const confirmations = [];
  const txPromises = txids.map((txid) => {
    return btcClient('getrawtransaction', [txid, true]);
  });
  const txRawArray = await Promise.all(txPromises);
  txids.map((txid, index) => {
    try {
      const txDetail = txRawArray[index].result;
      txDetails.push(txDetail);
      confirmations.push({ txid, confirmations: txDetail.confirmations });
    } catch (errGetTx) {
      invalidTxids.push(txid);
    }
  });
  if (getConfirmations) {
    return { result: confirmations, invalidTxids };
  }
  return txDetails;
};

/**
 * API to obtain confirmations on a given BTC transaction.
 * @returns {object}
 */
api.checkconfs = async (req, res) => {
  try {
    const { txids } = req.body;
    if (!txids || !txids.length) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const { result, invalidTxids } = await getTransactionDetails(txids, true);
    if (!result.length) {
      return res.status(200).send({
        error: true,
        message: `All of the given transaction ids${JSON.stringify(invalidTxids)} were invalid.`,
        result: null,
      });
    }
    return res.status(200).send({
      error: null,
      message: 'Confirmations obtained successfully.',
      result: { valid: result, invalid: invalidTxids },
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/** Development only service. */
/**
 * API to fund any ETH address with a specific amount.
 * @returns {object}
 */
api.fundETHAddress = async (req, res) => {
  const { toAddr } = req.body;
  if (!toAddr) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  const amount = props.get('mdip.ethTransferAmount');
  const chainID = props.get('mdip.chainID');
  if (!props.get('mdip.ethSenderAccount') || !props.get('mdip.ethSenderPrivateKey') || !amount || !chainID) {
    return res.status(400).send({ error: 'config not set.', result: null });
  }
  const fromAddr = `0x${props.get('mdip.ethSenderAccount')}`;
  const privateKey = `0x${props.get('mdip.ethSenderPrivateKey')}`;
  try {
    const isToAddrValid = web3.utils.isAddress(toAddr);
    if (!isToAddrValid) {
      return res.status(400).send({ error: `Invalid toAddr ${toAddr} sent`, result: null });
    }
    const ethBalance = await web3.eth.getBalance(fromAddr);
    const ethBalanceDecimal = Number(web3.utils.fromWei(ethBalance, 'ether'));
    const { gas, gasPrice } = await helpers.calculateFeeETH(fromAddr, toAddr, ethBalance);
    const fee = web3.utils.fromWei(
      String(Number(gas) * Number(gasPrice)),
      'ether',
    );
    if (ethBalanceDecimal < Number(amount) + Number(fee)) {
      return res.status(400).send({
        error: `Current ETH balance ${ethBalanceDecimal} is less than required amount + fee ${
          Number(amount) + Number(fee)
        }`,
        result: null,
      });
    }
    const proPrivateKey = Buffer.from(privateKey.substr(2), 'hex');
    const nonce = await web3.eth.getTransactionCount(fromAddr, 'pending');
    const rawTx = {
      from: fromAddr,
      to: toAddr,
      value: web3.utils.toHex(web3.utils.toWei(String(amount), 'ether')),
      gas: Number(gas),
      gasPrice: Number(gasPrice),
      nonce,
    };
    const tx = new Tx(rawTx, { chain: Number(chainID) });
    tx.sign(proPrivateKey);
    const serializedTx = tx.serialize();
    const proSerializedTx = `0x${serializedTx.toString('hex')}`;
    const sentTx = await web3.eth.sendSignedTransaction(proSerializedTx);
    return res.status(200).send({
      error: null,
      message: 'Txn sent successfully.',
      result: {
        hash: sentTx.transactionHash,
        fee,
        gas,
        gasPrice,
        amount,
      },
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

api.getTxDetails = async (req, res) => {
  const { txid, blockchain } = req.query;
  if (!txid) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    const getRawTx = (await btcClient('getrawtransaction', [txid, true], isOmni)).result;
    const getBlock = (await btcClient('getblock', [getRawTx.blockhash, 1], isOmni)).result;
    getRawTx.blockHeight = getBlock.height;
    getRawTx.txIndex = getBlock.tx.indexOf(txid);
    return res.status(200).send({
      error: null,
      message: 'Data obtained successfully.',
      result: getRawTx,
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

api.getFunds = async (req, res) => {
  const { address, blockchain, network } = req.query;
  if (!address || !blockchain || !network) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    if (blockchain === BTC_BLOCKCHAIN || isOmni) {
      let balance = 0;
      const { success, total_amount: totalAmount } = (
        await btcClient('scantxoutset', ['start', [{ desc: `addr(${address})` }]], isOmni)
      ).result;
      if (success && totalAmount) {
        balance = totalAmount;
      }
      return res.status(200).send({
        error: null,
        message: 'Balance obtained successfully.',
        result: {
          address, balance, blockchain, network,
        },
      });
    }
    if (blockchain === ETH_BLOCKCHAIN) {
      const ethBalance = await web3.eth.getBalance(address);
      const ethBalanceDecimal = Number(web3.utils.fromWei(ethBalance, 'ether'));
      return res.status(200).send({
        error: null,
        message: 'Balance obtained successfully.',
        result: {
          address, balance: ethBalanceDecimal, blockchain, network,
        },
      });
    }
    return res.status(200).send({
      error: true,
      message: 'Invalid blockchain queried.',
      result: null,
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

const handleSingleTxDetail = async (txDetailParam, address, isOmni) => {
  let totalInputValue = 0;
  let totalOutputValue = 0;
  const txDetail = txDetailParam;
  txDetail.transactionType = omniTxTypes.incoming;
  const inputTxDetailPromises = txDetailParam.vin.map((vin) => {
    return btcClient('getrawtransaction', [vin.txid, true], isOmni);
  });
  const inputTxDetailArray = await Promise.all(inputTxDetailPromises);
  txDetail.vin.map((vin, index) => {
    const inputTxDetail = inputTxDetailArray[index].result;
    const { value, scriptPubKey } = inputTxDetail.vout[vin.vout];
    totalInputValue += value;
    if (address === scriptPubKey.addresses[0]) {
      txDetail.transactionType = omniTxTypes.outgoing;
    }
    return vin;
  });
  
  totalOutputValue = txDetail.vout.reduce((acc, { value }) => acc + value, 0);
  const fee = totalInputValue - totalOutputValue;
  txDetail.totalInputValue = totalInputValue.toFixed(8);
  txDetail.totalOutputValue = totalOutputValue.toFixed(8);
  txDetail.fee = fee.toFixed(8);
  return txDetail;
};

/**
 * API to obtain transaction ids associated with single address
 * @returns {object}
 */
api.getTransactionHistory = async (req, res) => {
  const { address } = req.query;
  if (!address) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const isOmni = true;
    const txids = (await btcClient('getaddresstxids', [address])).result;
    const mempoolTx = (await btcClient('getaddressmempool', [{ addresses: [address] }], isOmni)).result;
    const txs = txids.concat(mempoolTx.map((x) => x.txid));
    const txDetails = await getTransactionDetails(txs);
    const promises = txDetails.map((txDetailParam) => {
      return handleSingleTxDetail(txDetailParam, address, isOmni)
    });
    const allTxDetails = await Promise.all(promises);
    const { result: unspents } = await btcClient('getaddressutxos', [{ addresses: [address] }], isOmni);
    const confAmount = unspents.reduce((prev, curr) => prev + curr.satoshis, 0);
    const unconfAmount = mempoolTx.reduce((prev, curr) => prev + curr.satoshis, 0);
    return res.status(200).send({
      error: null,
      message: 'Transactions obtained successfully.',
      result: {
        txns: allTxDetails,
        balance: {
          confirmed: Number((confAmount / 10 ** 8).toFixed(8)),
          unconfirmed: Number((unconfAmount / 10 ** 8).toFixed(8)),
          total: Number(((confAmount + unconfAmount) / 10 ** 8).toFixed(8)),
        },
      },
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

/**
 * API call to check if mempool allowed signed transaction to be inserted
 */
api.testMempoolAccept = async (req, res) => {
  const { signedTx } = req.query;
  let error = null;
  try {
    const { result } = (await btcClient('testmempoolaccept', [[signedTx]]));
    if (result[0].allowed) {
      return res.status(200).send({
        message: 'mempool allowed this tx to be inserted',
        result: result[0],
        error,
      });
    }
    error = result[0]['reject-reason'];
  } catch (errT) {
    if (errT && errT.message) {
      error = errT.message;
    } else {
      error = 'Internal error.';
    }
  }
  return res.status(500).send({ error, result: null });
};

/**
 * API to obtain IPNS URL using transaction id
 * @returns {object}
 */
api.getTxidIPNS = async (req, res) => {
  const { txid } = req.query;
  if (!txid) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const getRawTx = (await btcClient('getrawtransaction', [txid, true])).result;
    const data = helpers.decodeNullDataIPNS(getRawTx.vout);
    const message = data ? 'IPNS url fetched successfully' : 'No IPNS link found';
    return res.status(200).send({
      error: null,
      message,
      result: data,
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};
