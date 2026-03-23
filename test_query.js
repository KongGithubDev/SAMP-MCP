import * as dgram from 'dgram';

const host = '168.222.20.193';
const port = 7777;

const client = dgram.createSocket('udp4');

const buildPacket = (h, p, type) => {
    const hostParts = h.split('.');
    const packet = Buffer.alloc(11);
    packet.write('SAMP');
    packet.writeUInt8(parseInt(hostParts[0]), 4);
    packet.writeUInt8(parseInt(hostParts[1]), 5);
    packet.writeUInt8(parseInt(hostParts[2]), 6);
    packet.writeUInt8(parseInt(hostParts[3]), 7);
    packet.writeUInt16LE(p, 8);
    packet.write(type, 10);
    return packet;
};

const packet = buildPacket(host, port, 'i');

console.log(`Sending query to ${host}:${port}...`);
console.log('Packet:', packet.toString('hex'));

client.on('message', (msg) => {
    console.log('Received response:', msg.toString('hex'));
    console.log('UTF-8:', msg.toString());
    client.close();
});

client.on('error', (err) => {
    console.error('Socket error:', err);
});

client.send(packet, port, host, (err) => {
    if (err) console.error('Send error:', err);
    else console.log('Packet sent successfully');
});

setTimeout(() => {
    console.log('Timed out after 5 seconds');
    client.close();
}, 5000);
