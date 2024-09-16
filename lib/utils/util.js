/* eslint-disable object-curly-newline */
const request = require('request');
const eccrypto = require('@toruslabs/eccrypto');
const propertiesReader = require('properties-reader');
const WEB3 = require('web3');
const path = require('path');
const ipfs = require('ipfs-http-client');
const ipfsCore = require('@mdip/ipfs-core');
const ipns = require('ipns');
const i18n = require('../../i18n');
const {
  POST_METHOD,
  RPC_ID,
  RPC_VERSION,
  CONTENT_TYPE,
  WEIGHTED_INPUT,
  WEIGHTED_OUTPUT,
  IMAGE_EXT_LIST,
  VIDEO_EXT_LIST,
  AUDIO_EXT_LIST,
  FB_FEE_RATE,
  TO_SATOSHI,
} = require('./constants');

const props = propertiesReader(
  path.join(`${__dirname}/../../bin/etc/local.conf`),
);

const web3 = new WEB3(
  new WEB3.providers.HttpProvider(props.get('mdip.ethHTTPProvider')),
);

const client = ipfs({
  url: props.get('ipfs.url'),
});

const Util = exports;

/**
 * Function to check whether a given string is JSON or not.
 * @param {string} data
 * @returns {boolean}
 */
const isJSON = (data) => {
  try {
    JSON.parse(data);
    return true;
  } catch (error) {
    return false;
  }
};

const btcUrl = props.get('btc.url');
const btcUser = props.get('btc.username');
const btcPass = props.get('btc.password');

const omniUrl = props.get('omni.url');
const omniUser = props.get('omni.username');
const omniPass = props.get('omni.password');

/**
 * Utility method to interact with the bitcoin node.
 * @param {string} method
 * @param {array} params
 * @returns {object}
 */
const btcClient = (method, params, isOmni) => {
  let URL = btcUrl;
  let username = btcUser;
  let password = btcPass;

  if (isOmni) {
    URL = omniUrl;
    username = omniUser;
    password = omniPass;
  }

  if (!URL || !username || !password) {
    throw new Error(
      `No config provided to connect to the ${
        isOmni ? 'Omni Layer BTC' : 'BTC'
      } node.`,
    );
  }
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  const req = {
    url: URL,
    method: POST_METHOD,
    body: JSON.stringify({
      jsonrpc: RPC_VERSION,
      id: RPC_ID,
      method,
      params,
    }),
    headers: { 'Content-Type': CONTENT_TYPE, Authorization: `Basic ${auth}` },
  };
  return new Promise((resolve, reject) => {
    request(req, (err, _, result) => {
      if (err) {
        reject(err);
      }
      if (isJSON(result)) {
        const parsedRes = JSON.parse(result);
        if (parsedRes && parsedRes.result) {
          resolve(parsedRes);
        } else {
          reject(parsedRes);
        }
      } else {
        reject(err);
      }
    });
  });
};

/**
 * Utility method to calculate fee for a specific transaction.
 * @param {number} inputs
 * @param {number} outputs
 * @returns {number}
 */
const calculateFee = async (inputs, outputs, isOmni) => {
  try {
    // 0.00011 fee/kB
    let feerate;
    ({ feerate } = (await btcClient('estimatesmartfee', [6], isOmni)).result);
    if (!feerate) {
      feerate = FB_FEE_RATE;
    }
    if (feerate) {
      const txSize = inputs * WEIGHTED_INPUT + outputs * WEIGHTED_OUTPUT + inputs;
      const nulldataTxSize = txSize + 80;
      return {
        fee: (feerate * 1e5 * txSize) / TO_SATOSHI,
        nulldataFee: (feerate * 1e5 * nulldataTxSize) / TO_SATOSHI,
      };
      // 10 ** 8 is same as Math.pow(10, 8)
    }
    throw new Error('feerate not found.');
  } catch (error) {
    throw new Error(error.message);
  }
};

/**
 * Util to calculate ETH fees.
 * @param {string} fromAddr
 * @param {string} toAddr
 * @param {string} value
 * @returns {Object}
 */
const calculateFeeETH = async (fromAddr, toAddr, value) => {
  let gas = 21000;
  const gasPrice = await web3.eth.getGasPrice();
  if (toAddr) {
    gas = await web3.eth.estimateGas({
      from: fromAddr,
      to: toAddr,
      value,
    });
  }
  const fee = ((gas * Number(gasPrice)) / 10 ** 18).toFixed(18);
  return { gas: Number(gas), gasPrice: Number(gasPrice), fee: Number(fee) };
};

