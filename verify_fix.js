import { SampClient } from './dist/client.js';

async function test() {
    const host = '168.222.20.193';
    const port = 7777;
    const client = new SampClient(host, port);

    console.log(`Querying ${host}:${port} using SampClient...`);
    try {
        const info = await client.getInfo();
        console.log('Success:', JSON.stringify(info, null, 2));
    } catch (e) {
        console.error('Failed:', e.message);
    } finally {
        client.close();
    }
}

test();
