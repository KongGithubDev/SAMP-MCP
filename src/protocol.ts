import * as iconv from 'iconv-lite';

export type PacketType = 'i' | 'c' | 'r' | 'd' | 'x' | 'p';

export class SampProtocol {
    private static HEADER = Buffer.from('SAMP');

    static buildPacket(ip: string, port: number, type: PacketType, payload?: Buffer): Buffer {
        const ipParts = ip.split('.').map(p => parseInt(p, 10));
        const header = Buffer.concat([
            this.HEADER,
            Buffer.from(ipParts),
            Buffer.alloc(2)
        ]);
        header.writeUInt16LE(port, 6);
        header.write(type, 8);

        if (payload) {
            return Buffer.concat([header, payload]);
        }
        return header;
    }

    static buildRconPacket(ip: string, port: number, password: string, command: string): Buffer {
        const passBuf = iconv.encode(password, 'windows-874');
        const cmdBuf = iconv.encode(command, 'windows-874');

        const payload = Buffer.alloc(2 + passBuf.length + 2 + cmdBuf.length);
        let offset = 0;

        payload.writeUInt16LE(passBuf.length, offset);
        offset += 2;
        passBuf.copy(payload, offset);
        offset += passBuf.length;

        payload.writeUInt16LE(cmdBuf.length, offset);
        offset += 2;
        cmdBuf.copy(payload, offset);

        return this.buildPacket(ip, port, 'x', payload);
    }

    static parseResponse(buffer: Buffer, type: PacketType): any {
        // Basic check
        if (buffer.length < 11) return null;
        const responseType = String.fromCharCode(buffer[10]);
        const payload = buffer.subarray(11);

        if (type === 'x') {
            return iconv.decode(payload, 'windows-874').trim();
        }

        if (type === 'c') {
            // Player list (Basic)
            if (payload.length < 2) return [];
            let offset = 0;
            const count = payload.readUInt16LE(offset); offset += 2;
            const players = [];
            for (let i = 0; i < count; i++) {
                if (payload.length < offset + 1) break;
                const nameLen = payload[offset++];
                if (payload.length < offset + nameLen + 4) break;
                const name = iconv.decode(payload.subarray(offset, offset + nameLen), 'windows-874'); offset += nameLen;
                const score = payload.readInt32LE(offset); offset += 4;
                players.push({ name, score });
            }
            return players;
        }

        if (type === 'd') {
            // Detailed player list
            if (payload.length < 2) return [];
            let offset = 0;
            const count = payload.readUInt16LE(offset); offset += 2;
            const players = [];
            for (let i = 0; i < count; i++) {
                if (payload.length < offset + 2) break;
                const id = payload[offset++];
                const nameLen = payload[offset++];
                if (payload.length < offset + nameLen + 8) break;
                const name = iconv.decode(payload.subarray(offset, offset + nameLen), 'windows-874'); offset += nameLen;
                const score = payload.readInt32LE(offset); offset += 4;
                const ping = payload.readInt32LE(offset); offset += 4;
                players.push({ id, name, score, ping });
            }
            return players;
        }

        if (type === 'r') {
            // Rules list
            if (payload.length < 2) return {};
            let offset = 0;
            const count = payload.readUInt16LE(offset); offset += 2;
            const rules: any = {};
            for (let i = 0; i < count; i++) {
                if (payload.length < offset + 1) break;
                const keyLen = payload[offset++];
                if (payload.length < offset + keyLen) break;
                const key = iconv.decode(payload.subarray(offset, offset + keyLen), 'windows-874'); offset += keyLen;
                
                if (payload.length < offset + 1) break;
                const valueLen = payload[offset++];
                if (payload.length < offset + valueLen) break;
                const value = iconv.decode(payload.subarray(offset, offset + valueLen), 'windows-874'); offset += valueLen;
                
                rules[key] = value;
            }
            return rules;
        }

        if (type === 'i') {
            // Information response
            if (payload.length < 11) return null;
            let offset = 0;
            const password = payload[offset++];
            const players = payload.readUInt16LE(offset); offset += 2;
            const maxPlayers = payload.readUInt16LE(offset); offset += 2;
            
            const hostnameLen = payload.readUInt32LE(offset); offset += 4;
            if (payload.length < offset + hostnameLen) return null;
            const hostname = iconv.decode(payload.subarray(offset, offset + hostnameLen), 'windows-874'); offset += hostnameLen;

            if (payload.length < offset + 4) return null;
            const gamemodeLen = payload.readUInt32LE(offset); offset += 4;
            if (payload.length < offset + gamemodeLen) return null;
            const gamemode = iconv.decode(payload.subarray(offset, offset + gamemodeLen), 'windows-874'); offset += gamemodeLen;

            if (payload.length < offset + 4) return null;
            const mapnameLen = payload.readUInt32LE(offset); offset += 4;
            if (payload.length < offset + mapnameLen) return null;
            const mapname = iconv.decode(payload.subarray(offset, offset + mapnameLen), 'windows-874');

            return { password: !!password, players, maxPlayers, hostname, gamemode, mapname };
        }


        return payload;
    }
}