const getFileExt = (url) => {
  const ext = path.extname(url);
  if (IMAGE_EXT_LIST.includes(ext)) {
    return 'image';
  }
  if (VIDEO_EXT_LIST.includes(ext)) {
    return 'video';
  }
  if (AUDIO_EXT_LIST.includes(ext)) {
    return 'audio';
  }
  return null;
};

const prepareDoc = (msID, blockchain, creator) => {
  const did = `did:mdip:${blockchain}-${msID}`;
  const didDoc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: `${did}`,
    publicKey: [
      {
        id: `${did}#auth`,
        controller: `${did}`,
        type: 'PrivateDbPublicKey',
        publicKey: creator,
      },
      {
        id: `${did}#vc-pubkey`,
        controller: `${did}`,
        type: 'PrivateDbPublicKey',
        publicKey: creator,
      },
    ],
    authentication: ['#auth'],
    assertionMethod: ['#vc-pubkey'],
  };
  return didDoc;
};

const deriveIPNSKeypair = async (name, privateKey) => {
  try {
    const coreClient = await ipfsCore.create({ EXPERIMENTAL: { ipnsPubsub: true } });
    const keypair = await coreClient.key.gen(name, {
      type: 'secp256k1',
      optPrivateKey: Buffer.from(privateKey, 'hex'),
    });
    /**
     * [check key] {
        name: '04-JAN-2022-1641283896229',
        id: 'Qmb2uThjjTbefxDtPpM34WN1RZta1zDC6A6FeQAoDwb48v'
      }
     */
    await coreClient.stop();
    return keypair;
  } catch (error) {
    console.log('check error', error);
    return null;
  }
};

const linkToIPNS = async (ipfsAddr, keyName) => {
  try {
    const coreClient = await ipfsCore.create({ EXPERIMENTAL: { ipnsPubsub: true } });
    const resp = await coreClient.name.publish(ipfsAddr, { key: keyName, resolve: true, lifetime: '2400h' });
    await coreClient.stop();
    return resp;
  } catch (error) {
    console.log('check error', error);
    throw new Error('IPNS linking failed');
  }
};

const resolveIPNS = async (ipnsPubKey) => {
  try {
    const coreClient = await ipfsCore.create({ EXPERIMENTAL: { ipnsPubsub: true } });
    let CID;
    // eslint-disable-next-line no-restricted-syntax
    for await (const name of coreClient.name.resolve(ipnsPubKey)) {
      CID = name;
    }
    let dData;
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of coreClient.cat(CID)) {
      dData = chunk;
    }
    await coreClient.stop();
    return dData.toString();
  } catch (error) {
    console.log('check error', error);
    return null;
  }
};

const createIPNSRecord = async (
  privateKey,
  value,
  sequenceNumber,
  lifetime,
) => {
  try {
    const entryData = await ipns.create(
      privateKey,
      value,
      sequenceNumber,
      lifetime,
    );
    console.log('check entryData', entryData);
    return entryData;
  } catch (error) {
    console.log('check error', error);
    return null;
  }
};

//

/**
 * Method to extract chains from a given Verifiable Credential
 * @param {Object} vc
 * @returns {Object}
 */
const extractChains = (vc) => {
  const chainInfo = {};
  const attestorDID = vc && vc.issuer && vc.issuer.id;
  const requestorDID = vc && vc.credentialSubject && vc.credentialSubject.id;
  if (attestorDID) {
    const [chain] = attestorDID.split('did:mdip:')[1].split('-');
    chainInfo.attestor = chain;
  }
  if (requestorDID) {
    const [chain] = requestorDID.split('did:mdip:')[1].split('-');
    chainInfo.requestor = chain;
  }
  return chainInfo;
};

const resHandler = (res, code, error, result, message, data) => {
  const i18nMsg = i18n({ phrase: message });
  return res.status(code).send({
    error,
    result,
    i18nMsg,
    data,
  });
};

const encryptContent = async (data) => {
  const encData = [];
  const promises = data.map(async (currData) => {
    const { content, publicKey } = currData;
    const { ciphertext, ephemPublicKey, iv, mac } = await eccrypto.encrypt(
      Buffer.from(publicKey, 'hex'),
      Buffer.from(JSON.stringify(content)),
    );
    encData.push({
      encContent: {
        _c: ciphertext.toString('hex'),
        _e: ephemPublicKey.toString('hex'),
        _i: iv.toString('hex'),
        _m: mac.toString('hex'),
      },
      publicKey,
    });
  });
  await Promise.all(promises);
  return encData;
};

