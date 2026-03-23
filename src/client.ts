import * as dgram from 'dgram';
import { SampProtocol, PacketType } from './protocol.js';

export class SampClient {
    private socket: dgram.Socket;

    constructor(private host: string, private port: number, private password?: string) {
        this.socket = dgram.createSocket('udp4');
    }

    private sendPacket(type: PacketType, payload?: Buffer): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('SAMP Query Timeout'));
            }, 5000);

            const packet = SampProtocol.buildPacket(this.host, this.port, type, payload);
            
            this.socket.once('message', (msg) => {
                clearTimeout(timeout);
                resolve(msg);
            });

            this.socket.send(packet, this.port, this.host, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    async getInfo() {
        const resp = await this.sendPacket('i');
        return SampProtocol.parseResponse(resp, 'i');
    }

    async getPlayers() {
        const resp = await this.sendPacket('d'); // Use 'd' for detailed info
        return SampProtocol.parseResponse(resp, 'd');
    }

    async getRules() {
        const resp = await this.sendPacket('r');
        return SampProtocol.parseResponse(resp, 'r');
    }

    async executeRcon(command: string): Promise<string[]> {
        if (!this.password) throw new Error('RCON Password not provided');
        
        return new Promise((resolve, reject) => {
            const packet = SampProtocol.buildRconPacket(this.host, this.port, this.password!, command);
            const responses: string[] = [];
            
            const onMessage = (msg: Buffer) => {
                const text = SampProtocol.parseResponse(msg, 'x');
                if (text && text.length > 0) {
                    responses.push(text);
                }
            };

            this.socket.on('message', onMessage);

            this.socket.send(packet, this.port, this.host, (err) => {
                if (err) {
                    this.socket.off('message', onMessage);
                    return reject(err);
                }
                
                // RCON responses can be multiple packets. Wait a bit for all.
                setTimeout(() => {
                    this.socket.off('message', onMessage);
                    resolve(responses);
                }, 500);
            });
        });
    }

    close() {
        this.socket.close();
    }
}
