const secp256k1 = require('secp256k1');

console.log('[secp256k1]', secp256k1);
const { messages, structs, objects } = require('bitmessage');
const { TcpTransport } = require('bitmessage-transports');
const { generateBMAddr } = require('../client/mdip');

const addr = generateBMAddr('test'); // privateKeyHex will go here
const addr2 = generateBMAddr('test2');
console.log('[check addr1] at p2p.js', addr);
console.log('[check addr2] at p2p.js', addr2);
console.log('[check addr] at p2p.js', addr.encode());

const tcp = new TcpTransport({
  dnsSeeds: [['192.168.29.16', 8444]], // update with the Python client's IP
  // dnsSeeds: [['38.146.72.54', 8444]],
});

tcp.bootstrap().then((nodes) => {
  const remoteHost = nodes[0][0];
  const remotePort = nodes[0][1];
  tcp.connect(remotePort, remoteHost);
  // 192.168.29.16
  // tcp.connect('192.168.29.16', 8444);
}).catch((error) => {
  console.log('[check nodes error]', error);
});

tcp.on('established', (version) => {
  console.log('Connection established to', version.userAgent);
  const msgPayload = objects.msg.encodePayloadAsync(
    // Buffer.from(
    //   JSON.stringify(
    {
      from: addr,
      to: addr2, // 'BM-NAwwTGBKeCw9FMxEKkZRsSYmvfiZtHGB',
      subject: 'hello ubuntu',
      message: 'hey there',
      ttl: 86400,
    },
    //   )
    // )
  );

  // tcp.send('object', msgPayload);

  // tcp.on('message', (command, payload) => {
  //   console.log('Got new', command, 'message');
  //   console.log('[payload]', payload);
  //   let decoded;
  //   if (command === 'addr') {
  //     decoded = messages.addr.decodePayload(payload);
  //     console.log('Got', decoded.addrs, 'node addresses');
  //   }
  // });

  // const vermsg = messages.version.encode({
  //   remoteHost: '192.168.29.16',
  //   remotePort: 8444,
  // });
  // console.log(messages.version.decode(vermsg).remoteHost);

  // const addrmsg = structs.message.encode('addr', addrPayload);
  // const decoded = structs.message.decode(addrmsg);
  // console.log(decoded.command); // addr
  // const addr = messages.addr.decodePayload(decoded.payload);
  // console.log(addr.addrs[0].host);
});