const decryptContent = async (data, privateKeys) => {
  const decData = [];
  const promises = data.map(async (currData, i) => {
    const { encContent: { _c, _e, _i, _m } } = currData;
    const privateKey = privateKeys[i];
    const payload = { ciphertext: Buffer.from(_c, 'hex'), ephemPublicKey: Buffer.from(_e, 'hex'), iv: Buffer.from(_i, 'hex'), mac: Buffer.from(_m, 'hex') };
    const plainText = await eccrypto.decrypt(Buffer.from(privateKey, 'hex'), payload);
    const parsedPlainText = JSON.parse(plainText);
    decData.push(parsedPlainText);
  });
  await Promise.all(promises);
  return decData;
};

const sendJSONToIPFS = async (data) => {
  if (!Array.isArray(data)) {
    throw new Error('Input must be an array');
  }
  const sanitizedData = data.map((obj, i) => {
    if (typeof obj !== 'object') {
      throw new Error(`Invalid input at index ${i}`);
    }
    return JSON.stringify(obj);
  });
  const coreClient = await ipfsCore.create({
    EXPERIMENTAL: { ipnsPubsub: false },
  });
  const storedCIDs = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const result of coreClient.addAll(sanitizedData)) {
    storedCIDs.push(result);
  }
  await coreClient.stop();
  return storedCIDs;
};

const getData = async (cid) => {
  const coreClient = await ipfsCore.create({ EXPERIMENTAL: { ipnsPubsub: false } });
  let dData;
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of coreClient.cat(cid)) {
    dData = chunk;
  }
  await coreClient.stop();
  return dData.toString();
};

const uploadDataToIPFSviaURL = async (url) => {
  if (!url.length) {
    return [];
  }
  const modURL = url.map((x) => ipfs.urlSource(x));
  const arr = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const result of client.addAll(modURL)) {
    const fileType = getFileExt(result.path);
    if (['image', 'audio', 'video'].includes(fileType)) {
      throw new Error('file type invalid');
    }
    arr.push(result);
  }
  return arr;
};

const checkConnections = async () => {
  /** TODO add check for bitmessge  */
  const serverInfo = {
    btc: null,
    eth: null,
    omni: null,
  };
  const {
    btc,
    eth,
    omni,
    mdip: { testnet },
  } = props.path();
  const isMainnet = testnet !== '1';
  if (btc) {
    const chainInfo = (await btcClient('getblockchaininfo', [])).result;
    if (isMainnet && chainInfo.chain !== 'main') {
      throw new Error('Bitcoin network mismatch');
    }
    serverInfo.btc = chainInfo;
  }
  if (eth) {
    const web3Local = new WEB3(
      new WEB3.providers.HttpProvider(eth.httpProvider),
    );
    const nodeInfo = await web3Local.eth.getNodeInfo();
    const chainID = await web3Local.eth.getChainId();
    if (isMainnet && chainID !== 1) {
      throw new Error('Ethereum network mismatch');
    }
    serverInfo.eth = { nodeInfo, chainId: chainID };
  }
  if (omni) {
    const btcNodeInfo = (await btcClient('getblockchaininfo', [], true)).result;
    const omniLayerInfo = (await btcClient('omni_getinfo', [], true)).result;
    if (isMainnet && btcNodeInfo.chain !== 'main') {
      throw new Error('Omnilayer network mismatch');
    }
    serverInfo.omni = { btcNodeInfo, omniLayerInfo };
  }
  return serverInfo;
};

/**
 * Util function to convert Nulldata from transaction's vout and return IPNS URL
 * @param {Array} vout
 * @returns {String}
 */
const decodeNullDataIPNS = (vout) => {
  let ipnsHash = null;
  const vElement = vout.find((entry) => entry.scriptPubKey.type === 'nulldata');
  if (vElement?.scriptPubKey.asm) {
    const [, OP_RETURN] = vElement?.scriptPubKey?.asm.split('OP_RETURN ');
    const data = Buffer.from(
      OP_RETURN,
      'hex',
    ).toString();
    [, ipnsHash] = data ? data.split('/ipns/') : null;
  }
  return ipnsHash ? `/ipns/${ipnsHash}` : null;
};

Util.btcClient = btcClient;
Util.resHandler = resHandler;
Util.checkConnections = checkConnections;
Util.sendJSONToIPFS = sendJSONToIPFS;
Util.uploadDataToIPFSviaURL = uploadDataToIPFSviaURL;
Util.linkToIPNS = linkToIPNS;
Util.createIPNSRecord = createIPNSRecord;
Util.deriveIPNSKeypair = deriveIPNSKeypair;
Util.resolveIPNS = resolveIPNS;
Util.encryptContent = encryptContent;
Util.decryptContent = decryptContent;
Util.getData = getData;

Util.helpers = {
  isJSON,
  calculateFee,
  calculateFeeETH,
  prepareDoc,
  extractChains,
  decodeNullDataIPNS,
};
